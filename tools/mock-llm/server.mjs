#!/usr/bin/env node
/**
 * 一个最小可用的 OpenAI 兼容模型服务（mock）。
 *
 * 目的：让「Agent 循环 + 工具调用 + 补丁生成」这条链路可以**在没有 API Key、没有外网**的情况下
 * 端到端跑通并自测。它会：
 *   1. 收到第一轮请求 → 返回一次 read_file 工具调用（参数取 system prompt 里的「当前文件」）；
 *   2. 收到带工具结果的第二轮 → 若用户意图是「重构」则返回 propose_patch，
 *      并**基于真实读到的文件内容**生成一个能干净应用的 unified diff；若是「解释」则直接给结论；
 *   3. 收到带补丁结果的第三轮 → 返回最终的自然语言总结。
 *
 * 用法：
 *   node tools/mock-llm/server.mjs --port 8787
 *   LLM_BASE_URL=http://127.0.0.1:8787/v1 LLM_API_KEY=mock LLM_MODEL=mock-coder
 *
 * 注意：它**只用于开发自测**，绝不要在生产环境里用它冒充真实模型。
 */

import http from 'node:http';

const PORT = (() => {
  const index = process.argv.indexOf('--port');
  if (index >= 0 && process.argv[index + 1]) return Number(process.argv[index + 1]);
  return Number(process.env.MOCK_LLM_PORT ?? 8787);
})();

const MODEL_NAME = process.env.MOCK_LLM_MODEL ?? 'mock-coder';

// 每一轮回复前的额外延迟。默认 0（跑自测要快）；把它调大（例如 2500）可以让
// 「工具卡片正在执行」这一瞬间在界面上停留得久一点，方便截图或人工观察。
const STEP_DELAY_MS = Number(process.env.MOCK_LLM_STEP_DELAY_MS ?? 0);

// 置 1 时，回答里会额外塞一条**指向不存在文件**的引用，用来自检「引用存疑」的红色状态。
// 这是一条只有自检才需要的能力：正常回答里不该出现编造的引用。
const FAKE_CITATION = process.env.MOCK_LLM_FAKE_CITATION === '1';

// ---------------------------------------------------------------- 工具函数

/** 把一段文本按 OpenAI 的流式格式逐块吐出去。 */
function streamText(res, chunks) {
  for (const chunk of chunks) {
    sendChunk(res, { choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }] });
  }
}

/** 以「分片的 tool_calls」形式返回一次工具调用，模拟真实的增量拼接过程。 */
function streamToolCall(res, name, args) {
  const callId = `call_${Math.random().toString(36).slice(2, 10)}`;
  sendChunk(res, {
    choices: [{
      index: 0,
      delta: { role: 'assistant', tool_calls: [{ index: 0, id: callId, type: 'function', function: { name, arguments: '' } }] },
      finish_reason: null,
    }],
  });
  // 参数切成几片发，模拟真实服务端行为（客户端必须能正确拼接）
  const json = JSON.stringify(args);
  const slice = Math.ceil(json.length / 4) || 1;
  for (let i = 0; i < json.length; i += slice) {
    sendChunk(res, {
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index: 0, function: { arguments: json.slice(i, i + slice) } }] },
        finish_reason: null,
      }],
    });
  }
  sendChunk(res, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
}

