// 카메라 영상(RTSP)을 1초에 2장씩 JPEG 로 바꿔 20초 동안 이어서 보내는 모듈
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

const VIEW_SECONDS = 20;
const FPS = 2;
const HARD_LIMIT_MS = (VIEW_SECONDS + 10) * 1000; // 접속이 늦어도 이 시간이 지나면 끝냄
const WRONG_PASSWORD_DELAY_MS = 1000;

function hostOf(url) {
  try { return new URL(url).host; } catch { return '?'; }
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

// { password, rtsp } 를 받아 res 로 JPEG 들을 흘려보냄
async function handleVideo(input, req, res) {
  input = input || {};
  if (!checkPassword(input.password)) {
    await new Promise((r) => setTimeout(r, WRONG_PASSWORD_DELAY_MS));
    return json(res, 401, { ok: false, error: '비밀번호가 틀렸습니다' });
  }
  const url = input.rtsp;
  if (typeof url !== 'string' || !/^rtsp:\/\/\S{1,300}$/i.test(url)) {
    return json(res, 400, { ok: false, error: '잘못된 영상 주소' });
  }

  console.log('video start', hostOf(url));
  const ff = spawn(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error',
    '-rtsp_transport', 'tcp',
    '-timeout', '5000000',            // 카메라 응답 대기 5초 (마이크로초)
    '-i', url,
    '-t', String(VIEW_SECONDS),
    '-an',
    '-vf', `fps=${FPS},scale=640:-2`,
    '-q:v', '7',
    '-f', 'image2pipe', '-vcodec', 'mjpeg',
    'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let started = false;
  let errText = '';
  const stop = () => { if (ff.exitCode === null) ff.kill('SIGKILL'); };
  const limit = setTimeout(stop, HARD_LIMIT_MS);
  res.on('close', stop); // 화면을 닫거나 다른 주차장으로 바꾸면 중단

  ff.stderr.on('data', (d) => { errText = (errText + d).slice(-500); });
  ff.stdout.on('data', (chunk) => {
    if (!started) {
      started = true;
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Accel-Buffering', 'no');
    }
    res.write(chunk);
  });

  await new Promise((resolve) => {
    ff.on('error', (e) => { errText = e.message; resolve(); });
    ff.on('close', resolve);
  });
  clearTimeout(limit);

  if (started) {
    console.log('video end', hostOf(url));
    res.end();
  } else {
    console.log('video fail', hostOf(url), errText.replace(/rtsp:\/\/\S+/gi, 'rtsp://...').trim());
    const error = /401|Unauthorized/i.test(errText) ? '카메라 아이디/비밀번호 확인'
      : /timed out|Connection refused|resolve|No route/i.test(errText) ? '카메라에 접속할 수 없음'
      : '영상을 가져오지 못함';
    if (!res.headersSent) json(res, 502, { ok: false, error });
  }
}

module.exports = { handleVideo };
