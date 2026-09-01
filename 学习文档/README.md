# Kimi Code 源码学习文档

> 时效基线：基于 commit `d4e0ad4b2`（2026-08）。代码演进后行号与结构会漂移，发现不符以代码为准，欢迎顺手修正文档。
>
> 写给什么人：熟练 TypeScript/Node、但不熟悉 LLM agent 内部机制的工程师；目标是**参与贡献 + 二次开发 + 理解 agent 引擎设计**三者兼得。

## 文档地图

| 篇 | 内容 | 什么时候读 |
|---|---|---|
| `00-项目全貌.md` | 架构深度解析：以插件为主入口的启动时序（六阶段）、五层模块依赖、配置与数据加载全流程、模块关系总图 | 第 1 天精读，建立心智模型；之后当字典查 |
| `01-环境搭建与运行.md` | 环境、**构建体系深解**（exports→src 机制、何时需要 dist、tsx/tsconfig 坑）、跑通三种形态、排错速查 | 动手前精读 |
| `02-VSCode插件源码导读.md` | 深度版：激活/webview 装配、bridge 协议与分发、SessionRuntime 状态机逐块精读、diff 子系统、事件归约 | 学习主线起点，精读 |
| `源码详解/01-webview与Bridge通信.md` | 单个子系统拆到底：KimiWebviewProvider/BridgeHandler/协议/会话路由/SessionRuntime 内部（投影、逆流审批）/基线 diff/webview React 侧/排错 | `02` 读完后想深钻插件通信层时 |
| `源码详解/02-BridgeHandler方法详解.md` | 单类拆到底：`bridge-handler.ts` 4 字段＋19 成员＋4 辅助函数逐个讲"作用、参数、谁调用、为什么"（构造注入/查表分发/四种"关"），末尾设计复盘 | `源码详解/01` 第二节后想要方法级细节时 |
| `源码详解/03-KimiRuntime方法详解.md` | 单类拆到底：`kimi-runtime.ts` 7 字段＋13 成员＋4 函数逐个讲（双表多对多、openSession 三分支、拆与关家族、审批标志三级恢复链） | `源码详解/01` 第五节后想要方法级细节时 |
| `源码详解/04-BaselineManager方法详解.md` | 单类拆到底：`baseline.manager.ts` 9 公共＋16 私有方法＋约 25 个文件级函数逐个讲（同步抢读时序、内容寻址存储、三态判定、每会话串行队列、原子写） | `源码详解/01` 第八节后想要方法级细节时 |
| `源码详解/05-SessionRuntime方法详解.md` | 单类拆到底：`session-runtime.ts` 20 字段＋39 成员＋2 函数逐个讲（三根出线接线、模型回合与宿主假回合、取消/独占、终态去重与错误抑制），末尾七条设计复盘 | `源码详解/01` 第六节后想要方法级细节时 |
| `源码详解/dive-chain-broadcast链条详解.md` | 单链拆到底：broadcast 一个函数实现如何穿四层、20 处调用点全点名（全景图＋站式展开＋调用点总表＋终点站＋设计复盘） | `源码详解/01` 第二节后想深钻广播机制时 |
| `源码详解/06-登录链路详解.md` | 单链拆到底：点击"Sign in with Kimi Account"→ 设备码流开浏览器授权 → token 落盘 → `/models` 供给 config.toml → 前端重拉模型换界面的全旅程（含 402 订阅、拒绝授权、no-models 陷阱等异常下落与时序总图） | `源码详解/01` 读完后想看一条完整业务链怎么把 RPC/广播/OAuth/配置串起来时 |
| `03-调试指南.md` | 插件/CLI/server/单测/webview 的具体调试方法 | 边学边查，常驻手边 |
| `04-agent引擎入门.md` | 概念速成 + **一次 prompt 的完整生命周期**：loop 状态机、权限链七步、上下文/压缩、事件溯源逐环节精读 | 插件读完后往下钻，核心收益 |
| `05-CLI与服务器.md` | CLI 四形态启动序列、kap-server 十五步时序、HTTP 面清单、WS/transcript 补发、ACP 双代 | 引擎之后 |
| `06-支撑包速览.md` | 每包"机制+关键类+消费者"：kosong/transcript/minidb/oauth/kaos/… + v1 引擎哪里值得读 | 按需深查 |
| `07-贡献与二次开发.md` | CI 全景（逐 job）、changeset 深规则、二次开发五个切入点、发布链 | 准备动手改时 |
| `08-术语表.md` | 黑话→人话对照：npm/pnpm 生态、工具、构建/发布、运行/调试、tsconfig 五组 | 遇到陌生行话时查；全套共享，新术语只改这一篇 |
| `更新记录-20260901.md` | 2026-09-01 拉取的 84 个提交全解：新功能（Remote Control/危险命令审批/tower）、修复（transcript 契约簇/并发双流）、重构（agent runtime→DI）、**对既有文档的影响**（03 篇行号漂移清单、skill 路径搬家表） | 每次拉取后先看，再决定旧文档哪些要修 |

