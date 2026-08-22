# Kimi Code 源码学习文档

> 时效基线：基于 commit `d4e0ad4b2`（2026-08）。代码演进后行号与结构会漂移，发现不符以代码为准，欢迎顺手修正文档。
>
> 写给什么人：熟练 TypeScript/Node、但不熟悉 LLM agent 内部机制的工程师；目标是**参与贡献 + 二次开发 + 理解 agent 引擎设计**三者兼得。

## 文档地图

| 篇 | 内容 | 什么时候读 |
|---|---|---|
| `00-项目全貌.md` | monorepo 地图、依赖分层、v1/v2 双栈、数据流总览 | 第 1 天，建立心智模型 |
| `01-环境搭建与运行.md` | 环境、构建、跑通三种形态、数据目录 | 动手前 |
| `02-VSCode插件源码导读.md` | 插件三层架构、runtime 层、消息全链路 | 学习主线起点 |
| `03-调试指南.md` | 插件/CLI/server/单测/webview 的具体调试方法 | 边学边查，常驻手边 |
| `04-agent引擎入门.md` | agent 概念速成 + node-sdk/klient + agent-core-v2 | 插件读完后往下钻 |
| `05-CLI与服务器.md` | CLI 组合根、kap-server、ACP | 引擎之后 |
| `06-支撑包速览.md` | 其余包半页速览 + v1 引擎去哪读 | 按需 |
| `07-贡献与二次开发.md` | 工作流约定、扩展切入点、练习清单 | 准备动手改时 |

## 学习路线（六阶段）

### 阶段 1 · 跑起来（半天–1 天）

- 读：`00`、`01`。
- 做：`pnpm install && pnpm build`；`pnpm dev:cli` 跑通 CLI 并 `/login`；按 `03 §1` F5 跑通插件，在隔离沙箱里完成一次对话。
- 自检：能说清"插件里按回车后，引擎代码跑在哪个进程"；知道 `~/.kimi-code` 里有什么。

### 阶段 2 · 插件层（2–4 天，主投入）

- 读：`02` + 它推荐的源码阅读顺序；`03 §1-2`。
- 做：断点跟踪一条消息（调用栈抄下来）；走通"三处联动"加一个自定义设置或无操作 RPC；用 webview DevTools 看 zustand 状态。
- 自检：`BridgeHandler`/`KimiRuntime`/`SessionRuntime` 各管什么？审批弹窗的事件为什么叫"反向 RPC"？

### 阶段 3 · SDK 接缝层（1–2 天）

- 读：`04` 第二节。
- 做：写 20 行 node-sdk 脚本起 harness 发 prompt 打印事件流；对比 `createKimiHarnessV2` 与 `createKimiHarness` 两条路径。
- 自检：klient 的 facade/contract/transport 三层各挡什么风险？为什么 memory transport 也要走 JSON 往返？

### 阶段 4 · 引擎内部（1–2 周，核心收益）

- 读：`04` 全文 + `packages/agent-core-v2/AGENTS.md` + 精读路线里的源码。
- 做：`03 §3` CLI attach，断点 `llmRequester` 抄下模型真实看到的请求；跟踪一次 Edit 工具全链路（含审批）；跑通单包测试加断言。
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
- 各包 `AGENTS.md` 是架构信息的第一来源，本套文档只在"学习动线"层面组织它们，不替代。
- 读 v2 引擎时记住它是**无注释区**：命名、测试、AGENTS.md 就是全部上下文——这也是为什么阶段 4 强调读测试。
