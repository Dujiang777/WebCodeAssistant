/**
 * UI 自检驱动脚本（仅用于本地自测）。
 *
 * 为什么需要它：在这个 shell 环境里，直接从 PowerShell 调用 agent-browser 的多个子命令
 * 会让 daemon 在每次调用后被回收，导致「open 完再 screenshot」拿到 about:blank。
 * 把同一批命令放进**一个 Node 进程**里顺序 spawn，daemon 就能活到整批命令跑完。
 *
 * 用法：
 *   node tools/ui-probe.mjs <steps.json> <log.txt>
 *
 * steps.json 是一个数组，元素二选一：
 *   ["click", ".form-stack .btn-primary"]        —— 一条 agent-browser 子命令（argv 数组）
 *   { "sleep": 2000 }                            —— 等待 N 毫秒
 *
 * 用 JSON 而不是纯文本，是为了避免自己写分词器：选择器里的空格、引号、等号
 * 都要原样传给子进程，任何自作聪明的分词都会在 `[title="a/b.java"]` 这类选择器上翻车。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, isAbsolute } from 'node:path';

const NODE = process.execPath;
const AB = 'D:\\Node\\node_global\\node_modules\\agent-browser\\bin\\agent-browser.js';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const [stepsFile, logFile] = process.argv.slice(2);
if (!stepsFile || !logFile) {
  console.error('usage: node tools/ui-probe.mjs <steps.json> <log.txt>');
  process.exit(2);
}

const steps = JSON.parse(readFileSync(resolve(stepsFile), 'utf8'));
const out = [];
const log = (line) => {
  out.push(line);
  console.log(line);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const env = {
  ...process.env,
  AGENT_BROWSER_EXECUTABLE_PATH: CHROME,
  AGENT_BROWSER_COLOR_SCHEME: 'dark',
  AGENT_BROWSER_IDLE_TIMEOUT_MS: '600000',
  AGENT_BROWSER_DEFAULT_TIMEOUT: '25000',
};

/** 截图输出路径相对项目根解析，保证产物集中。 */
function normalizeArg(value) {
  if (/\.(png|jpe?g|txt|json|webm)$/i.test(value) && /^(docs|tools)[\\/]/.test(value)) {
    return resolve(process.cwd(), value);
  }
  return value;
}

log(`# ui-probe start  steps=${steps.length}`);

for (const step of steps) {
  if (step && typeof step === 'object' && !Array.isArray(step)) {
    if (typeof step.sleep === 'number') {
      await sleep(step.sleep);
      log(`\n$ sleep ${step.sleep}`);
      continue;
    }
    continue;
  }

  const argv = step.map(normalizeArg);
  const display = argv.map((a) => (isAbsolute(a) && /\s/.test(a) ? `"${a}"` : a)).join(' ');
  log(`\n$ agent-browser ${display}`);

  try {
    const stdout = execFileSync(NODE, [AB, ...argv], {
      env,
      encoding: 'utf8',
      timeout: 120000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (stdout && stdout.trim()) log(stdout.trim());
  } catch (error) {
    const stdout = error.stdout ? String(error.stdout).trim() : '';
    const stderr = error.stderr ? String(error.stderr).trim() : '';
    if (stdout) log(stdout);
    if (stderr) log('STDERR: ' + stderr);
  }
}

log('\n# ui-probe done');

mkdirSync(dirname(resolve(logFile)), { recursive: true });
writeFileSync(resolve(logFile), out.join('\n'), 'utf8');
