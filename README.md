# Web Code Assistant · 网页版编码助手

一个跑在浏览器里的轻量级 coding 助手：**左边文件树、中间 Monaco、右边 AI 对话**。
AI 能读你的项目、能按正则搜代码，但**它没有任何写盘权限** —— 它只能产出 unified diff，
你在对比视图里点「应用」，文件才会真的被改写。

在此之上，它把「凭什么信它」这件事做成了可见的东西：

- **每个结论都能点开核对**：回答里的 `路径:行号` 是可点的证据 chip，编造的引用会被后端校验标红；
- **改之前先看影响面**：补丁卡片会算出「改了哪些类、谁在调用、有没有碰鉴权代码、有没有测试」；
- **改完自证还能编过**：应用补丁后自动跑一次项目自己的编译，失败就把编译器输出喂回去重改；
- **同一套 Agent 两种口吻**：交付模式少说话给结果，教学模式讲清动机与取舍。

工作区是**服务器磁盘上的真实目录**（`git clone` 或 zip 导入），不是浏览器里的虚拟文件系统。

### 视觉设计：「Graphite Terminal」（碳墨工作台）

界面刻意长成一台仪器，而不是「又一个深色 SaaS」：

- **底色**是带一丝绿相的近黑石墨（`#0a0f0d → #222d26` 五级），整页铺 22px 点阵网格 —— 工程图纸的味道，空态里也有纹理，没有大面积死黑；
- **唯一主角是信号绿 `#3af0a6`**：可点的、活着的、通过了的东西都是它（主按钮实底绿配深色字、状态灯带辉光、引用 chip、焦点环）。暖沙/冰蓝/玫红/紫罗兰只做语法与语义配角（字符串/类型/删除/补丁），绝不抢戏；
- **硬边框直角**（1px 线 + 3px 圆角）+ 面板顶部一线高光，像仪器的面板缝；消息靠左侧 2px 刻线的颜色区分身份；
- **等宽铭牌**：品牌名、面板标签、chip、按钮键盘提示全部等宽小字大写 + 拉字距；
- Monaco 主题 `wca-dark` 与外壳取**同一套 CSS 变量值**，编辑器和外壳不会像两个产品拼起来。

---

## 1. 核心设计决策

| 决策 | 为什么这么做 |
| --- | --- |
| **模型只能出补丁，不能写文件** | 工具集里没有任何写盘方法。`propose_patch` 只落库 + 推事件，写盘发生在用户点「应用」触发的 `PatchService.apply` 里。这是「人在环上」的落地方式，不是靠 prompt 约束。 |
| **补丁在生成时就做干跑校验** | 后端会用**完整文件内容**（不是截断后的）试应用一次。所以前端展示出来的补丁「保证可应用」，不会出现点了应用才报冲突。 |
| **回写必须整文件读** | `readFullText` 超限直接报错而不是截断 —— 用半截内容应用补丁会写出残缺文件，这是能真正损坏用户代码的一类错误。 |
| **前端不支持截断文件的保存** | 浏览上限 512 KB，超过就只读。否则一次保存就等于把大文件截断覆盖。 |
| **两个通道分开** | `POST /messages` 立刻返回 `messageId`（不等模型）；事件走 `GET /events` 这条 SSE 长连接。断线重连时带 `afterId` 可以回放漏掉的事件。 |
| **不用 WebFlux** | Spring MVC 的 `SseEmitter` + **虚拟线程**足够：Agent 回合是阻塞式 IO（等模型、读文件），虚拟线程让每轮对话独占一个廉价线程，代码还是同步风格。 |
| **Redis 可降级** | 它只承载限流与 token 配额。连不上就自动退回进程内实现（启动时打 WARN），不阻塞任何功能。 |
| **四个工具全部只读或产出补丁** | `list_dir` / `read_file` / `grep` / `propose_patch`。没有 `run_command`，模型无法在宿主机上执行任何命令。 |
| **结论必须带证据，且证据会被复核** | system prompt 强制每条关于代码的结论挂 `路径:行号`；回合结束时 `CitationVerifier` 再扫一遍回答，把「文件不存在 / 行号越界」的挑出来，前端标红、可点跳转。「编一个引用」会在界面上露馅，而不是被当成正常输出。 |
| **改之前先摊开影响面** | 补丁卡片在「待确认」状态下显示 blast radius：改了哪些类与成员、谁在调用（可点跳到调用点）、命中哪些高风险特征（Controller / 鉴权 / 支付 / 迁移脚本 / 删除公开方法 / 无测试覆盖）、以及有没有测试。它只提示、不拦人。 |
| **改完必须自证「还能编过」** | 应用补丁后自动用**项目自己的构建方式**（有 `pom.xml` 用 Maven、有 `build.gradle` 用 Gradle，优先用 wrapper）在工作区里跑一次编译。失败时把编译器输出**原样**喂回 Agent 出第二轮补丁。**「没编译」永远显示成「没编译」**，绝不谎报成通过。 |
| **同一套 Agent，两种口吻** | 交付 / 教学只是两个 system prompt 段落 + 一个 UI 开关。它不改工具集、不改安全边界 —— 模式影响「说多少」，不影响「能不能做」。 |
| **模型拿不到编译器参数** | 编译命令与参数全部由服务端拼装（`BuildService`），模型只能提补丁。否则它可以借编译参数做别的事 —— 这与「没有写盘能力」同等重要。 |

