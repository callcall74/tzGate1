// 기존 UDP 프로그램이 실제로 보내는 명령을 확인하는 도구
//
// 1) 이 PC에서 실행:  node tools/udp_capture.js 1106
// 2) 기존 UDP 프로그램의 대상 주소를 이 PC의 IP(같은 네트워크면 내부 IP), 포트 1106 으로 바꾸고 버튼을 누름
// 3) 받은 바이트가 화면에 표시됨 (열림/닫힘을 하나씩 눌러 비교)
//
// 보드처럼 응답하지는 않으므로 차단기는 움직이지 않습니다.

'use strict';
const dgram = require('dgram');
const os = require('os');

const port = parseInt(process.argv[2] || '1106', 10);
const sock = dgram.createSocket('udp4');

const show = (buf) => Array.from(buf).map((b) =>
  b === 0x02 ? '<STX>' : b === 0x03 ? '<ETX>' : b < 0x20 || b > 0x7e ? `<0x${b.toString(16).padStart(2, '0')}>` : String.fromCharCode(b)
).join('');

sock.on('message', (msg, r) => {
  const t = new Date().toTimeString().slice(0, 8);
  console.log(`${t}  from ${r.address}:${r.port}  ${msg.length}바이트`);
  console.log(`          글자: ${show(msg)}`);
  console.log(`          hex : ${msg.toString('hex').replace(/(..)/g, '$1 ').trim()}`);
});

sock.bind(port, () => {
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  console.log(`UDP ${port} 수신 대기 중. 이 PC의 IP: ${ips.join(', ')}`);
  console.log('기존 프로그램에서 위 IP와 포트로 명령을 보내 보세요. 종료: Ctrl + C');
});