## 学习路线（六阶段）

### 阶段 1 · 跑起来（半天–1 天）

- 读：`00`、`01`。
- 做：`pnpm install && pnpm build`；`pnpm dev:cli` 跑通 CLI 并 `/login`；按 `03` 第 1 节 F5 跑通插件，在隔离沙箱里完成一次对话。
- 自检：能说清"插件里按回车后，引擎代码跑在哪个进程"；知道 `~/.kimi-code` 里有什么。

### 阶段 2 · 插件层（2–4 天，主投入）

- 读：`02` + 它推荐的源码阅读顺序；`03` 第 1-2 节。
- 做：断点跟踪一条消息（调用栈抄下来）；走通"三处联动"加一个自定义设置或无操作 RPC；用 webview DevTools 看 zustand 状态。
- 自检：`BridgeHandler`/`KimiRuntime`/`SessionRuntime` 各管什么？审批弹窗的事件为什么叫"反向 RPC"？

### 阶段 3 · SDK 接缝层（1–2 天）

- 读：`04` 第二节。
- 做：写 20 行 node-sdk 脚本起 harness 发 prompt 打印事件流；对比 `createKimiHarnessV2` 与 `createKimiHarness` 两条路径。
- 自检：klient 的 facade/contract/transport 三层各挡什么风险？为什么 memory transport 也要走 JSON 往返？

### 阶段 4 · 引擎内部（1–2 周，核心收益）

- 读：`04` 全文 + `packages/agent-core-v2/AGENTS.md` + 精读路线里的源码。
- 做：`03` 第 3 节 CLI attach，断点 `llmRequester` 抄下模型真实看到的请求；跟踪一次 Edit 工具全链路（含审批）；跑通单包测试加断言。
- 自检：turn 与 step 的区别？compaction 触发在哪？Scope 三层（App/Session/Agent）+ Workspace 域各自的生命周期范围？

### 阶段 5 · CLI 与服务器（2–3 天）

- 读：`05`。
- 做：`pnpm dev:server` + kimi-inspect 观察会话与 WS 帧；`pnpm vis` 回放同一会话；读通 transcript 路由的断线续传。
- 自检：插件与 `kimi web` 在"引擎接入方式"上的本质区别？浏览器 UI 源码为什么在本仓找不到？

### 阶段 6 · 上手改（持续）

- 读：`07` + 按需 `06`（v1 loop 值得一看）。
- 做：从 `07` 的分级练习清单里挑，最终完成一次真实 PR（含 changeset、双语文档如需、Conventional Commits）。

## 使用建议

- **边读边打断点**比通读源码有效得多；`03` 是这套文档里最该常驻手边的一篇。
- 行话速查用 `08-术语表.md`——全套文档共用的黑话词典，遇到陌生缩写先翻它。
- 各包 `AGENTS.md` 是架构信息的第一来源，本套文档只在"学习动线"层面组织它们，不替代。
- 读 v2 引擎时记住它是**无注释区**：命名、测试、AGENTS.md 就是全部上下文——这也是为什么阶段 4 强调读测试。

## 附：对话实录——dist-web 与"三张脸"的源码分布（2026-08-23）

> 2026-08-23。原始对话内容，仅去除界面噪音；工具调用保留命令与关键输出。背景：读完 `01` 构建体系后，追问浏览器 UI（`dist-web`）的来源与可改性。

### kimi web（dist-web）源码在哪里？开源了吗

> **Bash**：`ls apps/kimi-code/dist-web/`；`cat .gitmodules`；`git log --oneline -5 --grep="sync web"`
> ```text
> assets  boot.js  favicon.ico  index.html
> 无 .gitmodules
> d4e0ad4b2 chore: sync web dist from code-app (#3166) …（多次同类 PR）
> ```