---

## 2. 架构

```
浏览器 (React + Vite + Monaco)
  ├── 三栏工作台：文件树 / 编辑器 / 对话
  ├── Monaco：自定义 wca-dark 主题（本地 bundle，不依赖 CDN）
  └── SSE 客户端：fetch + ReadableStream 自己解析（因为要带 Bearer token）
        │
        │  /api/**  （开发期由 Vite 代理，生产由 nginx 反代）
        ▼
Spring Boot 3.5 (Java 21, 虚拟线程)
  ├── security/   JWT 无状态鉴权、BCrypt、不泄露用户名是否存在
  ├── workspace/  路径解析（三层防越界）、文件读写（原子替换）、配额
  │     └── diff/   unified diff 解析 + 应用（上下文逐字符匹配，容忍行号漂移）
  ├── scm/         JGit 浅克隆（depth=1 + 超时）、zip 导入（zip slip / zip bomb 防护）
  ├── agent/       Agent 编排、4 个工具、补丁生命周期、影响面分析、SSE 事件中心
  ├── build/       编译验证（构建工具检测 → 跑构建 → 解析诊断）
  ├── context/     system prompt 组装（项目画像 / 规则文件 / 引用规则 / 当前模式）+ 引用校验
  └── llm/         LangChain4j 流式模型、限流与配额
        │
        ├── PostgreSQL 16（Flyway 管迁移：5 张表）
        └── Redis 7（限流 / 配额，可降级）
                  │
                  ▼
        OpenAI 兼容模型服务（baseUrl + apiKey + model，全走环境变量）
```

---

## 3. 快速开始

### 方式 A：Docker Compose（推荐）

```bash
cd deploy

# 至少填模型信息；不填也能启动，只是对话会提示「模型未配置」
cat > .env <<'EOF'
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_API_KEY=sk-你的Key
LLM_MODEL=deepseek-chat
JWT_SECRET=换成你自己的至少32字符的随机串
EOF

docker compose up --build
```

打开 **http://localhost:5173**。

### 方式 B：本机跑（不用 Docker）

前置：JDK 21、Node 20+、PostgreSQL 16（或 Docker 只跑 PG）。

```bash
# 1. 准备数据库
createdb webcode
# 表结构由 Flyway 自动迁移，不需要手工建表

# 2. 后端
cd backend
export DB_URL="jdbc:postgresql://localhost:5432/webcode"
export DB_USER=webcode DB_PASSWORD=webcode
export JWT_SECRET="dev-only-secret-please-override-with-32-bytes-at-least"
export LLM_BASE_URL="http://127.0.0.1:8787/v1"   # 见下面「没有 API Key 也能自测」
export LLM_API_KEY=mock
export LLM_MODEL=mock-coder
./gradlew bootRun

# 3. 前端（另开一个终端）
cd frontend
npm install
npm run dev
```

打开 **http://localhost:5173**。

### 配置模型

任何 OpenAI 兼容服务都可以（DeepSeek / 通义 / Kimi / vLLM / Ollama / one-api …），只需三件事：

