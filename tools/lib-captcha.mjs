/**
 * 图形验证码解题助手（仅供自检脚本使用）。
 *
 * dev 部署（MAIL_MODE=dev）下后端会把答案随 /api/auth/captcha 明文回显
 * （devAnswer 字段，与 devVerifyToken 同一条设计），脚本无需 OCR。
 * 生产（MAIL_MODE=smtp）下 devAnswer 恒为 null —— 这个助手就会抛错，
 * 刻意失败：自检脚本本来就不该对生产环境跑。
 */
import net from 'node:net';

export const BASE = (process.env.BASE_URL ?? 'http://127.0.0.1:8080').replace(/\/$/, '');

/** 取一张已解好的验证码，返回各脚本 register 请求体里要合并的两个字段。 */
export async function solveCaptcha(base = BASE) {
  const response = await fetch(`${base}/api/auth/captcha`);
  if (!response.ok) {
    throw new Error(`取验证码失败: HTTP ${response.status}`);
  }
  const challenge = await response.json();
  if (!challenge.id) {
    // 后端关闭了验证码（AUTH_CAPTCHA_ENABLED=false）：两个留空即可
    return { captchaId: undefined, captchaCode: undefined };
  }
  if (!challenge.devAnswer) {
    throw new Error('后端未回显验证码答案（生产模式？）。自检脚本只能在 MAIL_MODE=dev 的部署上运行。');
  }
  return { captchaId: challenge.id, captchaCode: challenge.devAnswer };
}

// ---------------------------------------------------------------- Redis 裸客户端

/**
 * 发一组 RESP 命令并解析全部回复。
 * 增量式解析器：按字节消费 buffer，支持简单字符串/整数/错误/bulk string/数组（递归）。
 */
function redisExec(commands) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(6379, '127.0.0.1');
    socket.setTimeout(3000);
    let buffer = Buffer.alloc(0);
    const expected = commands.length;
    const replies = [];

    // 读取一条完整回复；buffer 不够时返回 null（等下一块数据）
    function readReply() {
      if (buffer.length === 0) return null;
      const type = String.fromCharCode(buffer[0]);
      const eol = buffer.indexOf('\r\n');
      if (eol < 0) return null;

      if (type === '$') {
        const len = Number(buffer.slice(1, eol).toString('utf8'));
        if (len === -1) {
          buffer = buffer.slice(eol + 2);
          return null;
        }
        const total = eol + 2 + len + 2;
        if (buffer.length < total) return null;
        const value = buffer.slice(eol + 2, eol + 2 + len).toString('utf8');
        buffer = buffer.slice(total);
        return value;
      }
      if (type === ':') {
        const value = Number(buffer.slice(1, eol).toString('utf8'));
        buffer = buffer.slice(eol + 2);
        return value;
      }
      if (type === '+') {
        const value = buffer.slice(1, eol).toString('utf8');
        buffer = buffer.slice(eol + 2);
        return value;
      }
      if (type === '-') {
        throw new Error('redis error: ' + buffer.slice(1, eol).toString('utf8'));
      }
      if (type === '*') {
        const count = Number(buffer.slice(1, eol).toString('utf8'));
        if (count === -1) {
          buffer = buffer.slice(eol + 2);
          return null;
        }
        const items = [];
        buffer = buffer.slice(eol + 2);
        for (let i = 0; i < count; i++) {
          const item = readReply();
          if (item === null && buffer.length === 0 && i < count - 1) return null; // 数据没到齐
          items.push(item);
        }
        return items;
      }
      throw new Error('unexpected redis reply type: ' + type);
    }

    socket.on('connect', () => {
      for (const args of commands) {
        let payload = `*${args.length}\r\n`;
        for (const arg of args) {
          payload += `$${Buffer.byteLength(String(arg))}\r\n${arg}\r\n`;
        }
        socket.write(payload);
      }
    });
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        for (;;) {
          const before = buffer.length;
          const reply = readReply();
          if (reply === null && buffer.length === before) break;
          if (reply !== null || buffer.length === 0) replies.push(reply);
          if (replies.length >= expected) {
            socket.end();
            resolve(replies);
            return;
          }
          if (buffer.length === before && reply === null) break;
        }
      } catch (err) {
        socket.end();
        reject(err);
      }
    });
    socket.on('timeout', () => {
      socket.end();
      reject(new Error('redis timeout'));
    });
    socket.on('error', (err) => reject(err));
  });
}

/**
 * 清掉本机 Redis 里本脚本留下的 IP 限流计数（wca:ip:*）。
 *
 * 为什么需要它：IP 限流的窗口是 10 分钟，而连续跑几轮自检很容易把
 * 同一 IP 的注册/登录窗口打满 —— 那是新防线在正确工作，但会让回归
 * 不确定。清自己的计数器（只清 wca:ip 前缀）对生产无影响。
 */
export async function clearIpCounters() {
  try {
    const keys = await redisExec([['KEYS', 'wca:ip:*']]);
    const flat = Array.isArray(keys) ? keys : [];
    if (flat.length > 0) {
      await redisExec([['DEL', ...flat]]);
    }
    return flat.length;
  } catch {
    return 0; // Redis 不在时后端本来就走进程内降级，不用清
  }
}

