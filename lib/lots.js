// 사이트별 주차장 목록
//
// "서버 관리" 방식: 주차장 IP/Port/RTSP 는 서버에만 있고, 화면에는 이름만 내려가며
// 브라우저는 몇 번째 주차장인지(lot)만 보냅니다. 목록은 아래 순서로 찾습니다.
//   1) 관리자 화면에서 저장한 목록 (Vercel: Upstash Redis, 로컬: lots.local.json)
//   2) 환경변수 GATE_LOTS (처음 값)
// 둘 다 없으면 지금처럼 화면 설정에서 입력한 IP/Port/RTSP 를 그대로 사용합니다.
//
// 예) GATE_LOTS=[{"name":"무원마을입1","ip":"km4593.iptime.org","port":1102,"rtsp":"rtsp://아이디:비번@abc.iptime.org:554/chID=7"}]
//     rtsp 는 선택. http(s):// 주소를 넣으면 화면에서 그대로 띄웁니다(이 주소는 화면에 보임).
//
// 저장소: Vercel 에서 Upstash Redis 를 연결하면 KV_REST_API_URL / KV_REST_API_TOKEN 이 자동으로 생깁니다.
//         여러 사이트가 같은 Redis 를 써도 프로젝트마다 다른 키(GATE_SITE 또는 프로젝트 ID)에 저장됩니다.

'use strict';
const fs = require('fs');
const path = require('path');

const MAX_LOTS = 8;
const LOCAL_FILE = path.join(__dirname, '..', 'lots.local.json');
const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const KEY = 'gate:lots:' + (process.env.GATE_SITE || process.env.VERCEL_PROJECT_ID || 'local');

// 목록 검사 후 정리한 목록을 돌려줌 (문제가 있으면 오류)
function parseList(list, allowEmpty) {
  if (!Array.isArray(list)) throw new Error('배열이 아님');
  if (list.length === 0 && !allowEmpty) throw new Error('비어 있음');
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

// ---------- 저장소 ----------
// 'redis' | 'file'(로컬 실행) | null(Vercel 인데 Redis 미연결 - 관리자 저장 불가)
function storeKind() {
  if (REDIS_URL && REDIS_TOKEN) return 'redis';
  if (!process.env.VERCEL) return 'file';
  return null;
}

async function redis(...command) {
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error || 'redis ' + res.status);
  return data.result;
}

async function readStored() {
  const kind = storeKind();
  if (kind === 'redis') return redis('GET', KEY);
  if (kind === 'file') {
    try { return fs.readFileSync(LOCAL_FILE, 'utf8'); } catch { return null; }
  }
  return null;
}

async function saveLots(list) {
  const lots = parseList(list, true);
  const raw = JSON.stringify(lots);
  const kind = storeKind();
  if (kind === 'redis') await redis('SET', KEY, raw);
  else if (kind === 'file') fs.writeFileSync(LOCAL_FILE, raw);
  else throw new Error('저장소가 연결되어 있지 않음');
  return lots;
}

// ---------- 목록 ----------
function envLots() {
  const raw = process.env.GATE_LOTS;
  if (!raw || !raw.trim()) return null;
  try {
    return parseList(JSON.parse(raw), false);
  } catch (e) {
    console.log('GATE_LOTS 설정 오류:', e.message);
    return []; // 잘못되어 있으면 모든 명령 거부 - 화면 입력 방식으로 넘어가지 않도록
  }
}

// 서버 관리 방식이 아니면 null
async function getLots() {
  let raw = null;
  try {
    raw = await readStored();
  } catch (e) {
    // 저장소가 잠시 안 되더라도 차단기는 열려야 하므로 GATE_LOTS 로 계속 동작
    console.log('저장소 읽기 오류:', e.message);
  }
  if (raw != null) {
    try { return parseList(JSON.parse(raw), true); } catch (e) { console.log('저장된 목록 오류:', e.message); }
  }
  return envLots();
}

// 브라우저가 보낸 번호로 주차장 찾기 (없으면 null)
function findLot(lots, index) {
  const i = Number(index);
  return Number.isInteger(i) && i >= 0 && i < lots.length ? lots[i] : null;
}

function adminEnabled() {
  return !!process.env.GATE_ADMIN_PASSWORD && !!storeKind();
}

// 화면에 내려줄 설정: IP/Port/RTSP 는 빼고 이름과 영상 종류만
async function publicConfig() {
  const lots = await getLots();
  const admin = adminEnabled();
  if (!lots) return { managed: false, admin };
  return {
    managed: true,
    admin,
    lots: lots.map((l) => ({
      name: l.name,
      video: /^rtsp:/i.test(l.rtsp) ? 'rtsp' : l.rtsp, // rtsp 주소는 숨김, http(s) 는 그대로
    })),
  };
}

module.exports = { getLots, findLot, saveLots, adminEnabled, publicConfig };
