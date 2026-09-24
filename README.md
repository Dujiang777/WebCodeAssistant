# Web Code Assistant · 网页版编码助手

一个跑在浏览器里的轻量级 coding 助手：**左边文件树、中间 Monaco、右边 AI 对话**。
AI 能读你的项目、能按正则搜代码，但**它没有任何写盘权限** —— 它只能产出 unified diff，
你在对比视图里点「应用」，文件才会真的被改写。

在此之上，它把「凭什么信它」这件事做成了可见的东西：

- **每个结论都能点开核对**：回答里的 `路径:行号` 是可点的证据 chip，编造的引用会被后端校验标红；
- **改之前先看影响面**：补丁卡片会算出「改了哪些类、谁在调用、有没有碰鉴权代码、有没有测试」；
- **改之前先预演 PR**：同一张补丁卡片能展开「假如这是真实 PR」——标题、分支建议、审查清单（含仓库宪法条款），应用之前就能看到审查者会揪住什么；
- **改完自证还能编过**：应用补丁后自动跑一次项目自己的编译，失败就把编译器输出喂回去重改；
- **测试失败驱动改代码**：一键在工作区里跑测试套件，失败用例（或测试代码的编译诊断）逐条列出，一键交给 AI 出最小修复补丁；
- **仓库宪法**：`.wca/CONSTITUTION.md` 是最高优先级的硬规则，注入 system prompt 并进入 PR 审查清单——Agent 只能遵守，不能修改；
- **Spring 地图**：扫描工作区里的 Bean / HTTP 端点 / 依赖注入关系，回答「有哪些接口、谁在注入谁」；
- **同一套 Agent 两种口吻**：交付模式少说话给结果，教学模式讲清动机与取舍；
- **账号是真账号，不是演示账号**：双令牌（access 2h 不落库 / refresh 30 天只存哈希、可撤销可轮换）、
  邮箱验证、找回密码、连续失败锁定、登录设备列表（能看到设备 / IP / 时间并逐个踢掉）、防账号枚举；
- **AI 用量按积分计费**：每轮对话先预扣、按真实 token 多退少补，`credit_ledger` 只增不改、
  余额永远能由账本重算出来，超支返回 `402` 而不是悄悄扣成负数；
- **积分中心是自助的**：余额 / 套餐 / 下单 / 支付 / 流水 / 一键对账全在一个页面，
  支付走幂等回调（重试不会重复到账），对账按钮当场把「账本累加值」和「账户余额」摆在一起给你比。

工作区是**服务器磁盘上的真实目录**（`git clone` 或 zip 导入），不是浏览器里的虚拟文件系统。

### 视觉设计：「Darkroom Brass」（暗房黄铜 · 温润版）

界面刻意长成**一间暗房**，而不是「又一个深色 SaaS」：

- **底色**是暖调近黑五级（`#0b0a08` 起），整页铺 44px 发丝网格（暖白 `rgba(240,232,214,.03)`）——
  像相纸上还没显影的纹理，空态里也不死黑；
- **唯一主角是黄铜金 `#e8b45a`**：品牌铭牌、主按钮、引用 chip、焦点环、logo 都是它。
  文字用象牙暖白（`#f5f1e8` 起）而不是纯白 —— 纯白配黄铜会显得廉价。
  语义配角各司其职且**绝不与主金混淆**：警告用深橙 `#ff8c42`，删除用玫红 `#ff5163`，补丁/类型用紫罗兰 `#b48cff`；
- **12px 圆角 + 胶囊按钮 + 柔和投影**：这是「温润」的来源。测过一版零圆角直角风，观感是「方方正正太丑」，已废弃；
- **对话区是「黑底稿纸 × 纸片」**：用户消息 = 象牙纸块 + 硬边金投影（像便签贴在稿纸上），
  AI 消息 = 无框编辑排版 + 金铭牌头；引用 chip 做成**金底线脚注**的样子，不抢正文；
- **工作台是工具轨道，不是按钮墙**：16 个能力收进左侧一条竖排图标轨道（`ToolRail`），
  按性质分三组 ——「对仓库做事 / 看 AI 做事 / 调布局」，组间用分隔线断开。
  **悬停飘出两行卡片**：中文名 + 一句话「什么时候该用它」。顶栏控件因此从 12 个降到 4 个。
  只飘名字不算解决问题 —— 用户要的是「看不出该点哪个」这件事被解决；
- Monaco 主题 `wca-dark` 与外壳取**同一套 CSS 变量值**，编辑器和外壳不会像两个产品拼起来。

> 类名是**自检契约**：自检脚本按 `title` 文案和类名找元素。改样式可以，改类名会让断言失效。

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
| **四个只读/产出补丁的工具 + 两个只读自查工具** | `list_dir` / `read_file` / `grep` / `propose_patch`，加上 `run_tests`（跑测试，参数服务端拼死）与 `spring_map`（扫组件地图）。没有 `run_command`，模型无法在宿主机上执行任何命令。 |
| **结论必须带证据，且证据会被复核** | system prompt 强制每条关于代码的结论挂 `路径:行号`；回合结束时 `CitationVerifier` 再扫一遍回答，把「文件不存在 / 行号越界」的挑出来，前端标红、可点跳转。「编一个引用」会在界面上露馅，而不是被当成正常输出。 |
| **改之前先摊开影响面** | 补丁卡片在「待确认」状态下显示 blast radius：改了哪些类与成员、谁在调用（可点跳到调用点）、命中哪些高风险特征（Controller / 鉴权 / 支付 / 迁移脚本 / 删除公开方法 / 无测试覆盖）、以及有没有测试。它只提示、不拦人。 |
| **改完必须自证「还能编过」** | 应用补丁后自动用**项目自己的构建方式**（有 `pom.xml` 用 Maven、有 `build.gradle` 用 Gradle，优先用 wrapper）在工作区里跑一次编译。失败时把编译器输出**原样**喂回 Agent 出第二轮补丁。**「没编译」永远显示成「没编译」**，绝不谎报成通过。 |
| **同一套 Agent，两种口吻** | 交付 / 教学只是两个 system prompt 段落 + 一个 UI 开关。它不改工具集、不改安全边界 —— 模式影响「说多少」，不影响「能不能做」。 |
| **模型拿不到编译器参数** | 编译命令与参数全部由服务端拼装（`BuildService`），模型只能提补丁。`run_tests` 同理：模型能触发测试，但选不了 goal、塞不进自定义参数。 |
| **仓库宪法只对模型生效，且模型改不了** | `.wca/CONSTITUTION.md` 由用户在 UI 里写 / 存 / 撤回，`ContextAssembler` 每轮把它注入 system prompt 顶部（最高优先级段）。工具集里没有写它的方法，Agent 想改也没有入口；置空保存即撤回。 |
| **PR 预演是纯派生的只读视图** | 从已生成的 diff 派生标题 / 分支建议 / 审查清单（含宪法条款是否就位），不落库、不影响补丁状态 —— 它帮你判断「要不要应用」，不产生任何写副作用。 |
| **「测试失败」包括「测试编译不过」** | `runTests` 在 surefire 没跑（totals 为空）但退出码非 0 时，会把测试代码的**编译诊断**解析成结构化 `issues` —— 补丁改了主代码签名、测试没跟上是最高频的真实场景，此时该修的是编译错误而不是断言。 |

