// 사이트별 주차장 목록 (환경변수 GATE_LOTS)
//
// GATE_LOTS 가 있으면 "서버 관리" 방식: 주차장 IP/Port/RTSP 는 서버에만 있고,
// 화면에는 이름만 내려가며 브라우저는 몇 번째 주차장인지(lot)만 보냅니다.
// 없으면 지금처럼 화면 설정에서 입력한 IP/Port/RTSP 를 그대로 사용합니다.
//
// 예) GATE_LOTS=[{"name":"무원마을입1","ip":"km4593.iptime.org","port":1102,"rtsp":"rtsp://아이디:비번@abc.iptime.org:554/chID=7"}]
//     rtsp 는 선택. http(s):// 주소를 넣으면 화면에서 그대로 띄웁니다(이 주소는 화면에 보임).

'use strict';

const MAX_LOTS = 8;

function parse(raw) {
  const list = JSON.parse(raw);
  if (!Array.isArray(list) || list.length === 0) throw new Error('배열이 아니거나 비어 있음');
  if (list.length > MAX_LOTS) throw new Error(`최대 ${MAX_LOTS}개`);
  return list.map((l, i) => {
    const where = `${i + 1}번째 주차장`;
    if (!l || typeof l !== 'object') throw new Error(`${where}: 형식 오류`);
    const name = String(l.name || '').trim();
    const ip = String(l.ip || '').trim();
    const port = String(l.port || '').trim();
    const rtsp = String(l.rtsp || '').trim();
    if (!name || name.length > 30 || /[\x00-\x1f]/.test(name)) throw new Error(`${where}: 이름 오류`);
    if (!/^[A-Za-z0-9.\-]{1,100}$/.test(ip)) throw new Error(`${name}: IP 오류`);
    if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error(`${name}: Port 오류`);
    if (rtsp && !/^(rtsp|https?):\/\/\S{1,300}$/i.test(rtsp)) throw new Error(`${name}: 영상 주소 오류`);
    return { name, ip, port, rtsp };
  });
}

let cached;

// 서버 관리 방식이 아니면 null.
// GATE_LOTS 가 잘못되어 있으면 빈 목록(모든 명령 거부) - 화면 입력 방식으로 넘어가지 않도록
function getLots() {
  if (cached !== undefined) return cached;
  const raw = process.env.GATE_LOTS;
  if (!raw || !raw.trim()) return (cached = null);
  try {
    cached = parse(raw);
  } catch (e) {
    console.log('GATE_LOTS 설정 오류:', e.message);
    cached = [];
  }
  return cached;
}

// 서버 관리 방식에서 브라우저가 보낸 번호로 주차장 찾기 (없으면 null)
function findLot(index) {
  const lots = getLots() || [];
  const i = Number(index);
  return Number.isInteger(i) && i >= 0 && i < lots.length ? lots[i] : null;
}

// 화면에 내려줄 설정: IP/Port/RTSP 는 빼고 이름과 영상 종류만
function publicConfig() {
  const lots = getLots();
  if (!lots) return { managed: false };
  return {
    managed: true,
    lots: lots.map((l) => ({
      name: l.name,
      video: /^rtsp:/i.test(l.rtsp) ? 'rtsp' : l.rtsp, // rtsp 주소는 숨김, http(s) 는 그대로
    })),
  };
}

module.exports = { getLots, findLot, publicConfig };