> **Bash**：`grep -rn "code-app"`（限 .mjs/.md/.json/.yml，排除 node_modules/dist-web）→ 命中 `.github/workflows/_native-build.yml`、根 `AGENTS.md` 等。`_native-build.yml:89-90` 注释："The SEA blob step embeds apps/kimi-code/dist-web. The bundle is committed (synced from the code-app repo)"。

> **Bash**：`find apps/kimi-code/dist-web -name "*.map"` → **无结果**；抽查 bundle 首部：`const __vite__mapDeps=…import{bR as xi,cb as Si,…}`——变量名全被压缩，基本不可读。

> **Bash**：`git remote -v` → `https://github.com/MoonshotAI/kimi-code.git`

> **Bash**：`curl -s "https://api.github.com/orgs/MoonshotAI/repos?per_page=100" | grep full_name` → 共 43 个公开仓库（kimi-code、kosong、pykaos、kimi-cli、kimi-zed-extension 等），**没有 code-app**。

> **Bash**：`git log --all --oneline -- apps/web` → 空。

查清楚了，直接说结论：

**源码在哪里**

**不在本仓库**。浏览器 UI（即 `kimi web` 的页面）在 Moonshot 内部一个叫 **code-app** 的独立仓库里开发（源码位于该仓库的 `apps/web`）。本仓库只有**构建好的成品**：

- `apps/kimi-code/dist-web/` —— Vite 打包产物：`index.html`、`boot.js`、`assets/` 下 533 个文件（压缩后的 JS/CSS、KaTeX 字体等）
- 实测看过 bundle 内容：变量名全部压成 `xi`/`Si`/`Ho` 这种，**没有 sourcemap**（一个 `.map` 都没有），基本不可读，没法当源码学
- 不是 git submodule（仓库没有 `.gitmodules`），是"gitignore + force-add"方式硬提交进来的产物

本仓库的 git 历史里也翻不到 `apps/web`（试过 `git log -- apps/web`，为空）——旧源码在公开历史中不存在

**开源了吗**

**没有**。查了 `MoonshotAI` 组织在 GitHub 的全部公开仓库（43 个，包括 kimi-code、kosong、pykaos、kimi-cli 等），**没有 code-app**。所以：

- 开源的：这个 kimi-code 仓库（引擎、CLI、server、全部 packages）+ 提交进来的 dist-web 成品
- 闭源的：浏览器 UI 的源码（内部仓库 code-app）

**它怎么更新、想改怎么办**

- **更新方式**：在 code-app 仓库跑 `KIMI_CODE_REPO=<本仓库路径> pnpm run sync:web`，把构建产物同步过来，以 "chore: sync web dist from code-app" 的 PR 合入（最近一次就是 `d4e0ad4b2`，你文档的时效基线那个 commit）
- **想改 web UI**：只能在 code-app 仓库改（需要内部权限）；联调时把它的 `pnpm dev:web` 用 `KIMI_SERVER_URL` 指向本仓库的 `pnpm dev:server`
- 根 `AGENTS.md:18` 原话是 "**its source no longer lives in this repo**"——"no longer"暗示源码曾经在本仓库，后来拆出去了；公开历史里已看不到

你的 `01-环境搭建与运行.md` 2.3 节"特例行"和排错表已经记了这个事实（源码在外部 code-app 仓库、sync 命令），文档不用改。

### 这个dist-web是干嘛的？

> **Bash**：`grep -rn "dist-web" apps/kimi-code/src` → 命中 `src/native/web-assets.ts` 与 `src/cli/sub/web/run.ts`。

> **Read**：`run.ts` 关键发现——`:50` `const WEB_ASSETS_DIR = 'dist-web'`；`:334-345` 注释：dev 模式（`KIMI_CODE_DEV_SERVER=1`，即 `dev:server` 脚本所设）容忍 dist-web 缺失、服务器 API-only 启动；非 dev 模式始终要求存在、kap-server 缺失即快速失败。

`dist-web` 就是 **kimi 的浏览器版聊天界面**——一个已经打包好的网页成品。

**具体是干嘛的**

kimi-code 同一个引擎，有**三个"脸"**（前端）：

| 前端 | 你看到的 |
|---|---|
| CLI / TUI | 终端里的文字界面（`pnpm dev:cli`） |
| VS Code 插件 | 编辑器里的侧边栏（F5） |
| **浏览器页面** | **浏览器里打开一个聊天页（`kimi web`）** ← dist-web 就是这个 |

