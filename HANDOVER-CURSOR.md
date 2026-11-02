# Web Code Assistant（WCA）项目交接说明

> 这份文档是给接手的 AI 编码助手（Cursor 等）用的**完整操作手册**。
> 全部内容基于 2026-10-10 的真实项目状态写成，命令可直接复制执行。
> 阅读顺序：项目概况 → 环境启动 → 每批标准流程 → 验证体系 → 部署 → 双推 → 红线 → 踩坑清单。

---

## 0. 一句话认知

WCA 是一个「网页版编码助手」：用户建工作区（上传/新建代码文件），在 IDE 里用自然语言让 AI 读代码、提补丁、写盘、应用补丁、编译验证、跑影响面分析。技术上是 **React 18 + Vite + Monaco** 前端 + **Spring Boot 3.5 + Java 21 + LangChain4j 1.0.0** 后端，UI 走「暗房胶片（Darkroom Brass）」视觉语言，三主题（brass / emerald / ivory）。

---

## 1. 项目基本信息

| 项 | 值 |
|---|---|
| 本地路径 | `C:\Users\AMBITIOUS_YUAN\Projects\web-code-assistant` |
| 前端 | `frontend/`（React 18 + Vite + Monaco） |
| 后端 | `backend/`（Spring Boot 3.5 / Java 21 / LangChain4j 1.0.0） |
| 自检工具 | `tools/`（ui-probe、mock-llm、e2e 脚本、ui-steps 剧本） |
| 部署脚本 | `deploy/server/build.sh`（云端落位 `/opt/wca/deploy/build.sh`） |
| 设计契约 | `tools/ui-steps/30-design-semantics.json` |
| 自检截图 | `docs/self-test/v*/` |
| 线上地址 | http://139.199.88.15:8081 |

### 目录速览
```
backend/                Spring Boot 后端
frontend/src/
  components/           ChatPane / PatchCard / ToolCard(在 ChatPane 内) / FileTree / TopBar / EditroPane ...
  pages/                IdePage(主 IDE) / LoginPage / CreditsPage / AdminPage / ModelsPage ...
  lib/chat.ts           summarizeToolArgs / toolArgsPeek(批35 新增) / LiveTurn 类型
  styles/global.css     全站唯一主样式（约 8800 行，按「批次」分段追加）
tools/
  ui-probe.mjs          UI 自检驱动（JSON 剧本 → 真实浏览器）
  ui-steps/*.json       剧本（30/35/46 是设计契约，61/62/63 是批次验收）
  mock-llm/server.mjs   本地假 LLM（离线跑全链路）
  e2e-*.mjs             四条 e2e 基线
  e2e-smoke.mjs / e2e-features-13-16.mjs / e2e-auth-credits.mjs / e2e-multifile-patch.mjs
  _fix-steps.mjs        一次性工具：修正手写剧本 JSON 的分隔符错误
```

---

## 2. 本地环境启动（三服务）

**端口约定**：MySQL 3306、Redis 6379、mock LLM 8787、后端 8080、前端 5173。
MySQL/Redis 是常驻服务，通常已在跑；后三个要手动拉起。

### 2.1 启动 mock LLM（必须，否则 AI 相关功能不可用）
```bash
cd /c/Users/AMBITIOUS_YUAN/Projects/web-code-assistant
node tools/mock-llm/server.mjs
```
需要「回合持续几秒」抓 live 状态时，带步延迟启动（跑 e2e 前务必换回 0 延迟）：
```bash
MOCK_LLM_STEP_DELAY_MS=2500 node tools/mock-llm/server.mjs
```

