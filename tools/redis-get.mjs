#!/usr/bin/env node
/**
 * 极简 Redis GET 客户端（零依赖，仅供本机自检用）。
 *
 * 用法：node tools/redis-get.mjs wca:captcha:<id>
 * 输出值本体；GET 不到时输出空串并以退出码 1 结束。
 *
 * 为什么要它：验证码的答案在 Redis 里（wca:captcha:{id}），
 * 自检脚本在「生产形态」的部署（MAIL_MODE=smtp，不回显答案）上
 * 也能靠本机 Redis 把链路走通 —— 而不是给生产开洞。
 */
import net from 'node:net';

const key = process.argv[2];
if (!key) {
  console.error('usage: node tools/redis-get.mjs <key>');
  process.exit(2);
}

const socket = net.connect(6379, '127.0.0.1');
socket.setTimeout(3000);

let buffer = Buffer.alloc(0);
socket.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  // RESP bulk string: $<len>\r\n<data>\r\n
  const text = buffer.toString('utf8');
  if (!text.startsWith('$')) {
    console.error('unexpected reply: ' + text.split('\r\n')[0]);
    process.exit(1);
  }
  const len = Number(text.slice(1, text.indexOf('\r\n')));
  if (len === -1) {
    console.log('');
    process.exit(1);
  }
  const start = text.indexOf('\r\n') + 2;
  console.log(text.slice(start, start + len));
  socket.end();
  process.exit(0);
});
socket.on('connect', () => {
  socket.write(`*2\r\n$3\r\nGET\r\n$${Buffer.byteLength(key)}\r\n${key}\r\n`);
});
socket.on('timeout', () => {
  console.error('redis timeout');
  process.exit(1);
});
socket.on('error', (err) => {
  console.error('redis error: ' + err.message);
  process.exit(1);
});