跑 `kimi web`（或 `pnpm dev:server`）时，会启动 kap-server 并开一个本地网址。你在浏览器打开它，看到的聊天界面——输入框、会话列表、代码高亮的回复——那一整个页面就是 dist-web 里的文件（`index.html` + 533 个压缩好的 JS/CSS/字体）。服务器把它们当静态文件发给浏览器，页面再通过 HTTP + WebSocket 连回服务器收发消息。

**为什么以"成品"形式放在这个仓库**（代码依据 `apps/kimi-code/src/cli/sub/web/run.ts:334-345`）：

1. **源码闭源**（在内部 code-app 仓库），本仓库拿不到源码，只能放成品，这样 `kimi web` 装完就能用；
2. **native 单文件版会把它嵌进可执行文件里**（SEA 打包时把 dist-web 塞进单个二进制，见 CI 的 `_native-build.yml:88-91`）；
3. **缺了它打包直接报错**——`check-web-assets.mjs` 在打包前检查，dist-web 不在就失败，防止发布一个"打开浏览器一片空白"的坏包。

**一个容错细节**

开发模式（`KIMI_CODE_DEV_SERVER=1`，也就是 `pnpm dev:server` 设的）**允许 dist-web 不存在**：服务器照常起，只提供 API 没有页面——因为开发网页的人会从 code-app 那边跑 Vite 开发服务器联调。正式模式（用户装的 `kimi web`）则必须有，缺了直接报错拒绝起。

这些事实你文档 2.3 节"特例行"和排错表已经都记了，不用改。

### 所以其实它只是用来在浏览器中运行的？如果我想改tui的界面或者vs code插件的界面，有源码？只是如果想改浏览器的web ui的话，没办法？

> **Bash**：`ls apps/kimi-code/src/tui packages/pi-tui/src apps/vscode/src` → 三处都存在。tui：banner/commands/components/controllers/easter-eggs 等；pi-tui：components/editor-component.ts/fuzzy.ts 等；vscode：extension.ts/KimiWebviewProvider.ts/bridge-handler.ts/handlers/managers 等。

对，你理解得基本全对，只有一处可以补充。逐条确认：

**1. dist-web 只为浏览器服务？—— 是**

它只在 `kimi web`（浏览器形态）被用到：服务器把它发给浏览器当页面。TUI 和 VS Code 插件完全不碰它。唯一额外用途是打包时把它嵌进 native 单文件版（那个本质也是浏览器形态，只是内嵌了页面）。

**2. 改 TUI 界面 —— 有完整源码，就在本仓库**

两处：

- `apps/kimi-code/src/tui/` —— TUI 的业务界面（组件、控制器、命令、甚至彩蛋目录 `easter-eggs/`）
- `packages/pi-tui/` —— 底层 TUI 渲染框架（编辑器组件、模糊搜索、通用组件），TUI 是拿它搭的

改起来是纯本地开发：改完 `pnpm dev:cli` 直接看效果。仓库还有专门的 write-tui 技能（`.agents/skills/write-tui/SKILL.md`）给 AI 辅助改 TUI 用。

**3. 改 VS Code 插件界面 —— 有完整源码，也在本仓库**

`apps/vscode/src/`（`extension.ts`、`KimiWebviewProvider.ts`、`bridge-handler.ts` 等）。你学习文档的 `02-VSCode插件源码导读.md` 整篇讲的就是这块。注意插件界面分两层：原生侧边栏（插件 TS 源码）和 webview 里的网页（插件源码内的 webview 资源，同样在本仓库）——都有源码。

**4. 改浏览器 Web UI —— 源码确实没有，但不是"完全没办法"**

分两种"改法"：

- **改原版 UI：没办法。** 源码在内部 code-app 仓库，不在开源范围里。硬改 dist-web 里那 533 个压缩文件理论上可行、实际上不可维护，不建议。
- **换一个自己的 Web UI：可以。** 服务器的接口（REST + WebSocket，`/api/v1`）全部开源在 `packages/kap-server` 里，页面只是这些接口的一个消费者。你可以自己写一套网页指到同一个服务器。**本仓库里就有现成先例**：`apps/kimi-inspect` 就是一个自研网页（会话浏览、transcript 查看、DI 面板），`apps/vis/web` 也是——它们证明只靠公开的 server 接口就能做出完整网页界面。

一句话：**三张"脸"里两张（TUI、插件）源码齐全随便改；第三张（浏览器）原版改不了，但接口全公开，自己另做一张脸是可行的。**
