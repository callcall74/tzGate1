// 차단기 명령 처리 공통 모듈 (Vercel 함수 api/send.js 와 로컬 server.js 가 같이 사용)
//
// 브라우저 --(HTTP POST /api/send)--> 이 모듈 --(TCP)--> toozsystem.iptime.org:9800
// 명령 1개마다 TCP 연결을 새로 열고, 응답(ETX)을 받거나 시간이 지나면 닫습니다.

'use strict';
const net = require('net');

const TARGET_HOST = process.env.TARGET_HOST || 'toozsystem.iptime.org';
const TARGET_PORT = parseInt(process.env.TARGET_PORT || '9800', 10);
const REPLY_TIMEOUT_MS = parseInt(process.env.REPLY_TIMEOUT_MS || '3000', 10);

const ALLOWED_CMDS = new Set(['open', 'close', 'lock', 'unlock', 'reset']);
const STX = '\x02', FS = '\x1c', ETX = '\x03';

// 입력 검사. 문제가 있으면 오류 메시지, 없으면 null
function validate({ cmd, ip, port }) {
  if (!ALLOWED_CMDS.has(cmd)) return '잘못된 명령';
  if (typeof ip !== 'string' || !/^[A-Za-z0-9.\-]{1,100}$/.test(ip)) return '잘못된 IP';
  const p = Number(port);
  if (!/^\d{1,5}$/.test(String(port)) || p < 1 || p > 65535) return '잘못된 Port';
  return null;
}

// STX cmd FS ip FS port FS ETX
function buildPacket({ cmd, ip, port }) {
  return Buffer.from(STX + cmd + FS + ip + FS + String(port) + FS + ETX, 'latin1');
}

// TCP 로 전송하고 응답을 돌려줌. 응답 없이 시간이 지나면 전송은 된 것으로 봄
function forward(packet) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let finished = false;
    const sock = net.createConnection({ host: TARGET_HOST, port: TARGET_PORT });
    const finish = (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      sock.destroy();
      if (err) reject(err); else resolve(Buffer.concat(chunks));
    };
    const timer = setTimeout(
      () => finish(sock.connecting ? new Error('connect timeout') : null), REPLY_TIMEOUT_MS);
    sock.on('connect', () => sock.write(packet));
    sock.on('data', (d) => {
      chunks.push(d);
      if (d.includes(0x03)) finish(null); // ETX 를 받으면 응답 끝
    });
    sock.on('end', () => finish(null));
    sock.on('error', (e) => finish(e));
  });
}

const show = (buf) => buf.toString('utf8')
  .replace(/\x02/g, '<STX>').replace(/\x1c/g, '<FS>').replace(/\x03/g, '<ETX>');

// { cmd, ip, port } -> { status, body }
async function handleCommand(input) {
  const req = { cmd: input && input.cmd, ip: input && input.ip, port: input && input.port };
  const bad = validate(req);
  if (bad) return { status: 400, body: { ok: false, error: bad } };

  const packet = buildPacket(req);
  console.log('send', show(packet));
  try {
    const reply = await forward(packet);
    const text = reply.toString('utf8').replace(/[\x00-\x1f]+/g, ' ').trim();
    console.log('reply', text || '(없음)');
    return { status: 200, body: { ok: true, reply: text } };
  } catch (e) {
    console.log('tcp error', e.message);
    return { status: 502, body: { ok: false, error: '서버 연결 실패' } };
  }
}

module.exports = { handleCommand };