### 2.2 启动后端（e2e/mock 全套环境变量，缺一个就会裸连真实 DeepSeek）
```bash
cd /c/Users/AMBITIOUS_YUAN/Projects/web-code-assistant/backend && \
LLM_BASE_URL=http://127.0.0.1:8787/v1 \
LLM_API_KEY=mock-key \
LLM_MODEL=mock-coder \
LLM_EMBED_MODEL=mock-embed \
COMPILE_MVN_SETTINGS="C:\Users\AMBITIOUS_YUAN\.m2\settings.xml" \
COMPILE_JAVA_HOME="C:\Program Files\Java\ms-21.0.12.1" \
SERVER_PORT=8080 \
./gradlew bootRun --no-daemon -q
```
要点：
- `COMPILE_MVN_SETTINGS` **必须是绝对路径**（相对路径会被 `anchorToLaunchDir` 锚到 `backend/tools/` 下，导致编译步骤 2 项失败）。
- `--no-daemon` 必须带：gradle daemon 会复用旧环境、吞掉 env，导致 LLM 配置回落到数据库里的真实 provider。
- 端口用 `SERVER_PORT=8080` 环境变量，**不是** `--server.port`（后者不是 gradle 选项）。
- 探活：`curl http://127.0.0.1:8080/api/auth/me` 返回 401 = 正常（说明服务在、安全层生效）。

### 2.3 启动前端
```bash
cd /c/Users/AMBITIOUS_YUAN/Projects/web-code-assistant/frontend
npm run dev -- --host 127.0.0.1
```
- **必须带 `--host 127.0.0.1`**，否则 vite 只绑默认网卡，ui-probe 访问 127.0.0.1 会被拒。
- npm 安装慢时用镜像：`npm config set registry https://registry.npmmirror.com`。

### 2.4 三个服务都挂后台（Bash 工具的 run_in_background=true）
沙盒会回收后台服务，跨天必死；每次开工前先 `netstat -ano | grep -E ":8787|:8080|:5173"` 探活。

### 2.5 数据库
```bash
mysql -uroot -proot webcode -e "select status, count(*) from patches group by status"
```
- MySQL root/root，库名 `webcode`，时区 `+08:00`，时间字段精度 `now(6)`。
- DDL 隐式提交，清理测试数据要放干净。
- **红线：用户本人的 DeepSeek key（`llm_providers` 表 id=15）绝对不能动。**

---

## 3. 每批改动的标准流程（8 步，务必全走）

1. **改代码**（前端 `frontend/src/`，后端 `backend/src/main/java/...`）
2. **验证（本地 UI 剧本）**：新写或复用 `tools/ui-steps/XX-*.json` 剧本，跑 `node tools/ui-probe.mjs tools/ui-steps/XX.json tools/_ui-xxx.log`，所有断言必须全绿（`grep -c '✗' 日志` = 0）
3. **设计契约**：`30-design-semantics` / `35-theme-refine` / `46-blackroom` 三个剧本**串行**跑，零失败
4. **e2e 四基线**：`83 / 65 / 114 / 15`，全零失败（说明零功能回归）
5. **git 提交 + 双推**（见第 6 节）
6. **云构建部署**（见第 5 节）
7. **公网验收**：curl 200 + 新 CSS hash + 线上 CSS 含本批特征
8. **写记忆**（见第 8 节）

---

## 4. 验证体系（详细）

### 4.1 UI 剧本（ui-probe）
```bash
cd /c/Users/AMBITIOUS_YUAN/Projects/web-code-assistant
# 跑之前先校验 JSON 合法性 + 规范化分隔符（见踩坑 §7.2）
node tools/_fix-steps.mjs tools/ui-steps/XX-xxx.json
node -e "JSON.parse(require('fs').readFileSync('tools/ui-steps/XX-xxx.json','utf8'));console.log('JSON OK')"
# 长剧本（>60 步）必须后台跑，前台会被沙盒 SIGTERM
node tools/ui-probe.mjs tools/ui-steps/XX-xxx.json tools/_ui-xx.log
# 看结果
grep -E '^"' tools/_ui-xx.log | head -30
grep -c '✗' tools/_ui-xx.log     # 必须是 0
```
剧本是 JSON 数组，元素二选一：
```json
["set", "viewport", "1512", "950"]
["open", "http://127.0.0.1:5173/#/login"]
["hover", ".some-element"]
["screenshot", "docs/self-test/v12/xx.png"]
["click", ".btn"]
{"sleep": 2600}
["eval", "document.querySelectorAll('.x').length"]
{"note": "这一步在验什么"}
```
### 4.2 设计契约（三剧本，串行，禁并行）
- `30-design-semantics.json` —— 设计语义契约（含工具卡齿孔条 `TOOL_HOLES` 等断言）
- `35-theme-refine.json` —— 三主题阶梯巡览（**末尾必须恢复 brass**）
- `46-blackroom.json` —— 黑室基线（字体/氛围光/顶栏/按钮/输入框等）
```bash
for s in 30-design-semantics 35-theme-refine 46-blackroom; do
  node tools/ui-probe.mjs tools/ui-steps/$s.json tools/_ui-$s.log > /dev/null 2>&1
  echo "$s 失败数: $(grep -c '✗' tools/_ui-$s.log)"
done
```
**必须串行**：并行跑会互抢 agent-browser daemon，出现假回归。