---

## 2. 架构

```
浏览器 (React + Vite + Monaco)
  ├── 工作台：工具轨道（16 个能力，按性质分三组）+ 三栏：文件树 / 编辑器 / 对话
  ├── 二级页：积分中心 / 账号与安全 / 邮箱验证 / 重置密码
  ├── 会话层：双令牌（access 内存 + refresh 落盘），401 自动静默刷新（单例 Promise 防并发）
  ├── Monaco：自定义 wca-dark 主题（本地 bundle，不依赖 CDN）
  └── SSE 客户端：fetch + ReadableStream 自己解析（因为要带 Bearer token，且令牌要动态取）
        │
        │  /api/**  （开发期由 Vite 代理，生产由 nginx 反代）
        ▼
Spring Boot 3.5 (Java 21, 虚拟线程)
  ├── security/   双令牌鉴权（refresh 轮换 + 重放检测）、BCrypt、失败锁定、登录审计、防账号枚举
  ├── credit/     积分账户 / 只增账本 / 定价 / 套餐 / 订单 / 支付提供方（mock 可替换 → 真实网关）
  ├── mail/       邮件通道（dev 不发信 + smtp 真发），承载邮箱验证与找回密码
  ├── workspace/  路径解析（三层防越界）、文件读写（原子替换）、配额、快照与回滚
  │     └── diff/   unified diff 解析 + 应用（上下文逐字符匹配，容忍行号漂移）
  ├── scm/         JGit 浅克隆（depth=1 + 超时）、zip 导入（zip slip / zip bomb 防护）
  ├── agent/       Agent 编排、工具集（含工具级闸门）、补丁生命周期、工位状态、影响面、PR 预演、SSE 事件中心
  ├── build/       编译验证 + 测试运行（构建工具检测 → 跑构建 → 解析诊断 / 失败用例 / 编译诊断）
  ├── terminal/    网页终端（受控 run_command，模型没有任何命令执行工具）
  ├── semantic/    语义检索（切块 + embedding + 向量检索，与正则 grep 互补）
  ├── constitution/ 仓库宪法（.wca/CONSTITUTION.md 读写 + 模板）
  ├── map/         Spring 组件地图（Bean / 端点 / 依赖注入扫描）
  ├── context/     system prompt 组装（项目画像 / 规则文件 / 引用规则 / 当前模式）+ 引用校验
  └── llm/         LangChain4j 流式模型、限流与配额、对话与 embedding 可分源
        │
        ├── MySQL 8（Flyway 管迁移：V1→V5，14 张表）
        └── Redis 7（限流 / 配额，可降级）
                  │
                  ▼
        OpenAI 兼容模型服务（baseUrl + apiKey + model，全走环境变量）
        embedding 可另指一个服务（DeepSeek 官方没有 /v1/embeddings）
```

**计费链路（每轮对话）**

```
POST /messages ─► 余额闸门（不足 → 402）
                    └─► HOLD −30       预扣，写 credit_ledger
                          └─► Agent 流式输出（工具调用可被闸门拦下等人审批）
                                └─► SETTLE ±N   按真实 token 多退少补
                                      └─► 失败时 RELEASE +30  全额退回
```

---

## 3. 快速开始

### 方式 A：Docker Compose（推荐）

```bash
cd deploy

# 仓库根目录的 .env.example 是完整的部署说明书（每一行都写了为什么要有它）。
# 先把它拷过来，然后至少填掉三项「不改就是事故」：DB_PASSWORD / JWT_SECRET / LLM_*
cp ../.env.example .env
#   LLM_BASE_URL=https://api.deepseek.com/v1
#   LLM_API_KEY=sk-你的Key
#   LLM_MODEL=deepseek-chat          # 或你的服务商实际给出的模型名
#   JWT_SECRET=换成你自己的至少32字符的随机串
#   DB_PASSWORD=换成你自己的强密码
#   FRONTEND_BASE_URL=https://你的域名   # 改晚了用户收到的验证链接会指向 localhost

docker compose up --build
```

打开 **http://localhost:5173**。

> 不填模型信息也能启动，只是对话会提示「模型未配置」——文件浏览与编辑仍完全可用。

### 方式 B：本机跑（不用 Docker）

前置：JDK 21、Node 20+、MySQL 8.0.13+（或 Docker 只跑 MySQL）。