function sendChunk(res, payload) {  const body = {
    id: `chatcmpl-mock-${Date.now()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: MODEL_NAME,
    ...payload,
  };
  res.write(`data: ${JSON.stringify(body)}\n\n`);
}

function finish(res, { inputTokens = 0, outputTokens = 0 } = {}) {
  // 末尾的 usage 分片：choices 为空数组，这是 OpenAI 在 stream_options.include_usage 下的行为
  res.write(`data: ${JSON.stringify({
    id: `chatcmpl-mock-${Date.now()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: MODEL_NAME,
    choices: [],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 从 system prompt 里抠出「当前文件：`xxx`」。 */
function extractCurrentFile(messages) {  const system = messages.filter((m) => m.role === 'system').map((m) => m.content ?? '').join('\n');
  const match = system.match(/当前文件：`([^`]+)`/);
  if (match) return match[1];
  const pom = system.match(/src\/main\/java\/[\w/]+\.java/);
  return pom ? pom[0] : null;
}

/** 从 read_file 的工具结果里取出文件正文（```lang ... ``` 之间的内容）。 */
function extractFileContent(toolResult) {
  const fence = toolResult.match(/```[a-zA-Z]*\n([\s\S]*?)\n```/);
  if (!fence) return null;
  return stripLineNumbers(fence[1]);
}

/**
 * 去掉 read_file 加上的 `   42| ` 行号前缀。
 *
 * read_file 现在**刻意**带行号返回（这样模型的引用能精确到行），但 diff 的上下文行
 * 必须是文件的原始内容。真实模型靠 system prompt 里那句「不要把行号复制进 diff」自律，
 * mock 则直接把前缀剥掉 —— 否则生成的 diff 会把行号一起写进文件，比不出 diff 更糟。
 */
function stripLineNumbers(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/^ *\d+\| ?/, ''))
    .join('\n');
}

/** 某个片段在正文里第一次出现的行号（1 起）；找不到返回 null。 */
function lineOf(content, needle) {
  const index = content.indexOf(needle);
  if (index < 0) return null;
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (content.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

/**
 * 生成一处引用：`路径:行号`。
 *
 * 行号是**真的从读到的内容里数出来的**，不是编的 —— 否则后端校验会把它标红，
 * 那条「引用存疑」的红色状态本来就是留给编造引用的。
 */
function cite(file, content, needle) {
  const line = lineOf(content, needle);
  return line == null ? `\`${file}\`` : `\`${file}:${line}\``;
}

/** 自检用：在回答末尾追加一条指向不存在文件的引用，触发前端红色标记。 */
function fakeCitationLine() {
  return FAKE_CITATION
    ? '\n> 自检标记：这条引用是**故意编造**的，用来确认它会变红 —— `src/main/java/com/demo/NotExist.java:9999`。\n'
    : '';
}

/** 行号区间引用：`路径:起始-结束`。用来验证「范围引用」这条路径。 */
function citeRange(file, content, startNeedle, endNeedle) {
  const start = lineOf(content, startNeedle);
  const end = lineOf(content, endNeedle);
  if (start == null) return `\`${file}\``;
  if (end == null || end === start) return `\`${file}:${start}\``;
  return `\`${file}:${start}-${end}\``;
}

/**
 * 「解释这个类」的回答。
 *
 * 两个刻意的处理：
 *   1. 所有关于代码的事实都挂 `路径:行号`，行号是从**真实读到的内容**里数出来的 ——
 *      编出来的行号会被后端校验标红，那正好就不是我们想展示的「正常回答」；
 *   2. 读不到内容时**不编**。直接承认没读到，这就是 cite-or-refuse 里「refuse」那一半。
 */
function explainChunks(file, content) {
  if (!content) {
    return [
      '我这次没有拿到文件正文（read_file 没返回内容），所以我不打算凭文件名猜它的实现。\n\n',
      '你可以让我重新读一次，或者直接告诉我文件路径。\n',
    ];
  }

  const chunks = ['这个类的职责是「用户领域服务」：\n\n'];
  const items = [
    {
      text: '`register` 负责注册用户，用户名重复时抛 `IllegalArgumentException`',
      cite: citeRange(file, content, 'public User register', 'throw new IllegalArgumentException'),
    },
    {
      text: '`getById` 找不到时抛领域异常 `UserNotFoundException`，由控制器统一转成 404',
      cite: cite(file, content, 'public User getById'),
    },
    {
      text: '`deactivate` 只是把 `active` 置为 false',
      cite: cite(file, content, 'public User deactivate'),
    },
    {
      text: '`countActive` 用传统的下标 for 循环累加',
      cite: cite(file, content, 'public long countActive'),
    },
    {
      text: '`rename` 改完名字后同样复用 `save` 落库',
      cite: cite(file, content, 'public User rename'),
    },
  ];

  items.forEach((item, index) => {
    chunks.push(`${index + 1}. ${item.text}（${item.cite}）；\n`);
  });

  if (content.includes('@Autowired')) {
    chunks.push(
      `\n6. 依赖是通过 **字段注入** 拿到的（${cite(file, content, '@Autowired')}）。\n\n`,
      '字段注入的问题在于：依赖关系不在构造器签名里，单元测试只能靠反射注入，',
      '而且对象可以在「依赖还没注入」的状态下被创建出来。改成构造器注入可以解决这两点。\n',
    );
  } else {
    chunks.push(
      `\n6. 依赖是通过 **构造器注入** 拿到的（${cite(file, content, 'private final UserRepository userRepository')}）：`,
      '字段是 final 的，依赖不可变，缺依赖时启动就失败，而不是运行到一半才 NPE。\n',
    );
  }

  chunks.push('\n以上结论都来自 ', `\`${file}\``, '，点引用可以直接跳到对应那一行。\n', fakeCitationLine());
  return chunks;
}

/** 判断用户意图。 */
function detectIntent(messages) {
  // 只看**最后一条**用户消息。若把整段对话拼起来判断，一旦用户问过一次「重构」，
  // 之后每一轮都会被判成重构意图（第二轮开始文件里已经没有 @Autowired 了，就会答非所问）。
  const userMessages = messages.filter((m) => m.role === 'user');
  const last = userMessages[userMessages.length - 1];
  const userText = String(last?.content ?? '');
  if (/重构|改成构造器|构造器注入|constructor injection|refactor/i.test(userText)) return 'refactor';
  if (/解释|说明|讲讲|什么是|explain/i.test(userText)) return 'explain';
  return 'general';
}

// ------------------------------------------------------------ diff 生成

/**
 * 生成一个最小 unified diff：先剥掉公共前缀/后缀，再把差异区间扩上 3 行上下文，只产出一个 hunk。
 * 对我们的演示场景（局部替换）来说足够且结果一定可应用。
 */
function buildUnifiedDiff(filePath, originalText, updatedText) {
  const original = originalText.split('\n');
  const updated = updatedText.split('\n');
  const context = 3;

  let prefix = 0;
  while (prefix < original.length && prefix < updated.length && original[prefix] === updated[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < original.length - prefix &&
    suffix < updated.length - prefix &&
    original[original.length - 1 - suffix] === updated[updated.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const start = Math.max(0, prefix - context);
  const endOld = original.length - suffix + context;
  const endNew = updated.length - suffix + context;

  const oldStart = start + 1;
  const oldCount = endOld - start;
  const newStart = start + 1;
  const newCount = endNew - start;

  const lines = [];
  for (let i = start; i < prefix; i += 1) lines.push(` ${original[i]}`);

  // 变更区间：先全部删除，再全部新增（最朴素的表达，但完全合法）
  for (let i = prefix; i < original.length - suffix; i += 1) lines.push(`-${original[i]}`);
  for (let i = prefix; i < updated.length - suffix; i += 1) lines.push(`+${updated[i]}`);

  for (let i = original.length - suffix; i < Math.min(original.length, endOld); i += 1) lines.push(` ${original[i]}`);

  const header = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`;
  return [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    header,
    ...lines,
  ].join('\n');
}

/** UserService 的重构变换：字段注入 → 构造器注入。 */
function refactorUserService(originalText) {
  if (!/UserRepository userRepository/.test(originalText)) {
    return null;
  }
  let updated = originalText
    .replace(/^import org\.springframework\.beans\.factory\.annotation\.Autowired;\n/m, '')
    .replace(
      /    @Autowired\n    private UserRepository userRepository;\n/,
      [
        '    private final UserRepository userRepository;',
        '',
        '    public UserService(UserRepository userRepository) {',
        '        this.userRepository = userRepository;',
        '    }',
        '',
      ].join('\n'),
    );
  return updated === originalText ? null : updated;
}

// ---------------------------------------------------------------- 请求处理

function findToolMessages(messages) {
  return messages.filter((m) => m.role === 'tool' || m.role === 'tool_execution_result');
}

/**
 * 判断一条工具结果来自哪个工具。
 *
 * 为什么不能直接读 `message.name`：LangChain4j 回填工具结果时只带 tool_call_id 与 content，
 * 不回传工具名（OpenAI 协议里 tool 角色消息只有 tool_call_id）。所以这里退一步，
 * 用工具结果正文里的特征串反推 —— 对 mock 来说足够了。
 */
function toolNameOf(message) {
  if (message.name) return message.name;
  const content = String(message.content ?? '');
  if (content.includes('补丁已生成')) return 'propose_patch';
  if (content.includes('```')) return 'read_file';
  return message.tool_call_id ?? '';
}

function handleCompletion(body, res) {
  const messages = body.messages ?? [];
  const userMessages = messages.filter((m) => m.role === 'user');
  const lastUserText = String(userMessages[userMessages.length - 1]?.content ?? '');

  // What-if（功能 15）走单独一条通道：它不经过工具循环，而是要求「直接吐一个 unified diff」。
  // 真实模型靠 prompt 里的「只输出一个 unified diff」自律，mock 这里按同样契约模拟。
  if (lastUserText.includes('反事实实验')) {
    return (STEP_DELAY_MS > 0 ? sleep(STEP_DELAY_MS) : Promise.resolve()).then(() =>
      respondWhatIf(lastUserText, res),
    );
  }

  const toolMessages = findToolMessages(messages);
  const intent = detectIntent(messages);
  const currentFile = extractCurrentFile(messages);

  return (STEP_DELAY_MS > 0 ? sleep(STEP_DELAY_MS) : Promise.resolve()).then(() =>
    respond(toolMessages, intent, currentFile, res),
  );
}

/**
 * What-if 的应答：从 prompt 里自带的「目标文件 + 带行号的当前内容」还原出原文，
 * 换一种写法，再产出 ```diff 代码块。没有匹配的重写模板时退化成「追加一行注释」，
 * 保证一定有一条可解析的 hunk —— 否则这个功能在 mock 下永远只会是 unavailable。
 */
function respondWhatIf(userText, res) {
  const fileMatch = /目标文件：(.+)/.exec(userText);
  const filePath = fileMatch ? fileMatch[1].trim() : null;
  const fenced = /```\n([\s\S]*?)```/.exec(userText);
  const originalText = fenced ? stripLineNumbers(fenced[1]).replace(/\n$/, '') : null;

  if (!filePath || !originalText) {
    streamText(res, ['我拿不到目标文件的内容 —— 换一个文本文件再试。']);
    return finish(res, { inputTokens: 300, outputTokens: 20 });
  }

  const rewritten = refactorUserService(originalText);
  const updated = rewritten ?? `${originalText}\n// what-if 实验标记：这条分支只是把设想落成一个可对比的差异\n`;
  const diff = buildUnifiedDiff(filePath, originalText, updated);

  streamText(res, ['```diff\n', diff, '\n```\n']);
  return finish(res, { inputTokens: 1200, outputTokens: 220 });
}

function respond(toolMessages, intent, currentFile, res) {
  if (toolMessages.length === 0) {
    // 第一轮：先读代码
    if (!currentFile) {
      streamText(res, ['当前还没有打开文件，请先在左侧文件树里点开一个文件，我再帮你分析。']);
      return finish(res, { inputTokens: 400, outputTokens: 40 });
    }
    streamToolCall(res, 'read_file', { path: currentFile });
    return finish(res, { inputTokens: 400, outputTokens: 30 });
  }

  const lastToolName = (() => {
    const last = toolMessages[toolMessages.length - 1];
    return toolNameOf(last);
  })();

  if (toolMessages.length === 1) {
    const content = extractFileContent(toolMessages[0].content ?? '');

    if (intent === 'explain' || !content) {
      streamText(res, explainChunks(currentFile, content));
      return finish(res, { inputTokens: 900, outputTokens: 300 });
    }

    if (intent === 'refactor') {
      const updated = refactorUserService(content);
      if (!updated) {
        streamText(res, ['没有在文件里找到 `UserRepository` 字段注入的写法，请确认当前打开的文件。']);
        return finish(res, { inputTokens: 900, outputTokens: 40 });
      }
      const diff = buildUnifiedDiff(currentFile, content, updated);
      streamToolCall(res, 'propose_patch', {
        file: currentFile,
        summary: '把 UserService 的字段注入改成构造器注入，并移除 Autowired 导入',
        diff,
      });
      return finish(res, { inputTokens: 1200, outputTokens: 160 });
    }

    streamText(res, ['我读完了这个文件。你想让我做哪方面的改动？']);
    return finish(res, { inputTokens: 900, outputTokens: 30 });
  }

  // 已经产出过补丁（或其它工具结果）→ 收尾
  if (lastToolName === 'propose_patch') {
    streamText(res, [
      '重构已完成，我生成了一个补丁，改动都在 ',
      currentFile ? `\`${currentFile}\`` : '当前文件',
      ' 里：\n\n',
      '- 把 `@Autowired private UserRepository userRepository;` 改成 `private final` 字段；\n',
      '- 新增构造器 `public UserService(UserRepository userRepository)`；\n',
      '- 顺带删掉了不再需要的 `Autowired` 导入。\n\n',
      '卡片上标出了这次改动的影响面（谁在调用、有没有测试覆盖）；',
      '确认没问题就点「应用并写盘」，应用后会自动跑一次编译验证。',
      '如果不想改，点「丢弃」即可，磁盘不会被动。\n',
      fakeCitationLine(),
    ]);
    return finish(res, { inputTokens: 1500, outputTokens: 220 });
  }

  streamText(res, ['已完成。还有别的需要我做的吗？']);
  return finish(res, { inputTokens: 1500, outputTokens: 20 });
}

// ---- embeddings：256 维词袋哈希向量，L2 归一化 --------------------------------

const EMBED_DIM = 256;

function hashEmbedding(text) {
  const vec = new Array(EMBED_DIM).fill(0);
  const tokens = String(text).toLowerCase().match(/[a-z0-9_]+|[\u4e00-\u9fff]/g) ?? [];
  for (const token of tokens) {
    let hash = 2166136261;
    for (let i = 0; i < token.length; i++) {
      hash ^= token.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    vec[Math.abs(hash) % EMBED_DIM] += 1;
  }
  let norm = Math.sqrt(vec.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) norm = 1;
  return vec.map((value) => value / norm);
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url?.startsWith('/v1/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: MODEL_NAME, object: 'model' }] }));
    return;
  }

  // /v1/embeddings：确定性的词袋哈希向量（256 维）。
  // 相同 token → 相同桶，因此「同词复现」的代码块得分更高 —— 足够让语义检索
  // 的 e2e 断言可复现，也不需要真实 embedding 服务。
  if (req.method === 'POST' && req.url?.startsWith('/v1/embeddings')) {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* fallthrough */ }
      const inputs = Array.isArray(body.input) ? body.input : [String(body.input ?? '')];
      const data = inputs.map((text, index) => ({
        object: 'embedding',
        index,
        embedding: hashEmbedding(String(text)),
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data, model: body.model ?? 'mock-embed', usage: { prompt_tokens: 1, total_tokens: 1 } }));
    });
    return;
  }

  if (req.method !== 'POST' || !req.url?.startsWith('/v1/chat/completions')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
    return;
  }

  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    let body = {};
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid json' } }));
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    // handleCompletion 现在是异步的（STEP_DELAY_MS > 0 时会先等一会儿再吐流）
    handleCompletion(body, res).catch((error) => {
      sendChunk(res, { choices: [{ index: 0, delta: { content: `mock 内部错误: ${error.message}` }, finish_reason: 'stop' }] });
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-llm] listening on http://127.0.0.1:${PORT}/v1  (model=${MODEL_NAME}, stepDelay=${STEP_DELAY_MS}ms)`);
});