| 环境变量 | 说明 |
| --- | --- |
| `LLM_BASE_URL` | 形如 `https://api.deepseek.com/v1`，**要带 `/v1`** |
| `LLM_API_KEY` | 密钥。只存在后端进程里，永远不会下发到浏览器 |
| `LLM_MODEL` | 模型名，必须支持 function calling（工具调用） |

其余可选：`LLM_TEMPERATURE`、`LLM_MAX_TOKENS`、`LLM_TIMEOUT`、`LLM_HISTORY_MESSAGES`、
`LLM_MAX_TOOL_STEPS`、`LLM_REQUESTS_PER_SECOND`、`LLM_DAILY_TOKEN_LIMIT`。

若模型未配置，页面顶栏会显示黄点「模型未配置」，但文件浏览、编辑、保存全部照常可用。

### 编译验证（可选，默认开）

补丁应用后会自动跑一次编译。它需要工作区里存在构建文件，并且构建工具在 PATH 上：

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `COMPILE_ENABLED` | `true` | 关掉后接口返回 `disabled`（注意：**不是** `ok`） |
| `COMPILE_MVN` / `COMPILE_GRADLE` | `mvn` / `gradle` | 也可写绝对路径，例如 `D:\maven\apache-maven-3.8.2\bin\mvn.cmd` |
| `COMPILE_JAVA_HOME` | 空（继承进程环境） | 必须指向 **JDK 17+**。本机 `JAVA_HOME` 是 JDK 8 时一定要设 |
| `COMPILE_MVN_SETTINGS` | 空 | 需要时传 `-s <file>`，用来覆盖 Maven 全局镜像 |
| `COMPILE_OFFLINE` | `false` | 置 `true` 加 `-o`，只在本地仓库已预热时用 |
| `COMPILE_TIMEOUT` | `PT240S` | 首次构建要下依赖，容易撞上；可调大 |
| `COMPILE_MAX_OUTPUT` | `24000` | 输出只保留**尾部**这么多字符（错误和结论总在末尾） |

找不到构建工具、或者构建工具不在 PATH 上时，接口会返回 `unavailable` 并附上一句人话说明，
**不会**假装编译通过。

> 如果本机 Maven 的全局 `settings.xml` 指向了内网镜像（`mirrorOf=external:*`），在没有内网的
> 环境里所有依赖都下不下来。`tools/maven-self-test-settings.xml` 是一个自测用的覆盖文件：
> 用**同一个 mirror id** 把地址改回 Maven Central（Maven 合并全局与用户 settings 时按 id 去重、
> 用户侧优先），配合 `COMPILE_MVN_SETTINGS` 使用即可。**别带进生产镜像。**

### 没有 API Key 也能自测（内置 Mock 模型）

仓库里带了一个 OpenAI 兼容的 mock 服务，专门用来在离线环境验证
「Agent 循环 → 工具调用 → 出补丁 → 应用」这条链路：

```bash
node tools/mock-llm/server.mjs --port 8787
# 然后后端这样配：
# LLM_BASE_URL=http://127.0.0.1:8787/v1  LLM_API_KEY=mock  LLM_MODEL=mock-coder
```

它会：先 `read_file` 读当前打开的文件 → 若你说「重构」就基于**真实读到的内容**
生成一个能干净应用的 diff → 最后给一句自然语言总结。

几个刻意与真实模型对齐的细节：

- `read_file` 的返回**带行号**（`   42| 代码`），mock 会先把行号剥掉再用内容生成 diff ——
  真实模型靠 prompt 自律「别把行号抄进 diff」，mock 直接剥，避免自检时把行号写进文件；
- 「解释这个类」的回答会挂上**真实行号的引用**（行号是从读到的内容里数出来的），
  顺带把引用 chip、范围引用、点击跳转都覆盖到；
- `MOCK_LLM_FAKE_CITATION=1` 会让回答额外塞一条指向不存在文件的引用，
  用来确认「引用存疑」的红色标记确实会出现。

**它只用于开发自测，不要在任何真实环境里用它冒充模型。**

---

## 4. 演示步骤（自测清单）

按顺序走一遍，每一步都写清了「应该看到什么」。这也正是 `tools/e2e-smoke.mjs` 自动跑的那条路径。

