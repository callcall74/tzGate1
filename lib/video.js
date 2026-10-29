// 카메라 영상(RTSP)을 1초에 2장씩 JPEG 로 바꿔 20초 동안 이어서 보내는 모듈 (끊기면 다시 접속)
// (Vercel 함수 api/video.js 와 로컬 server.js 가 같이 사용)
//
// 브라우저 --(HTTP POST /api/video)--> 이 모듈 --(ffmpeg, RTSP)--> 카메라
// 응답 본문은 JPEG 사진이 차례로 이어 붙은 것 (화면에서 사진 단위로 잘라 표시)
//
// - 차단기 명령과 같은 비밀번호가 맞아야 합니다.
// - RTSP 주소에는 카메라 비밀번호가 들어 있으므로 로그에는 주소 전체를 남기지 않습니다.

'use strict';
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const { checkPassword } = require('./gate');
const { getLots, findLot } = require('./lots');

const VIEW_SECONDS = 20;
const FPS = 2;
const HARD_LIMIT_MS = 35 * 1000;  // 접속이 늦거나 재접속이 길어져도 이 시간이 지나면 끝냄 (vercel.json maxDuration 40초 안)
const MAX_RECONNECTS = 3;         // 카메라가 중간에 끊으면 남은 시간 동안 다시 접속하는 횟수
const WRONG_PASSWORD_DELAY_MS = 1000;
const EOI = Buffer.from([0xff, 0xd9]); // JPEG 끝 표시

function hostOf(url) {
  try { return new URL(url).host; } catch { return '?'; }
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

// ffmpeg 를 한 번 실행해서 끝날 때까지 기다림. 실행 중인 프로세스는 onSpawn 으로 알려줌
function runFfmpeg(url, onData, onSpawn) {
  const ff = spawn(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error',
    '-rtsp_transport', 'tcp',
    '-timeout', '5000000',            // 카메라 응답 대기 5초 (마이크로초)
    '-i', url,
    '-an',
    '-vf', `fps=${FPS},scale=640:-2`,
    '-q:v', '7',
    '-f', 'image2pipe', '-vcodec', 'mjpeg',
    'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  onSpawn(ff);
  let errText = '';
  ff.stderr.on('data', (d) => { errText = (errText + d).slice(-500); });
  ff.stdout.on('data', onData);
  return new Promise((resolve) => {
    ff.on('error', (e) => resolve(e.message));
    ff.on('close', () => resolve(errText));
  });
}

// { password, rtsp } 를 받아 res 로 JPEG 들을 흘려보냄
// 서버 관리 방식(GATE_LOTS)이면 { password, lot } 이고 RTSP 주소는 서버 설정에서 찾음
//
// 보여주는 시간은 첫 장이 나온 때부터 실제 시계로 VIEW_SECONDS 초 (화면의 남은 시간 표시와 같은 기준).
// 카메라가 그 전에 접속을 끊으면 남은 시간 동안 다시 접속해서 이어 보냄.
async function handleVideo(input, req, res) {
  input = input || {};
  if (!checkPassword(input.password)) {
    await new Promise((r) => setTimeout(r, WRONG_PASSWORD_DELAY_MS));
    return json(res, 401, { ok: false, error: '비밀번호가 틀렸습니다' });
  }
  const lots = await getLots();
  const url = lots ? (findLot(lots, input.lot) || {}).rtsp : input.rtsp;
  if (typeof url !== 'string' || !/^rtsp:\/\/\S{1,300}$/i.test(url)) {
    return json(res, 400, { ok: false, error: '잘못된 영상 주소' });
  }

  const host = hostOf(url);
  console.log('video start', host);
  const t0 = Date.now();
  let started = 0;     // 첫 장이 나온 시각
  let frames = 0;
  let carry = 0;       // 앞 조각 끝이 0xFF 였는지 (JPEG 끝 표시가 두 조각에 걸친 경우)
  let finished = '';   // 끝난 이유: 'done' | 'closed' | 'limit'
  let ff = null;
  const timers = [];

  // 먼저 정상 종료(카메라에 접속 종료를 알림)를 시도하고, 안 끝나면 강제 종료
  // (강제 종료하면 카메라가 접속을 한동안 붙잡고 있어 다음 접속이 거부될 수 있음)
  const stop = () => {
    const p = ff;
    if (!p || p.exitCode !== null) return;
    p.kill('SIGTERM');
    setTimeout(() => { if (p.exitCode === null) p.kill('SIGKILL'); }, 2000).unref();
  };
  const finish = (why) => { if (!finished) finished = why; stop(); };
  timers.push(setTimeout(() => finish('limit'), HARD_LIMIT_MS));
  res.on('close', () => finish('closed')); // 화면을 닫거나 다른 주차장으로 바꾸면 중단

  const onData = (chunk) => {
    if (finished) return;
    if (!started) {
      started = Date.now();
      timers.push(setTimeout(() => finish('done'), VIEW_SECONDS * 1000));
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Accel-Buffering', 'no');
    }
    if (carry && chunk[0] === 0xd9) frames++;
    for (let i = chunk.indexOf(EOI); i >= 0; i = chunk.indexOf(EOI, i + 2)) frames++;
    carry = chunk[chunk.length - 1] === 0xff;
    res.write(chunk);
  };

  let errText = '';
  let reconnects = 0;
  for (;;) {
    errText = await runFfmpeg(url, onData, (p) => { ff = p; });
    if (finished || !started) break;          // 시간이 다 됐거나, 처음부터 접속 실패
    if (reconnects >= MAX_RECONNECTS) break;
    reconnects++;
    console.log('video reconnect', host, `${((Date.now() - started) / 1000).toFixed(1)}초에 끊김`,
      errText.replace(/rtsp:\/\/\S+/gi, 'rtsp://...').trim().slice(-200));
  }
  timers.forEach(clearTimeout);

  if (started) {
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    console.log('video end', host, `${finished || 'camera'} ${secs}초 ${frames}장 접속${((started - t0) / 1000).toFixed(1)}초`
      + (reconnects ? ` 재접속${reconnects}` : ''));
    res.end();
  } else {
    console.log('video fail', host, errText.replace(/rtsp:\/\/\S+/gi, 'rtsp://...').trim());
    const error = /453|Not Enough Bandwidth/i.test(errText) ? '카메라 동시 접속 수 초과 (잠시 후 다시)'
      : /401|Unauthorized/i.test(errText) ? '카메라 아이디/비밀번호 확인'
      : /timed out|Connection refused|resolve|No route/i.test(errText) ? '카메라에 접속할 수 없음'
      : '영상을 가져오지 못함';
    if (!res.headersSent) json(res, 502, { ok: false, error });
  }
}

module.exports = { handleVideo };