### 4.3 e2e 四基线（期望值固定）
```bash
cd /c/Users/AMBITIOUS_YUAN/Projects/web-code-assistant
node tools/e2e-smoke.mjs              # 期望 83 通过 / 0 失败
node tools/e2e-features-13-16.mjs    # 期望 65 / 0
node tools/e2e-auth-credits.mjs      # 期望 114 / 0
node tools/e2e-multifile-patch.mjs   # 期望 15 / 0
```
跑 e2e 前必须：mock LLM 是 **0 延迟**版、后端带全套 mock env 在跑、MySQL/Redis 活着。

### 4.4 线上验收剧本
- `58-live-check.json` —— 打公网站点，验线上外壳（不登生产库）

### 4.5 mock LLM 能造什么场景
`tools/mock-llm/server.mjs` 根据用户消息意图返回不同工具链：
- 「解释/说明」→ 纯文本
- 「重构/分步计划」→ `set_plan` → `read_file` → `propose_patch`（**能真出补丁卡，UI 验收主力**）
- 「多文件」→ `refactor_multi`
- 「坏 JSON 恢复」→ 故意吐坏参数，验后端自愈
想验补丁卡真实链路（出卡 → 特性开关闸门 → 应用写盘 → maven 编译 → 印章），用分步计划类消息。

---

## 5. 部署到服务器（完整流程）

### 5.1 服务器信息
| 项 | 值 |
|---|---|
| 云厂商 | 腾讯云轻量应用服务器 |
| 实例 | `lhins-d32cso4p`（广州，Ubuntu 24.04，2C2G，**无 Docker**） |
| 公网 IP | `139.199.88.15` |
| 站点端口 | **8081**（nginx 托管 `/opt/wca/dist`，反代后端 8080） |
| SSH | `ssh -i ~/.ssh/webcoding.pem ubuntu@139.199.88.15` |
| 密钥位置 | `/opt/wca/wca.env`（仅服务器上有） |
| 服务管理 | `systemd` unit `wca-backend` |
| git 仓库 | **`/opt/wca/src`**（注意：不是 `/opt/wca` 本身，那里不是仓库） |
| 构建脚本 | `/opt/wca/deploy/build.sh` |
| 数据库 SQL | 限定库名 `webcode` |

**注意**：80/443 端口是 Caddy 占的，**不要动**。

### 5.2 部署三步（拉代码 → 构建 → 验收）
```bash
# 1) 对齐代码（仓库在 /opt/wca/src）
ssh -i ~/.ssh/webcoding.pem ubuntu@139.199.88.15 \
  "cd /opt/wca/src && sudo git fetch origin && sudo git reset --hard origin/main && sudo git log --oneline -1"

# 2) 云构建（脚本自带：原子替换 jar → systemctl restart → 30 次健康轮询，约 2 分钟）
ssh -i ~/.ssh/webcoding.pem ubuntu@139.199.88.15 \
  "cd /opt/wca && sudo bash deploy/build.sh 2>&1 | tail -6; systemctl show wca-backend -p ActiveEnterTimestamp"

# 3) 公网验收
curl -s -o /dev/null -w "front:%{http_code} " http://139.199.88.15:8081/
curl -s -o /dev/null -w "api:%{http_code}\n" http://139.199.88.15:8081/api/auth/me   # 期望 200 / 401
CSS=$(curl -s http://139.199.88.15:8081/ | grep -oE 'index-[A-Za-z0-9_-]+\.css' | head -1); echo "CSS=$CSS"
curl -s http://139.199.88.15:8081/assets/$CSS | grep -oE "本批特征类名" | sort | uniq -c
```
- build.sh 成功标志：`HEALTH_OK` + `ALL_DONE`，后端 `ActiveEnterTimestamp` 会是刚才的时间。
- 后端重启时间必须晚于 jar 的 mtime —— build.sh 已自动做（历史上出过「换 jar 不重启 → 懒加载 NoClassDefFoundError → 线上 500」的事故，见踩坑 §7.4）。
- 若 `build.sh` 在 `/opt/wca/src` 里跑会出 `CLONE_FAILED`（脚本开头 `rm -rf src` 自 clone），cwd 必须是 `/opt/wca`。

