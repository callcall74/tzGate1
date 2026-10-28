// 차단기 명령 처리 공통 모듈 (Vercel 함수 api/send.js 와 로컬 server.js 가 같이 사용)
//
// 브라우저 --(HTTP POST /api/send)--> 이 모듈 --(UDP)--> 등록된 주차장 IP:Port (차단기 보드)
//
// - 비밀번호(환경변수 GATE_PASSWORD)가 맞아야 명령을 보냅니다. 설정되어 있지 않으면 모든 명령을 거부합니다.
// - 명령마다 UDP 패킷 1개를 보내고, 보드의 응답을 잠시 기다립니다(응답이 없어도 전송은 된 것으로 봄).

'use strict';
const dgram = require('dgram');
const dns = require('dns').promises;
const crypto = require('crypto');
const { getLots, findLot } = require('./lots');

const REPLY_TIMEOUT_MS = parseInt(process.env.REPLY_TIMEOUT_MS || '1500', 10);
const WRONG_PASSWORD_DELAY_MS = 1000;

// <UDP 프로토콜>  0x02 + 명령 + 0x03
const COMMANDS = {
  open:   '0AoA0105', // 1번 릴레이
  close:  '0AoA0205', // 2번 릴레이
  lock:   '0AoB0401', // 4번 릴레이 고정
  unlock: '0AoB0400', // 4번 릴레이 고정 해제
  reset:  '0Wr',      // 보드 리셋
};
const STX = '\x02', ETX = '\x03';

// 이어서 보낼 명령과 간격 (열림: 1번 릴레이 뒤에 4번 릴레이 열림도 보냄)
const FOLLOW_UP = {
  open: '0AoA0405', // 4번 릴레이 열림
};
const FOLLOW_UP_DELAY_MS = 300;

function checkPassword(given) {
  const expected = process.env.GATE_PASSWORD;
  if (!expected || typeof given !== 'string') return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

// 입력 검사. 문제가 있으면 오류 메시지, 없으면 null
function validate({ cmd, ip, port }) {
  if (!Object.prototype.hasOwnProperty.call(COMMANDS, cmd)) return '잘못된 명령';
  if (typeof ip !== 'string' || !/^[A-Za-z0-9.\-]{1,100}$/.test(ip)) return '잘못된 IP';
  const p = Number(port);
  if (!/^\d{1,5}$/.test(String(port)) || p < 1 || p > 65535) return '잘못된 Port';
  return null;
}

function buildPacket(body) {
  return Buffer.from(STX + body + ETX, 'latin1');
}

// UDP 로 전송하고, 제한 시간 안에 온 응답을 돌려줌(없으면 null)
// followUp 패킷이 있으면 FOLLOW_UP_DELAY_MS 뒤에 이어서 보냄
async function sendUdp(packet, host, port, followUp) {
  const { address, family } = await dns.lookup(host);
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket(family === 6 ? 'udp6' : 'udp4');
    let finished = false;
    let reply = null;
    let followTimer = null;
    const finish = (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(followTimer);
      sock.close();
      if (err) reject(err); else resolve(reply);
    };
    const send = (buf, cb) => sock.send(buf, Number(port), address, (err) => (err ? finish(err) : cb && cb()));
    // 이어지는 전송까지 끝난 뒤에도 응답을 기다리도록 제한 시간을 늘림
    const timer = setTimeout(() => finish(null), REPLY_TIMEOUT_MS + (followUp ? FOLLOW_UP_DELAY_MS : 0));
    sock.on('message', (msg) => {
      if (!reply) reply = msg;
      if (!followUp || followTimer === 'done') finish(null); // 이어지는 전송 전에는 닫지 않음
    });
    sock.on('error', (e) => finish(e));
    send(packet, () => {
      if (!followUp) return;
      followTimer = setTimeout(() => send(followUp, () => {
        followTimer = 'done';
        if (reply) finish(null);
      }), FOLLOW_UP_DELAY_MS);
    });
  });
}

const show = (buf) => buf.toString('latin1').replace(/\x02/g, '<STX>').replace(/\x03/g, '<ETX>');

// { password, cmd, ip, port } -> { status, body }
// 서버 관리 방식(GATE_LOTS)이면 { password, cmd, lot } 이고 IP/Port 는 서버 설정에서 찾음
async function handleCommand(input) {
  input = input || {};
  if (!checkPassword(input.password)) {
    await new Promise((r) => setTimeout(r, WRONG_PASSWORD_DELAY_MS));
    return { status: 401, body: { ok: false, error: '비밀번호가 틀렸습니다' } };
  }

  let req = { cmd: input.cmd, ip: input.ip, port: input.port };
  if (getLots()) {
    const lot = findLot(input.lot);
    if (!lot) return { status: 400, body: { ok: false, error: '없는 주차장' } };
    req = { cmd: input.cmd, ip: lot.ip, port: lot.port };
  }
  const bad = validate(req);
  if (bad) return { status: 400, body: { ok: false, error: bad } };

  const packet = buildPacket(COMMANDS[req.cmd]);
  const followUp = FOLLOW_UP[req.cmd] ? buildPacket(FOLLOW_UP[req.cmd]) : null;
  console.log('send', `${req.ip}:${req.port}`, show(packet),
    followUp ? `+ ${FOLLOW_UP_DELAY_MS}ms ${show(followUp)}` : '');
  try {
    const reply = await sendUdp(packet, req.ip, req.port, followUp);
    const text = reply ? reply.toString('latin1').replace(/[\x00-\x1f]+/g, ' ').trim() : '';
    console.log('reply', reply ? (text || '(빈 응답)') : '(없음)');
    return { status: 200, body: { ok: true, replied: !!reply, reply: text } };
  } catch (e) {
    console.log('udp error', e.code || e.message);
    const error = e.code === 'ENOTFOUND' ? '주차장 주소를 찾을 수 없음' : '전송 실패';
    return { status: 502, body: { ok: false, error } };
  }
}

module.exports = { handleCommand, checkPassword };