**1｜注册并创建工作区**
打开首页 → 「一键随机演示账号」或自己注册 → 进入工作区列表 → 点 **内置示例（最快）** → 创建工作区。

> 预期：进入三栏 IDE，左侧文件树已自动展开到 `src/main/java/com/demo/UserService.java`。

**2｜打开文件，确认上下文注入**
点开 `UserService.java`。

> 预期：中间 Monaco 显示代码，顶部面包屑出现文件名；右侧输入框上方出现 `当前文件 · UserService.java` 标签。
> 打开的是**真实的文件内容**（里面有 `@Autowired private UserRepository userRepository;`）。

**3｜让它解释代码（先读再答）**
在右侧问：`解释一下这个类` → Ctrl/⌘ + Enter 发送。

> 预期：对话区先出现一张青色的**工具卡片「读取文件」**（带路径），
> 然后文字**逐字流式**出现。回答里应该准确说出 `register` / `getById` / `countActive` 这些真实方法名。
> 底部状态栏右侧的圆点是绿色「事件流 已连接」。

**4｜让它改代码（关键一步）**
选中 `@Autowired ... userRepository;` 那两行，然后问：
`把这个类里的字段注入改成构造器注入，并移除不再需要的 Autowired 导入。`

> 预期：出现工具卡片「读取文件」→「生成补丁」，然后对话里弹出一张**紫色的补丁卡片**，
> 上面直接摊开了 diff 预览和 `+x / -y` 统计。
> 此时**磁盘上什么都没变** —— 这正是设计意图。

**5｜查看完整对比并应用**
点补丁卡片上的「完整对比」→ 全屏 diff 视图，左边是磁盘现状、右边是应用后的结果。
点 **应用并写盘**。

> 预期：提示「补丁已应用」；编辑器自动重新加载，`@Autowired` 消失、
> 变成了 `private final UserRepository userRepository;` + 一个构造器；
> 补丁卡片状态变成绿色的「已应用」；「应用并写盘」按钮消失。
> 再点一次也不会重复生效（后端用 CAS 保证幂等）。
> 也可以自己去磁盘上打开那个文件确认 —— 它是真的被改了。

**6｜验证持久化与隔离**
刷新整个页面。

> 预期：文件树、对话历史、补丁状态全部还在（都在 PostgreSQL 里）。
> 顶栏的「待确认补丁」计数只在有 pending 补丁时出现。
> 顺手试一下越界：在浏览器地址栏访问
> `http://localhost:8080/api/workspaces/1/files?path=../../../etc/passwd`
> 会拿到 `PATH_ESCAPE` 错误，而不是文件内容。

**7｜每个结论都能点开核对（引用）**
问 `解释一下这个类`。

> 预期：回答里凡涉及具体代码的句子末尾都挂着 `src/main/java/com/demo/UserService.java:23`
> 这样的**青色 chip**。点一下，编辑器会滚到那一行并短暂高亮（左侧留一条琥珀色标线）。
> 回答上方还会显示「引用 6」这样的计数 —— 它是后端**校验过**的条数，不是模型自己报的。
> 用 `MOCK_LLM_FAKE_CITATION=1` 起 mock 时，还会出现一条**红色划掉**的引用，
> 并显示「1 处引用存疑」；把鼠标放上去会说明原因（文件不存在 / 行号越界）。

**8｜改之前先看影响面（风险条）**
选中 `@Autowired` 那两行，问 `把这个类改成构造器注入`。

> 预期：补丁卡片在 diff 预览下面多出一条**风险条**，内容包括：
> 风险等级（左侧色带：玫红=高 / 琥珀=中）、一句话结论、「+x / -y」、
> 命中风险的 chip（例如「构造器签名变更」）、`N 处引用` 可展开成**可点的调用点列表**、
> 以及 `N 个测试文件覆盖` 或 `没有测试覆盖`。
> 展开「引用」后，每条都是一个 `文件:行号` 按钮，点一下同样跳到编辑器对应行。

**9｜应用后自动编译（编译闭环）**
点卡片上的 **应用并写盘**。

