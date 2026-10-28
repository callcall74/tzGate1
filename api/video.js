// Vercel 서버리스 함수: POST /api/video  { password, rtsp } 또는 { password, lot }  ->  JPEG 사진이 이어진 스트림
'use strict';
const { handleVideo } = require('../lib/video');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Allow', 'POST');
    res.end();
    return;
  }
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  await handleVideo(body, req, res);
};