---

## 6. 仓库上传（双远程，每批必推）

### 6.1 两个远程
```bash
git remote -v
# gitee   https://gitee.com/du-jiangjiang/web-code-assistant.git
# github  https://github.com/Dujiang777/WebCodeAssistant.git
```

### 6.2 凭据（已配好，别动也别重建）
- 凭据文件：`C:/Users/AMBITIOUS_YUAN/.wca-credentials`（store 格式明文，**不要提交进仓库**）
- git 配置：
  ```bash
  git config --replace-all credential.helper ""
  git config --add credential.helper "store --file=C:/Users/AMBITIOUS_YUAN/.wca-credentials"
  ```
- git 身份（local 已设）：`Dujiang777 / 1452667526@qq.com`

### 6.3 日常双推（一条命令流）
```bash
cd /c/Users/AMBITIOUS_YUAN/Projects/web-code-assistant
git add -A
git commit -m "批NN 标题：一句人话概括本批做了什么"
git push gitee main
git push github main
```

### 6.4 GitHub 推送失败时的兜底（本地代理间歇 502 / Empty reply）
用服务器中转，**必须先在服务器 pull 对齐**，否则会输出 `Everything up-to-date`：
```bash
cd /c/Users/AMBITIOUS_YUAN/Projects/web-code-assistant
TOKEN=$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill | grep -o 'password=.*' | cut -d= -f2-)
ssh -i ~/.ssh/webcoding.pem ubuntu@139.199.88.15 "cd /opt/wca/src && sudo git pull origin main 2>&1 | tail -1 && sudo git remote add gh-tmp https://x-access-token:${TOKEN}@github.com/Dujiang777/WebCodeAssistant.git && sudo git push gh-tmp main 2>&1 | tail -2 && sudo git remote remove gh-tmp && echo GH_PUSH_DONE"
```
推完务必 `git remote remove gh-tmp` 清掉令牌。

### 6.5 提交信息规范
`批NN <主题>：<关键改动1> / <关键改动2> / <关键改动3>`，例：
`批35 显影三镜 + 修复回合切走丢失：计划卡显影进度条 / 工具卡参数铭牌 / 积分机械翻页 / live turn 按会话快照恢复`

### 6.6 后台任务日志约定
`tools/_*.log`、`tools/_*.mjs` 都以下划线开头，`.gitignore` 第 22 行有 `_*` 规则，**不入库**，但本地可用。

---

## 7. 踩坑清单（血泪，务必先读）

### 7.1 伪元素权重陷阱（最容易反复踩）
登录卡的 `::before` 是**安全灯呼吸点**、`::after` 是**四角取景框**，规则权重 `(0,3,1)`。自定义的 `.card-print::before`（权重 0,1,1）会被**静默压掉**——断言拿到的是安全灯的 7×7 圆点，不报错。**结论：改卡片前先 `grep -n "\.xxx::before"` 查占用；`.plan-card` / `.tool-card` / `.patch-card` 的伪元素同样已被占（批26 齿孔条、批28 取景框、批34 印章）。要加装饰优先用真实元素。**

### 7.2 ui-probe 的两个铁律
1. **`screenshot` 会让页面重挂载 → 所有内存态蒸发**（进行中的 live turn、React 受控 input 的值）。所以：所有「进行中」类断言必须排在截图之前；截图后要填表必须先 `location.reload()` 硬刷新再填（否则 setter 填到旧文档上，值被回滚成空，表现为「登录无报错却不跳转」）。
2. **手写 steps JSON 极易错分隔符**：`{"sleep", 1300}` / `["sleep", 2400]` / `{"eval", ...}` 都是错的。ui-probe 会崩在 `node:path validateString(path)`。跑之前一律：
   ```bash
   node tools/_fix-steps.mjs tools/ui-steps/XX.json
   node -e "JSON.parse(require('fs').readFileSync('tools/ui-steps/XX.json','utf8'));console.log('JSON OK')"
   ```