> 预期：补丁状态变绿之后，卡片立刻出现一条「正在沙箱里编译…」，随后变成结果条：
> - `编译通过 · maven · 12.3 s`（青柠色）；
> - 或 `编译失败 · N 条诊断`，每条诊断都是一个可点按钮，点一下跳到出错那一行，
>   右侧还有 **让 AI 修复** —— 它会把编译器原始输出整段喂回 Agent，要第二轮补丁；
> - 或 `未执行编译（工作区里没找到可用的构建工具）`（琥珀色）；找不到 `mvn`、工作区里
>   没有构建文件、或 `COMPILE_ENABLED=false` 时都是这个状态。
> **这几种状态在 UI 上是分开的** —— 一个谎报成功的检查比没有检查更糟。

**10｜切换交付 / 教学模式**
点输入框上方的「交付 / 教学」开关。

> 预期：即时切换，并写进 `localStorage`（刷新后仍是教学）。教学模式下的回答会先说明
> 「为什么读这个文件」，讲清改法的取舍与风险；交付模式则直接给结果 + 一段可粘进 commit 的
> 提交说明。两种模式都仍然遵守引用规则。

### 自动跑一遍（不用开浏览器）

```bash
node tools/e2e-smoke.mjs
# 或
BASE_URL=http://127.0.0.1:8080 node tools/e2e-smoke.mjs
```

它会依次验证：健康检查 → 注册 → 建工作区 → 读文件树 → 读文件基线 → **越界防护** →
建会话 → 开 SSE → 发消息 → 等 patch 事件 → 应用补丁 → **回头读文件确认内容真的变了** →
重复应用被拒 → 会话历史与补丁列表已持久化。退出码 0 = 全绿。

### 真开浏览器跑一遍（UI 自检）

`tools/e2e-smoke.mjs` 只打接口，看不到界面。要在真浏览器里把演示步骤点一遍并留截图：

```bash
# 需要先起好后端(8080)、前端(5173)、mock 模型(8787)
node tools/ui-probe.mjs tools/ui-steps/09-demo-final-wide.json docs/self-test/ui-log-final.txt
# 后半段（出补丁 → 应用 → 刷新验证）单独一个批次
node tools/ui-probe.mjs tools/ui-steps/11-demo-tail-wide.json  docs/self-test/ui-log-final-tail.txt
# 证据层（引用 chip / 风险条 / 编译闭环 / 双模式）单独一批，产出在 docs/self-test/v2/
node tools/ui-probe.mjs tools/ui-steps/12-evidence-features.json docs/self-test/ui-log-evidence.txt
```

> 上面这批会**真的触发一次 Maven 编译**。第一次跑之前建议先预热本地仓库，否则
> 「正在编译…」会停好几分钟（`COMPILE_TIMEOUT` 默认 240 秒，容易撞上）。
> 把内置示例复制到**工作区之外**的临时目录跑一次即可（别在 `samples/` 里跑，
> 否则 `target/` 会被打进后端 jar）：
>
> ```bash
> cp -r backend/src/main/resources/samples/demo-java /tmp/warm-demo
> cd /tmp/warm-demo
> mvn -B -s "$OLDPWD/tools/maven-self-test-settings.xml" compile
> ```

> 拆成两批不是偷懒：浏览器 daemon 中途被回收时会整页变成 `about:blank`，
> 一批越长越容易撞上。短批次 + 每步断言，失败了也好定位。

`ui-probe.mjs` 是一个很薄的驱动：读一份 **JSON 步骤文件**（`[["click", ".btn"], {"sleep": 2000}]`），
在**同一个 Node 进程**里顺序调用 agent-browser，把每一步的输出和截图落到 `docs/self-test/`。

> 为什么不用「一条命令一次调用」：浏览器 daemon 在每次进程结束后会被回收，
> 于是 `open` 完再 `screenshot` 只会拿到 `about:blank`。一整批命令必须活在一个进程里。

产出的截图（`docs/self-test/`，1512×950）：

