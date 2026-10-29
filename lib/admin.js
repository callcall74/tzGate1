// 관리자: 주차장 목록 보기/저장 (Vercel 함수 api/admin.js 와 로컬 server.js 가 같이 사용)
//
// - 관리자 비밀번호(환경변수 GATE_ADMIN_PASSWORD)가 맞아야 합니다. 차단기 비밀번호와 따로입니다.
// - 저장한 목록은 저장소(lib/lots.js)에 들어가 GATE_LOTS 보다 먼저 쓰이며, 바로 반영됩니다.
// - 응답에 카메라 비밀번호가 들어 있으므로 로그에는 개수만 남깁니다.

'use strict';
const { safeEqual } = require('./gate');
const { getLots, saveLots, adminEnabled } = require('./lots');

const WRONG_PASSWORD_DELAY_MS = 1000;

// { adminPassword, action: 'get' }          -> { ok, lots }
// { adminPassword, action: 'save', lots }   -> { ok, lots }
async function handleAdmin(input) {
  input = input || {};
  if (!adminEnabled()) return { status: 403, body: { ok: false, error: '관리자 기능이 꺼져 있습니다' } };
  if (!safeEqual(input.adminPassword, process.env.GATE_ADMIN_PASSWORD)) {
    await new Promise((r) => setTimeout(r, WRONG_PASSWORD_DELAY_MS));
    return { status: 401, body: { ok: false, error: '관리자 비밀번호가 틀렸습니다' } };
  }

  if (input.action === 'get') {
    return { status: 200, body: { ok: true, lots: (await getLots()) || [] } };
  }
  if (input.action === 'save') {
    try {
      const lots = await saveLots(input.lots);
      console.log('admin save', `${lots.length}개`);
      return { status: 200, body: { ok: true, lots } };
    } catch (e) {
      console.log('admin save fail', e.message);
      return { status: 400, body: { ok: false, error: e.message } };
    }
  }
  return { status: 400, body: { ok: false, error: '잘못된 요청' } };
}

module.exports = { handleAdmin };