```bash
# 1. 准备数据库（表结构由 Flyway 自动迁移，不需要手工建表）
mysql -h 127.0.0.1 -P 3306 -u root -p \
  -e "create database if not exists webcode character set utf8mb4 collate utf8mb4_0900_ai_ci;"

# 2. 后端
cd backend
export DB_URL="jdbc:mysql://127.0.0.1:3306/webcode?useUnicode=true&characterEncoding=UTF-8&useSSL=false&allowPublicKeyRetrieval=true&connectionTimeZone=%2B08:00&forceConnectionTimeZoneToSession=true"
export DB_USER=root DB_PASSWORD=你的密码
export JWT_SECRET="dev-only-secret-please-override-with-32-bytes-at-least"
export LLM_BASE_URL="http://127.0.0.1:8787/v1"   # 见下面「没有 API Key 也能自测」
export LLM_API_KEY=mock
export LLM_MODEL=mock-coder

# 账号体系：本地造一个管理员，省得手工改库（这个名字在注册那一刻自动获得 ADMIN 角色）
export ADMIN_USERNAMES=admin
# 邮件通道：dev 模式不发真邮件，令牌落库 + 写日志 + 接口回显，离线能跑通整条验证链路
export MAIL_MODE=dev

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

**语义检索要单独配 embedding**，因为对话服务不一定提供 `/v1/embeddings`
（DeepSeek 官方就没有）。三项留空即复用上面的对话配置：

| 环境变量 | 说明 |
| --- | --- |
| `LLM_EMBED_BASE_URL` | embedding 服务地址。留空 = 用 `LLM_BASE_URL` |
| `LLM_EMBED_API_KEY` | 留空 = 用 `LLM_API_KEY` |
| `LLM_EMBED_MODEL` | embedding 模型名。**留空 = 语义检索不可用**（`/semantic/status` 返回 `available: false`） |

交付态常见组合是「对话接 DeepSeek + embedding 接本地或别家」。自测时可以让 mock 出 embedding：
`LLM_EMBED_BASE_URL=http://127.0.0.1:8787/v1` + `LLM_EMBED_API_KEY=mock` + `LLM_EMBED_MODEL=mock-embed`。

若模型未配置，页面顶栏会显示黄点「模型未配置」，但文件浏览、编辑、保存全部照常可用。

> **完整的变量清单在仓库根目录的 `.env.example`**，每一行都写了「为什么要有它」。
> 下面只列自测与编译相关的部分。

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

> 预期：文件树、对话历史、补丁状态全部还在（都在 MySQL 里）。
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

**11｜仓库宪法（顶栏「宪法」）**
点顶栏 **宪法** → 编辑器里是模板（一例：一律构造器注入、禁止字段 `@Autowired`）→ 保存。

> 预期：顶栏按钮的「未配置」态消失；之后每轮对话它都注入 system prompt 顶部，
> Agent 的回答与补丁会遵守这些条款。置空保存 = 撤回，文件从磁盘删除。

**12｜Spring 组件地图（顶栏「地图」）**
点顶栏 **地图**。

> 预期：面板按 CONTROLLER / SERVICE / REPOSITORY 分组列出 Bean，每个 Controller
> 挂着拼好类级前缀的 HTTP 端点（`GET /api/users` …），Service 到 Repository 的
> 构造器注入关系以边的形式呈现，点 Bean 可跳到源码行。

**13｜测试运行（顶栏「测试」）**
点顶栏 **测试**。

> 预期：自动在工作区里跑项目自己的测试命令，结果条区分 `测试通过 / 测试失败 / 超时 / 未执行`。
> 失败时逐条列出失败用例（类.方法:行号 + 断言原文）；若是测试代码**编译不过**
> （比如上面的补丁改了构造器、测试还没跟上），则列出编译诊断并说明「先修编译错误」。
> 每条都可 **让 AI 修复** —— 把失败信息组装成一条聊天消息走补丁闭环。

**14｜变更预演 PR（补丁卡片内）**
让 AI 出一个补丁（待确认状态），在补丁卡片里展开 **变更 PR 预演**。

> 预期：给出 PR 标题（`patch: 变更 UserService +18 / -16`）、建议分支名（`patch/userservice`）、
> 变更内容小节、以及一份审查清单 —— 调用覆盖 / 循环复杂度 / 仓库宪法是否就位，每项 PASS/WARN/NONE。
> 它是纯派生视图：不落库、不改变补丁状态，只帮你决定「要不要应用」。

**15｜账号与安全（顶栏「账号与安全」）**

> 预期：三张卡片 ——
> **身份信息**：用户名 / 邮箱 / 邮箱验证状态（`已验证` / `未验证` 徽标）/ 角色；
> **修改密码**：改完**其他设备的 refresh token 全部作废、当前设备继续可用**；
> **登录设备**：逐条列出设备（`Chrome · Windows`）、IP、登录时间、令牌到期时间，每条可**注销**。
> 邮箱没验证时，卡片上方会有一条可点「重新发送」的横幅（带 60 秒冷却）。

**16｜积分中心（顶栏积分徽标）**

> 预期：进页面先看到**余额大字**，下面是四项统计（累计获得 / 累计消耗 / 单轮预扣 / 注册赠送）
> 和一行计价说明（每 1000 输入 token 1 分、输出 3 分、单轮最低 1 分）。
> 往下是**套餐卡片**（体验包 ¥9 / 1000 分、开发者包 ¥49 / 6600 分「最受欢迎」、团队包 ¥199 / 30000 分），
> 每张都标了「约 ¥x / 千分」方便横向比价。
> 点「立即充值」→ 收银台弹层（4 格明细）→「模拟支付成功」→ 提示「支付成功，6600 积分已到账」。
>
> **回到 IDE 发一条消息**，再看流水：一轮对话会留下**两行** ——
> `对话预扣 −30` 与 `按用量结算 +27`，**净额 3 分才是实际花费**。
> 页面上专门写了这句话，因为不说清楚很容易被读成扣了两次钱。
> 最后点 **一键对账** —— 当场比对「账本累加值」与「账户余额」，两者必须一致。
>
> 所有时间列都是**本地时区**。后端返回 UTC，如果哪里直接对字符串做 `slice`，
> 你会看到每一笔都差 8 小时 —— 而这种偏差最容易被误当成「账本错乱」。