| 文件 | 对应演示步骤 |
| --- | --- |
| `01-login.png` | 登录页（左说明 / 右表单） |
| `02-workspaces.png` | 选择工作区 + 三个创建入口 |
| `03-ide.png` | 进入三栏 IDE，文件树已展开到 `src/main/java/com/demo/` |
| `04-file-open.png` | 打开 `UserService.java`，右下角出现「当前文件 · UserService.java」 |
| `05-toolcard.png` | 回合进行中：青色的「读取文件」工具卡片 |
| `06-explain.png` | 「解释一下这个类」的流式回答 |
| `07-patch-pending.png` | **关键状态**：补丁卡片「待确认」，编辑器里 `@Autowired` 还在（磁盘未动） |
| `08-diff-modal.png` | 全屏 DiffEditor：左=磁盘现状，右=应用后结果 |
| `09-applied.png` | 应用后：编辑器里已变成 `private final` + 构造器 |
| `10-persisted-after-reload.png` | 刷新整页后：文件树 / 对话 / 补丁状态（已应用）全都还在 |
| `11-workspace-list.png` | 工作区列表（已有工作区） |

证据层那一批（`12-evidence-features.json`）落在 `docs/self-test/v2/`：

| 文件 | 对应演示步骤 |
| --- | --- |
| `01-context.png` | 打开文件后，输入框上方出现「当前文件 · UserService.java」 |
| `02-mode-deliver.png` | 交付 / 教学开关，默认停在「交付」 |
| `03-citations.png` | **关键状态**：回答里的 `路径:行号` 渲染成青色 chip，消息头显示「引用 N」 |
| `04-citation-jump.png` | 点引用后编辑器滚到目标行并高亮（`.cite-line`） |
| `05-blast-radius.png` | **关键状态**：待确认补丁卡片上的风险条（等级 + 命中风险 + 测试覆盖） |
| `06-callers.png` | 展开「N 处引用」，每条都是可点的调用点 |
| `07-compiling.png` | 应用后自动编译中 |
| `08-compile-result.png` | **关键状态**：编译结果条（通过 / 失败 / 未执行，三种状态分开） |
| `09-mode-teach.png` | 切到教学模式，占位提示语同步变化 |
| `10-after-reload.png` | 刷新后：模式、引用 chip、消息头计数都还在 |

`05-toolcard.png` 那一瞬间在默认 mock 下只有几百毫秒，想稳定复现可以给 mock 加节流：

```bash
MOCK_LLM_STEP_DELAY_MS=2500 node tools/mock-llm/server.mjs --port 8787
```

---

## 5. 接口一览

