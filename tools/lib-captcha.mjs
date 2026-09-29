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
 *
 * 解析器规则：readReply 遇到「数据不完整」时必须返回 null 且**不消费 buffer**，
 * 外层等到下一块数据再重试 —— 绝不允许把 null 塞进结果数组。
 * （旧实现踩过的坑：数组中途遇到半个 bulk string，把 null push 进 items，
 * 导致 KEYS 解析出 [key1, null, null]，DEL 只删掉一个 —— 限流计数清不干净，
 * e2e 全线 429，而且因为没有报错，看起来就像「清了但没生效」的灵异事件。）
 */
function redisExec(commands) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(6379, '127.0.0.1');
    socket.setTimeout(5000);
    let buffer = Buffer.alloc(0);
    const expected = commands.length;
    const replies = [];

    // 「数据没到齐」的哨兵 —— 与 RESP nil（解析成功、值为 null）严格区分。
    const NEED_MORE = Symbol('need-more');

    // 解析一条完整回复；数据不够时返回 NEED_MORE 且不消费 buffer
    function readReply() {
      if (buffer.length === 0) return NEED_MORE;
      const type = String.fromCharCode(buffer[0]);
      const eol = buffer.indexOf('\r\n');
      if (eol < 0) return NEED_MORE;

      if (type === '$') {
        const len = Number(buffer.slice(1, eol).toString('utf8'));
        if (len === -1) {
          buffer = buffer.slice(eol + 2);
          return null; // RESP nil bulk string
        }
        const total = eol + 2 + len + 2;
        if (buffer.length < total) return NEED_MORE;
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
        const message = buffer.slice(1, eol).toString('utf8');
        buffer = buffer.slice(eol + 2);
        throw new Error('redis error: ' + message);
      }
      if (type === '*') {
        const count = Number(buffer.slice(1, eol).toString('utf8'));
        if (count === -1) {
          buffer = buffer.slice(eol + 2);
          return null; // RESP nil array
        }
        const saved = buffer; // 任一元素没到齐就整体回滚到数组开头
        buffer = buffer.slice(eol + 2);
        const items = [];
        for (let i = 0; i < count; i++) {
          const item = readReply();
          if (item === NEED_MORE) {
            buffer = saved;
            return NEED_MORE;
          }
          items.push(item); // item 可能是 RESP nil（null），如实记录
        }
        return items;
      }
      throw new Error('unexpected redis reply type: ' + type);
    }

    function consume() {
      try {
        for (;;) {
          const reply = readReply();
          if (reply === NEED_MORE) break;
          replies.push(reply);
          if (replies.length >= expected) {
            socket.end();
            resolve(replies);
            return;
          }
        }
      } catch (err) {
        socket.end();
        reject(err);
      }
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
      consume();
    });
    socket.on('timeout', () => {
      socket.end();
      reject(new Error('redis timeout（已收到 ' + replies.length + '/' + expected + ' 条回复）'));
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
    // redisExec resolve 的是「每条命令一条回复」的列表：KEYS 的回复本身是 key 数组，
    // 所以这里必须取 keys[0]（再里面一层才是 key 名）。
    // 旧实现的 flat = replies 外层 —— 长度恒为 1（命令条数），DEL 收到嵌套数组被
    // String() 转成逗号连接的一个假 key 名，什么都没删。以前单 key 时单元素数组的
    // String() 恰好等于 key 本身，才碰巧工作 —— 典型的「测试数据掩盖 bug」。
    const replies = await redisExec([['KEYS', 'wca:ip:*']]);
    const first = replies[0];
    const flat = (Array.isArray(first) ? first : first ? [first] : []).filter(Boolean);
    if (flat.length > 0) {
      await redisExec([['DEL', ...flat]]);
    }
    return flat.length;
  } catch {
    return 0; // Redis 不在时后端本来就走进程内降级，不用清
  }
}

