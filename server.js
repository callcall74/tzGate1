// 로컬 실행용 서버 (Vercel 과 같은 구조: index.html + POST /api/send, /api/video, GET /api/config, POST /api/admin)
//
// 실행:  node server.js     ->  http://localhost:8080/
// 환경변수: PORT(기본 8080), GATE_PASSWORD(접속 비밀번호, 필수), GATE_LOTS(주차장 목록, lib/lots.js 참고), GATE_ADMIN_PASSWORD(관리자 비밀번호), REPLY_TIMEOUT_MS

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const API = {
  '/api/send': require('./api/send'),
  '/api/video': require('./api/video'),
  '/api/config': require('./api/config'),
  '/api/admin': require('./api/admin'),
};

const PORT = parseInt(process.env.PORT || '8080', 10);
const INDEX_FILE = path.join(__dirname, 'index.html');

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  if (API[url]) {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 16384) req.destroy(); });
    req.on('end', () => { req.body = raw; API[url](req, res); });
    return;
  }

  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    fs.readFile(INDEX_FILE, (err, data) => {
      if (err) { res.writeHead(500); res.end('index.html not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
    return;
  }

  res.writeHead(404); res.end('Not Found');
});

server.listen(PORT, () => console.log(`http://localhost:${PORT}/`));