所有接口都在 `/api` 下，除注册登录外都需要 `Authorization: Bearer <token>`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/health` | 模型是否配置、检索引擎、Redis 是否可用 |
| `POST` | `/auth/register` / `/auth/login` | 返回 `{ userId, username, token }` |
| `GET` | `/workspaces` | 当前用户的工作区列表 |
| `POST` | `/workspaces` | `{ name?, gitUrl }` 克隆，或 `{ sample: true }` 用内置示例 |
| `POST` | `/workspaces` | `multipart/form-data` + `file` 上传 zip |
| `GET` | `/workspaces/{id}/tree` | 完整文件树（受条目上限保护） |
| `GET` | `/workspaces/{id}/files?path=` | 读文件（超限截断并标记） |
| `PUT` | `/workspaces/{id}/files?path=` | 保存文件 |
| `POST` | `/workspaces/{id}/entries` | 新建文件或目录 `{ path, type }` |
| `DELETE` | `/workspaces/{id}/files?path=` | 删除文件或目录 |
| `POST` | `/chat/sessions` | 新建会话 |
| `GET` | `/chat/sessions?workspaceId=` | 会话列表 |
| `GET` | `/chat/sessions/{sid}/messages` | 消息历史 |
| `POST` | `/chat/sessions/{sid}/messages` | **发消息，立刻返回 202 + messageId** |
| `GET` | `/chat/sessions/{sid}/events` | **SSE 事件流**，支持 `?afterId=` 断线回放 |
| `GET` | `/chat/sessions/{sid}/patches` | 本会话的补丁列表 |
| `POST` | `/patches/{patchId}/apply` | 应用补丁（唯一会写盘的入口） |
| `POST` | `/patches/{patchId}/reject` | 丢弃补丁（磁盘不动） |
| `GET` | `/patches/{patchId}/blast-radius` | **影响面**：改了哪些类/成员、谁在调用、命中哪些风险、有没有测试。纯只读，不依赖补丁状态 |
| `POST` | `/patches/{patchId}/compile` | **编译验证**。补丁未应用时返回 `disabled`；无构建工具返回 `unavailable` |

### SSE 事件协议

每帧都是 `data: {json}`，其中 `seq` 在会话内单调递增（重连时把它当 `afterId` 传回来即可补齐）：

```
data: {"seq":12,"type":"text","delta":"这个类"}
data: {"seq":13,"type":"tool_call","name":"read_file","args":{"path":"src/main/java/com/demo/UserService.java"}}
data: {"seq":14,"type":"tool_result","name":"read_file","ok":true,"summary":"74 行 / 2.1 KB"}
data: {"seq":15,"type":"patch","id":"8f14e45f-...","file":"src/main/java/com/demo/UserService.java","diff":"--- a/...\n+++ b/..."}
data: {"seq":16,"type":"citations","items":[{"file":"src/main/java/com/demo/UserService.java","line":23,"endLine":25,"valid":true,"reason":null}]}
data: {"seq":17,"type":"error","message":"模型服务限流（429），请稍后再试。"}
data: {"seq":18,"type":"done","messageId":"1234"}
```

> `citations` 在 `done` **之前**发，内容与落库到 `meta.citations` 的完全一致 ——
> 前端渲染引用 chip 时不需要再取一次消息，也就不会出现「先渲染成黑色、再跳成红色」的闪烁。
> `seq` 刻意不叫 `id`：`patch` 事件的 `id` 按约定是补丁 uuid，两者同名会互相覆盖。

---

## 6. 数据模型

由 Flyway 迁移（`backend/src/main/resources/db/migration/V1__init.sql`）：

| 表 | 作用 | 关键点 |
| --- | --- | --- |
| `users` | 账号 | BCrypt 哈希 |
| `workspaces` | 工作区 | 存磁盘 `root_path`；接口层**不下发**这个字段 |
| `chat_sessions` | 会话 | 外键到工作区 |
| `chat_messages` | 消息 | `meta` 存模型名、token 用量、本轮补丁 id 列表 |
| `patches` | 补丁 | `status` 用带条件的 UPDATE 做 CAS，保证只被应用/拒绝一次 |

---

## 7. 安全设计

| 面 | 做法 |
| --- | --- |
| 路径越界 | `WorkspacePathResolver` 三层校验：形式校验（拒绝 `..`、绝对路径、盘符）→ 词法归一化 → 真实路径校验（解析符号链接后必须仍在工作区内）。所有文件操作都必须经过它。 |
| 越权访问 | 每个资源查询都带 `userId`（`findOwned`），查不到一律 404，不泄露「存在但不属于你」。 |
| 密钥 | LLM Key 只存在后端环境变量；`WorkspaceView` 不含 `root_path`；日志不打印 Key。 |
| 上传 | zip slip（禁止 `..` 与绝对路径）、zip bomb（限制条目数与解压总量）、拒绝符号链接。 |
| 克隆 | 只允许 http/https/git/ssh，拒绝 `file://`；depth=1 浅克隆 + 超时，失败即清理目录。 |
| 配额 | 按工作区总量算（默认 200 MB），写入前预检。 |
| 放大攻击 | 工具结果有上限（grep 条数、read 字节数、list_dir 条目数），避免一次工具调用撑爆上下文。 |
| 越权写盘 | 补丁在生成时与应用时**各校验一次**，且应用时按「补丁 → 会话 → 工作区」重新解析归属，防止 TOCTOU 与参数传错。 |
| CORS | 白名单，默认只放行 `localhost:5173`。 |

---

## 8. 已知限制

- **一轮对话内无法硬中断**：LangChain4j 的流式接口没有暴露中断点。所以用「工具调用次数上限」
  （默认 12 次）来收敛：超限后工具会返回「请立即给出最终回答」，模型通常会停止。这不是硬保证。
- **大文件不能整文件保存**：超过 512 KB 的文件只读。改这类文件目前只能靠补丁（上限 8 MB）。
- **补丁一次只改一个文件**：多文件修改需要多次 `propose_patch`，用户逐个确认。这是刻意选择 —— 批量应用会让 diff 评审失效。
- **grep 优先用 ripgrep，没有就退回 Java 实现**：后者在超大仓库上明显更慢。
- **Redis 降级后限流是单实例的**：多副本部署时必须让 Redis 可用。
- **没有 LSP**：Monaco 只做语法着色，没有跳转/诊断/补全语义能力（属于 V2）。
- **SSE 事件缓冲在内存里**：进程重启后，断线期间未落库的事件会丢（已落库的消息不受影响）。
- **编译验证不是沙箱**：它带着服务进程的身份、在工作区目录里跑项目自己的 `mvn compile` / `gradle compileJava`。
  防的是「模型乱写代码」，不是「恶意构建脚本」。真正的隔离在 V2 的每用户 Docker 沙箱里。