**17｜余额闸门（把余额耗到不足）**

> 预期：余额不足时发消息返回 **402**，对话区顶部出现常驻的充值横幅，
> 输入区旁的余额 chip 变成警示色。**余额不会被扣成负数** ——
> 数据库那层还有 `check (balance >= 0)` 兜底，业务代码算错也扣不下去。
> 想直接验证的话，用管理端 `POST /admin/credits/adjust` 传一个负到超余额的金额，会被拒。

### 自动跑一遍（不用开浏览器）

三个脚本，覆盖三层：基础链路、功能 13–16、账号与积分。**基线是 83 / 65 / 114，全部 0 失败。**

```bash
# ① 基础链路：健康 → 注册 → 工作区 → 文件 → 对话 → 补丁 → 宪法 → Spring 地图 → PR 预演 → 测试运行
node tools/e2e-smoke.mjs                    # 83 项断言
# 或指定后端
BASE_URL=http://127.0.0.1:8080 node tools/e2e-smoke.mjs

# ② 功能 13–16：Agent 工位 / 工具级时间冻结 / 反事实分支 / 特性开关强制包裹
node tools/e2e-features-13-16.mjs           # 65 项断言

# ③ 账号与积分：注册验证 / 防枚举 / 失败锁定 / 双令牌轮换与重放 / 找回改密 /
#               登录设备 / 订单支付幂等 / 预扣结算 / 余额闸门与管理端 / 越权 / 登出
node tools/e2e-auth-credits.mjs             # 114 项断言
```

`e2e-smoke.mjs` 依次验证：健康检查 → 注册 → 建工作区 → 读文件树 → 读文件基线 → **越界防护** →
建会话 → 开 SSE → 发消息 → 等 patch 事件 → 应用补丁 → **回头读文件确认内容真的变了** →
重复应用被拒 → 影响面 → 编译闭环 → **仓库宪法（读 / 模板 / 存 / 撤回 / 再存）** →
**Spring 地图（Bean / 端点 / 注入边）** → **PR 预演（标题 / 分支 / 审查清单）** →
**测试运行（统计 / 失败用例或编译诊断）** → 会话历史与补丁列表已持久化。退出码 0 = 全绿。

> **基线回归必须对着 mock 模型跑**（确定性）。接真实模型跑 `e2e-smoke` 会掉十几条 ——
> 那些是模型行为差异（引用格式、补丁校验、超时），不是代码回归。别把它们当成「改坏了」。
>
> 另外两件容易踩的：`e2e-auth-credits.mjs` 依赖 `LLM_EMBED_MODEL` 配好，
> **漏掉会让语义检索那几条断言全挂**；应用补丁的断言要先查 `/api/patches/{id}/feature-flag`，
> 命中时 apply 必须带 `{"acknowledgeFlag": true}`，否则 `409 FLAG_ACK_REQUIRED` 会引发连环失败。

### 真开浏览器跑一遍（UI 自检）

`tools/e2e-smoke.mjs` 只打接口，看不到界面。要在真浏览器里把演示步骤点一遍并留截图：

```bash
# 需要先起好后端(8080)、前端(5173)、mock 模型(8787)
node tools/ui-probe.mjs tools/ui-steps/09-demo-final-wide.json docs/self-test/ui-log-final.txt
# 后半段（出补丁 → 应用 → 刷新验证）单独一个批次
node tools/ui-probe.mjs tools/ui-steps/11-demo-tail-wide.json  docs/self-test/ui-log-final-tail.txt
# 证据层（引用 chip / 风险条 / 编译闭环 / 双模式）单独一批，产出在 docs/self-test/v2/
node tools/ui-probe.mjs tools/ui-steps/12-evidence-features.json docs/self-test/ui-log-evidence.txt

# 功能 13–16（含工作台「工具轨道」重构前后对照），产出在 docs/self-test/v4 与 v5-redesign/
node tools/ui-probe.mjs tools/ui-steps/18-features-13-16.json   _ui18.log
node tools/ui-probe.mjs tools/ui-steps/19-redesign-showcase.json _ui19.log

# 账号与积分（13 张：登录/找回/注册/邮箱验证/工作区/IDE 积分横幅/积分中心/收银台/
#             已支付/流水/账号安全/重置密码），产出在 docs/self-test/v6-accounts/
node tools/ui-probe.mjs tools/ui-steps/20-accounts-credits.json _ui20.log
```

> 写新剧本时两个坑：**探针不会自动建目录**，所以 `rm -rf docs/self-test/vN` 之后必须先
> `mkdir -p`，否则每张截图都报「系统找不到指定的路径」，而断言却全绿 —— 很有欺骗性；
> 另外**「应该有差异」的两张截图字节数必须不同**，相同就是同一帧的征兆。
> 目标元素在滚动容器折叠下方时，截图前要 `scrollIntoView({block:'start'})`，
> 否则断言全绿但图上什么都没有。

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

所有接口都在 `/api` 下。**除账号相关的公开端点外**都需要 `Authorization: Bearer <accessToken>`。

公开端点（不需要令牌）：`/health`、`/auth/register`、`/auth/login`、`/auth/refresh`、
`/auth/verify-email`、`/auth/resend-verification`、`/auth/forgot-password`、`/auth/reset-password`。