### 7.3 沙盒与长任务
- Bash 命令超过约 60 秒会被沙盒 SIGTERM → 长剧本、长 e2e 一律 `run_in_background=true`，再用任务输出轮询。
- 每个 Bash 命令都可能从工作区根目录重置 cwd → **每条命令都要显式 `cd /c/Users/AMBITIOUS_YUAN/Projects/web-code-assistant` 开头**，否则 `MODULE_NOT_FOUND` 假跑（「全绿」可能是假的，日志根本没生成，务必核对日志文件存在）。
- 并行多个 Edit 会静默丢一半 → **一条命令一个 Edit**，改完 `grep` 复核落位。
- git 禁止 rebase；破坏性 git 操作前先想替代方案。

### 7.4 历史事故（别重演）
- **线上 500（打开工作区报 NoClassDefFoundError）**：build.sh 原来只换 jar 不重启 + `cp` 原地覆盖运行中的 jar，JVM 懒加载拉不到新类。现已修：原子替换（`install -m644 到 .new` + `mv`）+ 自动 `systemctl restart` + 健康轮询。
- **AI 一直转没输出（挂死）**：DeepSeek 吐了坏 JSON 工具参数 → LangChain4j 解析在 try 外 → 异常被 SSE onClose 吞掉。现已修：`SafeToolExecutors`（坏参数当工具结果喂回模型自愈）+ `finish()` 双兜底 + `tokenOf` catch CCE 降级。**改 AgentOrchestrator 时别把这三处删了。**

### 7.5 UI 剧本导航坑
- **`#/ide` 直链会丢工作区上下文、被弹回工作台**——剧本必须 `document.querySelectorAll('.workspace-row')[0].click()` 进 IDE。
- hover 断言必须用 `["hover", 选择器]`（真鼠标事件），合成事件不触发 `:hover`。
- 要 hover 某个特定元素时，先 `setAttribute('data-probe','xx')` 打标记，再 `["hover", "[data-probe='xx']"]`。
- 「点 + 新建会话」不一定切走（select 可能仍指旧会话），断言切走/切回要**显式记录原会话 id**再按 id 选回，别用「第一个不等于当前值」。
- 特性开关 `flag-card-required` 出现时，「应用并写盘」是 **disabled**，必须先 `document.querySelector('.flag-card-required input[type=checkbox]').click()`。
- 后端时间戳返回带 `Z`，前端一律用 `lib/api.ts` 的 `formatDateTime()`。

---

## 8. 设计契约（改样式前必读）

### 8.1 视觉语言：Darkroom Brass（暗房胶片）
- 暖近黑底 `#080604`，金 `--signal #e8b45a` 为品牌/可点色，象牙白正文，胶囊按钮。
- 色彩分工：**金=品牌/可点；lime #57e389=通过；玫红=失败；紫=补丁；--cyan #9db4c8=工具卡/info**。
- 中文禁 uppercase / 大字距；顶栏高 42px、状态栏 23px、对话 gap 16px；<1280 自动收树+工位。
- 三主题：`data-theme` = `brass` / `emerald` / `ivory`，换肤只换色相不换材质；**改底色要三处同步**（`global.css` + `monaco.ts` + `theme.ts` swatch）。

### 8.2 不可违反的工程约定
- **类名是自检契约**：改样式不改类名（可追加状态类/新类，不能删改旧类）。
- **`:root` 新变量值必须与被替换的字面量逐字一致**，否则 brass 主题会漂移。
- 动效三档：`--dur-1/2/3` + `--ease-out/soft` + `--press(0.97)`/`--press-hard(0.94)`。
- **入场 keyframes 用 `translate`/`scale`/`rotate` 独立属性；`to` 帧必须显式写 `translate: none`**——写 `0` + `fill: both` = 永久 stacking context（历史上出过层级 bug）。
- reduced-motion 用 `animation-duration: 0.01ms` 通配，**不是 `animation: none`**（后者清 fill-mode 会闪）。
- 改样式前先 `grep -n "^\.目标 {"` 查同名选择器，防死代码覆盖。