- **引用校验只查「文件在不在、行号越没越界」**：它无法判断第 23 行到底是不是那个方法。所以
  红色代表「这条引用一定有问题」，青色只代表「这条引用值得点开看看」。
- **风险条是启发式的**：用正则从 diff 里抽成员名、用 grep 找调用方。改名、反射、跨语言调用
  都可能漏；等级也只是按特征打分。它的定位是「帮你别漏看」，不是「保证安全」。
- **一轮对话不会因为「编辑了文件」而失效**：补丁应用后，历史消息里那些引用仍然指向应用**之前**
  的行号。要拿到最新行号需要重新提问 —— 这是刻意不做「自动重算」的，因为静默改写历史回答
  比让它过时更糟。

---

## 9. V2 TODO

- [ ] **每用户 Docker 沙箱** + `run_command` 工具 + xterm.js 终端（设计见 `deploy/sandbox/README.md`）
- [ ] pgvector 做代码库语义检索（现在只有正则 grep）
- [ ] Java LSP 接入（跳转、诊断、补全）
- [ ] 多文件 Agent 自动改（一次产出多个补丁，批量评审）
- [ ] `.coding-rules.md` 之外，支持每工作区的 profile / 系统提示词覆盖
- [ ] 工作区快照与回滚（应用补丁前自动打点）

---

## 10. 目录结构

```
web-code-assistant/
├── backend/                       Spring Boot 后端
│   ├── src/main/java/com/webcode/assistant/
│   │   ├── agent/                 Agent 编排、4 个工具、补丁生命周期、影响面分析、SSE 事件中心
│   │   ├── api/                   REST 控制器与请求/响应模型
│   │   ├── build/                 编译验证（构建工具检测、诊断解析、超时与输出裁剪）
│   │   ├── common/                错误码与统一异常处理
│   │   ├── config/                配置属性、线程池、启动检查
│   │   ├── context/               system prompt 组装（引用规则 / 双模式）+ 引用校验
│   │   ├── llm/                   LangChain4j 模型 + 限流配额
│   │   ├── scm/                   Git 克隆、zip 导入、内置示例
│   │   ├── security/              JWT 鉴权
│   │   └── workspace/             路径解析、文件读写、diff 解析与应用
│   └── src/main/resources/
│       ├── db/migration/          Flyway SQL
│       └── samples/demo-java/     内置演示项目（带一个待重构点）
├── frontend/                      React + Vite 前端
│   └── src/
│       ├── components/            文件树 / 编辑器 / 对话 / 补丁卡片 / 差异弹层 …
│       ├── lib/                   API 客户端、SSE 客户端、diff 工具、Monaco 主题
│       ├── pages/                 登录 / 工作区列表 / IDE
│       └── styles/global.css      Web Code Assistant 设计系统（CSS 变量）
├── deploy/
│   ├── docker-compose.yml         全栈一键起
│   └── sandbox/                   V2 沙箱设计（未实现）
├── docs/self-test/                演示截图 + 自检日志（跑 ui-probe 产出）
└── tools/
    ├── mock-llm/server.mjs        OpenAI 兼容 mock 模型，离线自测用（带行号剥离 + 真实行号引用）
    ├── e2e-smoke.mjs              接口层端到端自测（29 项断言）
    ├── ui-probe.mjs               浏览器自检驱动（按 JSON 步骤跑 agent-browser）
    ├── maven-self-test-settings.xml  自测用 Maven settings（把内网镜像换回 Central）
    └── ui-steps/                  自检步骤定义（*.json）
```

---

## 11. 一句话总结

这套东西的价值不在于「接了个模型」，而在于**边界**：
模型读不到的东西真的读不到（路径三层校验），模型改不了的东西真的改不了（工具集里没有写盘能力），
用户没确认的改动真的不会落盘（补丁必须由人点应用）。