**账号与鉴权**

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/health` | 模型是否配置、检索引擎、Redis 是否可用 |
| `POST` | `/auth/register` | 注册。返回 `{ userId, username, email, emailVerified, role, accessToken, refreshToken }` |
| `POST` | `/auth/login` | `{ identifier, password }`，identifier 可是用户名或邮箱。失败 5 次锁 15 分钟（423） |
| `POST` | `/auth/refresh` | **轮换刷新**：旧的立即作废并记下 `replacedBy`。拿已轮换的旧令牌再来一次 = 重放，全量吊销该用户所有会话 |
| `POST` | `/auth/logout` | 作废当前 refresh token |
| `POST` | `/auth/verify-email` | `{ token }` 完成邮箱验证 |
| `POST` | `/auth/resend-verification` | 重发验证邮件。**受 60s 冷却限制** |
| `POST` | `/auth/forgot-password` | 发起找回。**无论邮箱是否存在都返回成功**（防账号枚举） |
| `POST` | `/auth/reset-password` | `{ token, password }` |
| `POST` | `/auth/change-password` | 改密。**其他设备的 refresh token 全部作废**，当前设备继续可用 |
| `GET` | `/auth/me` | 当前身份（含 `emailVerified` / `role` / `credits` / `lowBalance`） |
| `GET` | `/auth/sessions` | **登录设备列表**：设备摘要 / IP / 登录时间 / 令牌到期时间 |
| `DELETE` | `/auth/sessions/{id}` | 踢掉某个设备 |

**工作区 / 文件 / 对话 / 补丁**

| 方法 | 路径 | 说明 |
| --- | --- | --- |
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
| `GET` | `/workspaces/{id}/constitution` | **仓库宪法**：`{ exists, content }` |
| `PUT` | `/workspaces/{id}/constitution` | 保存（`content` 为空串 = 撤回并删除文件） |
| `GET` | `/workspaces/{id}/constitution/template` | 宪法模板 |
| `GET` | `/workspaces/{id}/spring-map` | **Spring 地图**：Bean / 端点 / 依赖注入边（只读扫描） |
| `POST` | `/workspaces/{id}/test-run` | **测试运行**：跑项目自己的 `test` goal，返回统计 / 失败用例 / 编译诊断 |
| `GET` | `/patches/{patchId}/pr-preview` | **PR 预演**：标题 / 分支建议 / 审查清单（含宪法条款），纯派生只读 |
| `GET` | `/patches/{patchId}/feature-flag` | 该补丁是否命中**特性开关**。命中时 apply 必须显式带 `{ acknowledgeFlag: true }`，否则 `409 FLAG_ACK_REQUIRED` |
| `POST` | `/chat/sessions/{sid}/patches/apply-all` | 批量应用本会话待确认补丁 |
| `DELETE` | `/chat/sessions/{sid}` | 删除会话 |

**Agent 工位 / 工具闸门 / What-if**

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/workspaces/{id}/desk` | **Agent 工位**：影子工作区里 Agent 正踩到哪一步（只读面板） |
| `GET` | `/chat/sessions/{sid}/gates` | 待人工审批的**工具级**闸门 |
| `POST` | `/chat/sessions/{sid}/gates/{gateId}/approve` · `/reject` | 放行 / 驳回某次工具调用 |
| `GET` · `PUT` | `/chat/sessions/{sid}/gate-policy` | 闸门策略：哪些工具必须人工点过才执行 |
| `GET` | `/workspaces/{id}/whatif` | 反事实分支列表 |
| `POST` | `/workspaces/{id}/whatif` | 建一个**反事实分支**（「假如当时那样改会怎样」），跑在未被改动的原文件上 |
| `GET` | `/workspaces/{id}/whatif/{branchId}` | 分支的推演结果（与主线对比） |
| `POST` | `/workspaces/{id}/whatif/{branchId}/adopt` · `/discard` | 采纳到主线 / 丢弃 |

**快照 / 语义检索 / 网页终端**

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` · `POST` | `/workspaces/{id}/snapshots` | 列出 / 手动打一个快照（应用补丁前也会自动打点） |
| `POST` | `/workspaces/{id}/snapshots/{snapshotId}/restore` | **一键回滚**到该快照 |
| `DELETE` | `/workspaces/{id}/snapshots/{snapshotId}` | 删除快照 |
| `GET` | `/workspaces/{id}/semantic/status` | 语义检索可用性（`available` 取决于是否配了 embedding 模型） |
| `POST` | `/workspaces/{id}/semantic/index` | 重建语义索引 |
| `POST` | `/workspaces/{id}/semantic/search` | 向量检索（与正则 grep 互补） |
| `POST` | `/workspaces/{id}/terminal/run` | **网页终端**：跑一条命令。只给登录用户用，模型没有任何命令执行工具 |

**积分与计费**

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/credits/summary` | 余额 + 四项统计（累计获得 / 累计消耗 / 本轮预扣 / 注册赠送） |
| `GET` | `/credits/ledger?page=&size=` | 流水（只增不改）。`size` 上限 100 |
| `GET` | `/credits/reconcile` | **自查对账**：当场比对 `sum(ledger.delta)` 与账户余额快照，返回是否一致。出问题时用户自己就能看见，不用等客服 |
| `GET` | `/credits/plans` | 在售套餐（含后端算好的 到账总额 / 每千分单价） |
| `GET` | `/credits/orders` | 我的订单 |
| `POST` | `/credits/orders` | `{ planCode }` 下单。**下单时把到账积分冻结进订单**，之后改套餐价不影响历史订单 |
| `POST` | `/credits/orders/{orderNo}/pay` | 模拟支付成功回调 |
| `POST` | `/credits/orders/{orderNo}/payment` | **重新获取支付凭据**（上次支付凭证丢了就调它） |
| `POST` | `/credits/orders/{orderNo}/cancel` | 取消待支付订单 |

幂等说明：`pay` 走**条件更新**（`where status='PENDING'`）保证只有一次真正生效，
账本入账再用 `recharge:{orderNo}` 做唯一键 —— 支付网关重试 10 次也只到账一次。