### 8.3 契约里的既定隐喻（延续，别推翻）
胶片齿孔条、四角取景框、片边帧号、冲印印章、暗盒齿装、显影进度条、机械翻页计数、相机取景对焦屏。

---

## 9. 功能层红线

- **零功能回归**：「不要把有的功能修没了」。改样式不动功能；e2e 四基线是硬门槛。
- **用户本人的 DeepSeek key 绝不能动**（`llm_providers` id=15）。
- AI 纪律提示词在 `backend/.../context/SystemPrompts.java` 的 `EXECUTION_DISCIPLINE`，是纪律唯一落点：diff 本身就是确认（第 0 条）、禁投票式结尾、模糊需求直接做+交代口径、禁索要可自查信息。**改提示词后必须跑 `node tools/_probe-prompt.mjs` 验 23 项断言。**
- 工具参数：已用 `SafeToolExecutors` 兜底，别退回裸 `AiServices.tools(Object)`。
- 补丁应用：全有或全无；`UnifiedDiffParser` 已剥 hunk 末尾空行，别改回。
- 账号：双令牌 + epoch；**bump 后必须 `statusGuard.invalidate`**；HOLD→SETTLE/RELEASE；对账 `sum(delta)==balance`。
- 积分/充值：`Charge settled+handedOff` 双标志；必抛异常的写操作用 `REQUIRES_NEW`。
- 撞库防护：同 IP 失败用户名 ≥3 → 强制验证码。
- 编辑器：`editorIde.ts` 已关掉内建 TS/JS 诊断，别开回去；`triggerSuggest` 800ms 节流兜底是核心。
- 停止回合：`guard + finish()` 双兜底；`.composer-stop` 不占 `.composer-send` 的位置。

---

## 10. 记忆与文档

- 项目长期备忘：`C:\Users\AMBITIOUS_YUAN\WorkBuddy\2026-09-21-09-49-15\.workbuddy\memory\MEMORY.md`
- 每日工作日志：同目录 `YYYY-MM-DD.md`（**append-only**）
- **每批做完必须追加一条日志**，写清：改了什么、验证结果、踩了什么坑、下批候选。这份文档与记忆是接手者最重要的上下文。

---

## 11. 待办（截至 2026-10-10）

- `#97` PR：需要用户补 GitHub token 才能真正创建
- 每用户 Docker 沙箱：未做（服务器本身无 Docker）
- 真实支付网关：用户暂缓
- 桌面镜像 `D:\Desktop\web-code-assistant`：批22 起未同步
- 会话切换器「运行中」标记、工具卡铭牌点击直达文件、补丁卡盖章前摇：批36 候选

---

## 12. 快速上手（最短路径）

```bash
# 1. 起服务（三个后台终端）
node tools/mock-llm/server.mjs
cd backend && LLM_BASE_URL=http://127.0.0.1:8787/v1 LLM_API_KEY=mock-key LLM_MODEL=mock-coder \
  LLM_EMBED_MODEL=mock-embed COMPILE_MVN_SETTINGS="C:\Users\AMBITIOUS_YUAN\.m2\settings.xml" \
  COMPILE_JAVA_HOME="C:\Program Files\Java\ms-21.0.12.1" SERVER_PORT=8080 ./gradlew bootRun --no-daemon -q
cd frontend && npm run dev -- --host 127.0.0.1

# 2. 改代码 → 3. 跑剧本验证 → 4. 契约三连 → 5. e2e 四基线
node tools/ui-probe.mjs tools/ui-steps/62-darkroom-iii.json tools/_ui.log   # 示例
node tools/e2e-smoke.mjs   # 83/0

# 6. 双推 → 7. 云部署 → 8. 公网验收 → 9. 写记忆
git add -A && git commit -m "批NN ..." && git push gitee main && git push github main
ssh -i ~/.ssh/webcoding.pem ubuntu@139.199.88.15 "cd /opt/wca/src && sudo git pull origin main && cd /opt/wca && sudo bash deploy/build.sh"
curl -s -o /dev/null -w "%{http_code}\n" http://139.199.88.15:8081/
```
