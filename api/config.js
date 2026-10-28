// Vercel 서버리스 함수: GET /api/config  ->  { managed, lots: [{ name, video }] }
'use strict';
const { publicConfig } = require('../lib/lots');

module.exports = (req, res) => {
  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET');
    res.end();
    return;
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(publicConfig()));
};