**管理端**（需要 `role=ADMIN`，且每次都从数据库重读角色，不信任令牌里带的）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/admin/accounts/{username}` | 查账号：余额 / 角色 / 锁定状态 / 邮箱状态 / 账本累计值 / 两者是否一致 |
| `POST` | `/admin/credits/adjust` | `{ userId, amount, reason }` 手工调分。可正可负，负数超余额会被拒；**理由原样进流水**，操作人一并记下 |
| `POST` | `/admin/accounts/{username}/reconcile` | **对账修正**：把账户余额对齐成账本累计值 |

> 这里刻意**没有「分页列出全部用户」** 这个接口 —— 一旦有，它就变成导出全站用户数据的口子。
> 需要谁的数据就按用户名查谁。角色与锁定没有独立开关接口，改角色/解锁走数据库或后续按需再加。

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

由 Flyway 自动迁移（`backend/src/main/resources/db/migration/`，V1 → V5）：

| 表 / 迁移 | 作用 | 关键点 |
| --- | --- | --- |
| `users` · V1/V4 | 账号 | BCrypt 哈希；V4 扩了邮箱、`email_verified`、`role`、`status`、`failed_attempts`、`locked_until`、`last_login_at`，并加 `uk_users_email` |
| `workspaces` · V1 | 工作区 | 存磁盘 `root_path`；接口层**不下发**这个字段 |
| `chat_sessions` · V1 | 会话 | 外键到工作区 |
| `chat_messages` · V1 | 消息 | `meta` 存模型名、token 用量、本轮补丁 id 列表 |
| `patches` · V1 | 补丁 | `status` 用带条件的 UPDATE 做 CAS，保证只被应用/拒绝一次 |
| `workspace_snapshots` · V2 | 快照 | 应用补丁前自动打点，支撑「一键回滚」 |
| `code_chunks` · V3 | 语义检索 | 代码切块 + 向量，供相似度检索 |
| `email_tokens` · V4 | 邮箱验证 / 重置密码 | 只存 `token_hash`；`purpose` 区分用途；`consumed_at` 保证一次性 |
| `refresh_tokens` · V4 | 会话 | 只存 sha256；`replaced_by` 支撑**轮换与重放检测**；`device`/`ip` 支撑登录设备列表 |
| `login_audit` · V4 | 登录审计 | 成功与失败都记（含 IP / UA / 失败原因） |
| `credit_accounts` · V5 | 积分余额快照 | 带 `check (balance >= 0)` —— 即使业务代码算错，余额也不可能为负 |
| `credit_ledger` · V5 | 积分流水 | **只增不改**，是「事实」；`uk_credit_ledger_idem` 唯一键做幂等 |
| `credit_plans` · V5 | 套餐 | 是**配置**不是代码，运营改价不用等发版 |
| `credit_orders` · V5 | 订单 | 下单时把到账积分**冻结进订单**，之后改价不影响历史订单 |

核心关系一句话：**`credit_ledger` 是事实，`credit_accounts` 只是它的缓存**。
余额永远能由账本重算出来，所以「对账」这个动作才有意义 —— 两个数不一致就是真出事了。

时间列全部是 `datetime(6)`（微秒）。**不是 PG 的 `now()` 那种微秒精度** ——
MySQL 的 `now()` 只到秒，写库必须用 `now(6)`，否则同一秒内的 HOLD 与 SETTLE 排序会错乱。

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
| 密码 | BCrypt。长度与「必须含字母与数字」在**前后端都校验一遍** —— 前端是体验，后端才是规则。 |
| 令牌存储 | access 不落库（2h）；refresh 只存 **sha256**，所以即使库被拖走也换不出登录态。 |
| 令牌轮换 | 每次 `refresh` 换一对新令牌，旧的立刻作废并记 `replaced_by`。**旧令牌再被使用 = 重放 → 全量吊销该用户所有会话**。 |
| 重放判定收窄 | 只有**被轮换掉**的令牌（`replaced_by` 非空）才算重放。被「登出/改密」正常作废的令牌被重试**只拒绝本次** —— 否则任何拿到历史令牌的人都能免鉴权把用户从所有设备踢下去（自伤式 DoS）。 |
| 失败锁定 | 连续失败达阈值锁 15 分钟。计数写在 `REQUIRES_NEW` 独立事务里 —— 登录失败必然抛异常回滚主事务，同一个事务里写计数等于每次都归零（这个 bug 真踩过）。 |
| 防账号枚举 | 注册不区分「用户名占用/邮箱占用」以外的信息；`forgot-password` **无论邮箱是否存在都返回成功**；登录失败不区分「用户不存在/密码错」。 |
| 管理员判定 | 每次都**从数据库重读角色**，不信任 access token 里带的 —— 令牌 2 小时有效期，写死角色意味着降权后对方还能力大 2 小时。 |
| 余额原子扣减 | `update ... set balance = balance - :a where user_id = :u and balance >= :a`，**禁止读-改-写** —— 并发两轮对话必然扣成负数。 |
| 支付幂等 | 两层：`markPaid` 走条件更新（`where status='PENDING'`）+ 账本唯一键 `recharge:{orderNo}`。网关重试 10 次也只到账一次。 |
| 账本不可变 | `credit_ledger` 只增不改、无 UPDATE 入口。一次运行的账本**永远能重放出当前余额**。 |
| 计费事务边界 | 登录失败计数、登录审计、重放全量吊销都挂 `REQUIRES_NEW` —— 它们的调用点必然抛异常回滚主事务，不独立成事务等于没写。 |

---

## 8. 账号与积分体系

### 8.1 登录态：为什么是双令牌

```
登录 ──┬─► access JWT   2h，不落库，放内存           （每次请求带它）
       └─► refresh token 30 天，只存 sha256 落库     （只用来换新的 access）
```

只发一个长效 JWT 的系统有两个无法回避的问题：**没法撤销**（签出去就管到过期为止，
改密码、踢设备都做不到）和**没法列出会话**（「有哪些设备登着」根本无处可查）。
refresh 落库换来的是这两件事都成立了：

- **轮换**：每次刷新换一对新令牌，旧的立刻作废并记下 `replaced_by`；
- **重放检测**：一个**已被轮换掉**的令牌又出现，说明它被别人拷走了 → 全量吊销该用户所有会话。
  这里有个容易做错的边界：被「登出 / 改密」正常作废的令牌（`replaced_by` 为空）**不能**走这条分支，
  否则任何捡到历史令牌的人都能免鉴权地把用户从所有设备踢下线 —— 那是个自伤式的 DoS 开关；
- **设备列表**：`refresh_tokens` 里存了设备摘要、IP、登录时间、到期时间，账号页逐条可见、可踢。

前端配套两类坑，都踩过：

- **静默刷新必须防并发**。刷新是轮换的，两个请求同时 401 一起去刷新，第二个会带着刚被作废的
  旧令牌去换 —— 直接触发重放检测，用户被全量踢出。所以 `refreshAccessToken()` 是**单例 Promise**，
  并发调用共享同一次刷新；
- **SSE 的令牌要动态取**。长连接跨过 access 过期是常态，`openChatStream` 收的是
  `getToken: () => Promise<string|null>` 而不是一个静态字符串 —— 每次建连前现取，顺带触发续期。

### 8.2 一段对话是怎么被计费的

计费模型就三层，不搞复杂：`credit_accounts` 是余额快照，`credit_ledger` 是只增不改的事实，
`credit_plans` / `credit_orders` 负责把人民币变成积分。

**每轮对话走三段落账**（`HOLD → SETTLE`，失败则 `RELEASE`）：

```
用户发消息
   ├─ ① HOLD   −30      预扣。先冻结一笔，避免用户跑到一半余额被别处花光
   │
   ├─ ② 模型流式输出，结束时算真实用量：输入 N token × 1 / 千 + 输出 M token × 3 / 千
   │
   └─ ③ SETTLE +27      多退少补。真实花费 3 分 → 退回 27 分，净扣 3
        （本轮失败 →  RELEASE +30  全额退回，文案「本轮失败，退还预扣」）
```

所以流水里**一轮对话会出现两行**，净额才是实际花费。UI 上专门写了这句话 ——
不说清楚，用户会把「−30 又 +27」读成扣了两次钱。

这里有个**真实踩过的竞态**：`stream.start()` 是异步的，`run()` 会立刻返回。如果只用一个
「已结算」标志位，外层 `finally` 会在模型还在生成时就把预扣退掉 —— 库里会出现
`HOLD −30` 紧接着 `RELEASE +30`，然后 `SETTLE` 姗姗来迟。修法是 `Charge` 拆成**两个**标志位：

| 标志位 | 含义 | 谁写 |
| --- | --- | --- |
| `settled` | 已结算，兜底不可再退 | `settle()` 的 `finally` |
| `handedOff` | 回合已交给流式回调，退款责任转移 | `run()` 在 `.start()` 之后立刻写 |

退款条件因此是 `!handedOff && !settled` —— 缺任何一半都会算错。

### 8.3 幂等与对账

- **支付幂等两层**：`markPaid` 用条件更新（`where status='PENDING'`）保证状态只翻转一次；
  账本入账再用唯一键 `recharge:{orderNo}` 兜第二层。网关重试 10 次 → 只到账一次。
- **对账**：`credit_ledger` 只增不改，所以 `sum(delta)` 必须恒等于 `credit_accounts.balance`。
  前端有「一键对账」按钮，用户自己就能看到两个数是否一致 —— 一个不能自查的余额系统不值得信任。
  管理端还有 `POST /admin/accounts/{username}/reconcile` 把余额**对齐成**账本值
  （它假定「账本是对的、快照漂了」，所以不给自动流程调用）。
- **余额闸门**：余额不足直接 `402 INSUFFICIENT_CREDITS`，并在对话区常驻充值横幅。
  绝不悄悄扣成负数 —— 数据库那层还有 `check (balance >= 0)` 兜底。

### 8.4 上线前必做清单

| 事项 | 变量 | 不做的后果 |
| --- | --- | --- |
| 造出第一个管理员 | `ADMIN_USERNAMES=你的用户名` | 没有任何人有 ADMIN 角色，管理端全 403 |
| （建好管理员后）清空它 | `ADMIN_USERNAMES=` | 留着等于「这几个名字谁先注册谁就是管理员」 |
| 切真实邮件 | `MAIL_MODE=smtp` + `MAIL_HOST/USERNAME/PASSWORD` | `dev` 模式不发真邮件，用户永远收不到验证链接 |
| 改前端域名 | `FRONTEND_BASE_URL=https://你的域名` | 邮件里的链接指向 `localhost`，用户点开就废 |
| 换签名密钥 | `JWT_SECRET` ≥ 32 字节随机串 | 任何知道默认串的人都能伪造登录态 |
| 打开余额闸门 | `CREDIT_ENFORCE=true` | 余额扣光还能继续免费用模型 |

> `dev` 邮件模式是**刻意保留**的：它在不发邮件的前提下把整条链路跑通（令牌落库 + 写日志 +
> 接口回显），所以自检脚本能在离线环境里验证邮箱验证与找回密码。上线必须切 `smtp`。

---

## 9. 已知限制

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
- **支付是模拟的**：`MockPaymentProvider` 只做「把订单置为已支付 + 幂等入账」，
  没有对接任何真实网关。接微信 / 支付宝时替换 `PaymentProvider` 实现即可，
  但**回调验签、金额比对、异步通知重试**这些真实网关特有的部分要自己补 —— 现在的 mock 不覆盖它们。
- **邮件默认不发真邮件**：`MAIL_MODE=dev` 下验证链接只写在日志与接口响应里。
  上线必须切 `smtp`，且送达率（SPF / DKIM / 发信域信誉）属于运维范畴，代码层面保证不了。
- **计费按 token 估算，不对齐服务商账单**：单价是「每 1000 token 多少积分」的配置值，
  与模型厂商的实际计费口径可能有出入。它的定位是**产品内的用量计量**，不是财务对账系统。
- **登录失败锁定按账号计**：没有按 IP 或设备维度计数。攻击者可以拿用户名列表横向撞
  （每个账号只错 4 次就不触顶）。要防这个需要引入 IP 维度的限流，目前没做。
- **注册与找回密码没有验证码**：没有图形验证码 / 滑块 / 短信二次确认。
  公开部署前建议在前面挂一层 WAF 或网关限流。
- **`credit_plans` 改了价，已下订单不受影响**（这是特性不是 bug）：到账积分在下单时冻结进订单，
  所以「下单 → 隔天涨价 → 再支付」拿到的还是旧价。反过来若想让新价立即生效，需要重新下单。

---

## 10. 路线图

**已经做完的（原本挂在 TODO 里）**

- [x] **代码库语义检索** —— 落 `code_chunks` + 向量，走 OpenAI 兼容 `/v1/embeddings`
      （没用 pgvector：数据库已切 MySQL）
- [x] **多文件 Agent 自动改** —— 一轮产出多个补丁，逐个确认
- [x] **工作区快照与回滚** —— 应用补丁前自动打点，一键回滚
- [x] **网页终端** —— `run_command` 的受控版本，只给登录用户用
- [x] **账号与商业级鉴权** —— 双令牌 / 邮箱验证 / 失败锁定 / 登录设备
- [x] **AI 用量积分体系** —— 预扣结算、只增账本、套餐订单、对账

**还没做**

- [ ] **每用户 Docker 沙箱** + xterm.js 真终端（设计见 `deploy/sandbox/README.md`）——
      现在的编译验证与网页终端都带着服务进程的身份跑，防的是「模型乱写代码」而非「恶意构建脚本」
- [ ] **Java LSP 接入**（跳转、诊断、补全）—— 现在 Monaco 只做语法着色
- [ ] **对接真实支付网关**（微信 / 支付宝）+ 回调验签、金额比对、异步通知重试
- [ ] **IP 维度限流 / 注册验证码** —— 现在账号锁定只按用户名计，挡不住横向撞库
- [ ] 每工作区的 profile / 系统提示词覆盖（现在只有 `.wca/CONSTITUTION.md` 与 `.coding-rules.md`）

---

## 11. 目录结构

```
web-code-assistant/
├── .env.example                   环境变量样板（上线必改项都标了 ★）
├── backend/                       Spring Boot 后端
│   ├── src/main/java/com/webcode/assistant/
│   │   ├── agent/                 Agent 编排、工具集、补丁生命周期、工位状态、SSE 事件中心
│   │   ├── api/                   REST 控制器与请求/响应模型
│   │   ├── build/                 编译验证 + 测试运行（构建工具检测、诊断/失败用例解析、超时与输出裁剪）
│   │   ├── common/                错误码与统一异常处理
│   │   ├── config/                配置属性、线程池、启动检查
│   │   ├── constitution/          仓库宪法（.wca/CONSTITUTION.md 读写 + 模板）
│   │   ├── context/               system prompt 组装（引用规则 / 宪法 / 双模式）+ 引用校验
│   │   ├── credit/                积分：账户、只增账本、定价、套餐、订单、支付提供方（mock 可替换）
│   │   ├── llm/                   LangChain4j 模型 + 限流配额
│   │   ├── mail/                  邮件通道：dev（不发信、回显令牌）/ smtp（真发）
│   │   ├── map/                   Spring 组件地图（Bean / 端点 / 依赖注入扫描）
│   │   ├── scm/                   Git 克隆、zip 导入、内置示例
│   │   ├── security/              双令牌鉴权、刷新轮换与重放检测、失败锁定、登录审计
│   │   ├── semantic/              语义检索（切块 + embedding + 向量检索）
│   │   ├── terminal/              网页终端（受控 run_command）
│   │   └── workspace/             路径解析、文件读写、diff 解析与应用、快照与回滚
│   └── src/main/resources/
│       ├── db/migration/          Flyway SQL（V1 初始化 → V5 积分体系）
│       └── samples/demo-java/     内置演示项目（带一个待重构点）
├── frontend/                      React + Vite 前端
│   └── src/
│       ├── components/            工具轨道 / 文件树 / 编辑器 / 对话 / 补丁卡片 / 工位 / 闸门 / What-if …
│       ├── lib/                   API 客户端（双令牌+静默刷新）、SSE 客户端、diff 工具、Monaco 主题
│       ├── pages/                 登录注册 / 邮箱验证 / 重置密码 / 工作区列表 / IDE / 积分中心 / 账号安全
│       └── styles/global.css      Web Code Assistant 设计系统（Darkroom Brass，CSS 变量）
├── deploy/
│   ├── docker-compose.yml         全栈一键起（变量从根目录 .env.example 拷过来）
│   └── sandbox/                   沙箱设计（未实现）
├── docs/self-test/                自检截图与日志，按版本分目录（v2 … v6-accounts）
└── tools/
    ├── mock-llm/server.mjs        OpenAI 兼容 mock 模型，离线自测用（带行号剥离 + 真实行号引用）
    ├── e2e-smoke.mjs              接口层端到端自测（83 项断言：健康/工作区/文件/对话/补丁/宪法/地图/PR 预演/测试）
    ├── e2e-features-13-16.mjs     功能 13–16 自测（65 项断言：工位 / 时间冻结 / What-if / 特性开关）
    ├── e2e-auth-credits.mjs       账号与积分自测（114 项断言：注册验证 / 防枚举 / 锁定 / 令牌轮换与重放 /
    │                              找回改密 / 登录设备 / 订单幂等 / 预扣结算 / 余额闸门 / 越权 / 登出）
    ├── ui-probe.mjs               浏览器自检驱动（按 JSON 步骤跑 agent-browser）
    ├── maven-self-test-settings.xml  自测用 Maven settings（把内网镜像换回 Central）
    └── ui-steps/                  自检步骤定义（*.json，剧本 18/19/20 …）
```

---

## 12. 一句话总结

这套东西的价值不在于「接了个模型」，而在于**边界**：
模型读不到的东西真的读不到（路径三层校验），模型改不了的东西真的改不了（工具集里没有写盘能力），
用户没确认的改动真的不会落盘（补丁必须由人点应用），用户没付的钱真的花不出去
（余额原子扣减 + `check (balance >= 0)` 兜底），而且**这些边界每一处都能被自检脚本复现**。
