# Rust-First 迁移计划（Codex 方向）— 当前版

> **本文档是"TS 壳 → 纯 Rust 核心"迁移的唯一权威。**
> 状态：**2026-08-10 重写**——清理历史会话流水账，以当前真实状态为准；方向与决策记录保留。
> 参考资产：`D:/kimi/参考目录/_extracted_codex_full/codex-main`（codex-rs，60+ crates）。
> 分支：`feat/rust-agent-engine-migration`（所有迁移工作在此分支，每次提交同步远程）。

---

# 1. 当前状态总览（2026-08-10）

## 1.1 方向（2026-08-06 定案，不可回退）

> **最终只有浏览器前端是 TS。** 其余所有 TypeScript——CLI/TUI 宿主、server、SDK、协议、OAuth、ACP、LLM 抽象、i18n 数据、rust-loop 桥——全部迁入 Rust 或退役。

| 类别 | 保留 TS | 说明 |
|---|---|---|
| ✅ 保留（web 前端） | `kimi-web`(Vue3) / `kimi-inspect` / `vis/web` | 浏览器 UI，纯前端 |
| ✅ 保留（前端壳） | `vscode` / npm bin 包装（`kimi.mjs` 几 KB） | VS Code 宿主 API 必须 JS；仅壳，逻辑走 Rust RPC |
| ❌ 迁 Rust | 见 §5 | 全部宿主层 |
| ❌ 退役 | `pi-tui` / `transcript` / `migration-legacy` / `klient`(已退) / TS i18n 数据 / `rust-loop.ts` | 无存在意义或已被 Rust 覆盖 |

**明确不建** `sdk/typescript`——外部消费者使用 `kimi-sdk`(Rust) 或 HTTP 协议。`i18n` 文案沉淀为 JSON 数据文件。

**TS 冻结已落地（2026-08-10）**：`kosong` / `transcript` / `telemetry` / `migration-legacy` / `pi-tui` / `kimi-agent/rust-loop.ts` / `apps/kimi-code` 剩余 TS 一律**冻结**——入口文件带 FROZEN banner，规则见根 AGENTS.md「TS 冻结清单」。只允许关键 bug 修复（崩溃/数据丢失/安全/日志污染）与测试基线适配；新能力一律写 Rust。**已退役（2026-08-10，→ retired/）**：`node-sdk` / `kap-server` / `oauth` / `acp-adapter` / `protocol` / `kaos`。

## 1.2 完成度（2026-08-10 实测）

| 域 | 状态 |
|---|---|
| Rust 引擎（`packages/kimi-agent`） | ✅ 唯一引擎，cargo 全绿；宿主面补齐：`config/get·set` 空 home 容忍、`session/cancel_compact`、`session/create` work_dir、metadata 持久化 |
| 阶段 A–E（协议/引擎/宿主协议/CLI/exec/TUI/ACP/SDK/OAuth/WS） | ✅ 完成（§6） |
| 阶段 F（入口切换与 TS 退役） | 🔶 主体完成（分发薄壳 ✅、入口 wrapper ✅、F-5 全链路 e2e ✅）；TS 删除待 G-6 |
| G-4 TUI 攻坚（最大长杆） | ✅ 61 命令全命令面 + 交互对拍（§6.4） |
| G-2 Rust server（`kimi-server` + HTTP/WS 投影） | ✅ 前端零改动直连；v1 wire 契约字段级对拍完成 |
| G-1 kimi-sdk 补齐 | 🔶 大块完成（2026-08-10）：事件广播 + on_event/approval/tool handler、MCP 全局配置、workspace skills、config 小件、auth 扩展；剩余：消费面切换（§7 G-1） |
| vitest 基线（TS 宿主测试） | ✅ 5736 passed / 2 failed（kosong 并发 flaky）/ 64 skipped——原 143 failed 归因修复完成（2026-08-10） |

## 1.3 下一步（G 路线）

1. **G-0 收尾**：基线锁定（cargo 全绿 ✅ + vitest 收敛 ✅）；TS 侧新增逻辑先与 Rust 核对（进行中）
2. **G-1（当前最大消费面）**：`node-sdk → kimi-sdk` 补齐（session/harness/auth/catalog/legacy 全部面）→ `apps` 消费点逐个切 Rust → 解锁包退役
3. **G-2 剩余**：Rust server 的 v1 wire 遗留投影批次（见 §7）
4. **G-3**：CLI 消费面切 kimi-cli；**G-4 剩余**：交互路径对拍测试（D-5）+ 媒体富卡片（另议）
5. **G-5/G-6/G-7**：LLM 面并入 / 退役 / web-only 验证

## 1.4 已知缺口（不阻塞主线的记录）

1. **compaction summarizer 双通道**：引擎 summarizer 仅支持 native LLM；host-proxy 会话（SDK 默认 llmStep）compact 报 `compaction.unable`。SDK 侧已按 `agent.nativeLlmProvider` 显式 opt-in 接线（不自动派生——native_llm 会使引擎回合脱离宿主 llmStep，破坏 host identity UA/事件流）。需引擎支持 summarizer 独立通道
2. **子代理 replay 无数据源**：引擎 `Task` 工具无 host-visible 记录，resume 面无 subagent 数据（vscode 测试已跳过）
3. **vscode legacy backfill 链路未闭环**：`kimi_cli_source_path` → `vscode_legacy_approval` metadata 回填（测试已跳过）
4. **`apps/vscode` typecheck 遗留**：`replay-adapter.ts` 未迁移（旧文件错误，非新引入）
5. **kosong 2 测试全量并发 flaky**（openai-legacy parallel tool args / openai-responses streaming，隔离跑全绿）
6. **发布打包补 kimi-server-serve**：已修（2026-08-10，pack.mjs 随主二进制打包 serve；缺失时警告）；`KIMI_SERVER_BIN` 仍可显式指定
7. **用户真实 config.toml 损坏**：`duplicate defaultModel`（defaultModel 与 default_model 并存）导致 Rust TOML 严格解析拒绝整个配置（用户禁止修改真实文件，隔离配置验证绕开；建议用户侧删 camelCase 行）

---

# 2. 规模校准（codex 对照，2026-08-06 实测）

| codex crate | Rust 行数 | 我们的对应 | 现状 |
|---|---|---|---|
| `core` | 161k | kimi-agent（保留） | **99k** ✅ |
| `tui` | 206.8k | kimi-tui | TS 41k → **Rust 已完成攻坚**（G-4） |
| `cli` | 19.7k | kimi-cli | TS 9k → Rust 已落地大部分 |
| `app-server(+protocol/transport/client/daemon)` | 88k | kimi-server 系 | TS 16k → Rust 已落地主体 |
| `exec` + `exec-server` | 20.1k | kimi-exec | TS 2k → Rust ✅ |
| `codex-api` | 10.3k | kimi-sdk | TS 16k → Rust 骨架 2.4k（G-1 补齐中） |
| `protocol` / `config` / `state` | 54.6k | kimi-protocol/config/state | TS 5.2k → Rust 已落地 |
| `login` | 8.4k | kimi-oauth | TS 5.5k → Rust device flow ✅ |
| `sdk/typescript` | 2.9k | **不建** | 按 R-1 决策取消 |

**当前语言构成**：TS src ~232k + TS test ~167k；Rust ~147k+。迁移完成后：TS 仅剩 web+壳 ≈ 60k，Rust ≈ 240k+（Rust 主导 ≈75%+）。

---

# 3. 目标架构与 crate 现状

```
层1 协议层（纯类型，零 I/O）          kimi-protocol ✅
层2 引擎层（零 stdout，事件流输出）    packages/kimi-agent（保留，未拆 kimi-core/kimi-state）
层3 宿主协议层（引擎包成 JSON-RPC）    kimi-server / kimi-server-transport / kimi-server-client ✅
层4 界面层（只消费协议）              kimi-cli ✅ / kimi-exec ✅ / kimi-tui ✅（G-4 攻坚完成）
                                     kimi-sdk 🔶（G-1 补齐） / kimi-acp ✅ / kimi-oauth ✅
层5 前端/分发（保持 TS）              kimi-web(Vue) / vscode / npm 薄壳 / i18n 数据
```

**主线（抄 codex）**：引擎零 I/O → server 把引擎包成协议（MessageProcessor + in_process 用同一套 JSON-RPC envelope）→ 所有界面只消费协议。

## 已建 crate 现状

| crate | 状态 | 要点 |
|---|---|---|
| `kimi-protocol` | ✅ | JSON-RPC envelope + 91 方法常量 + wire_types（session/context/usage/task/plan/goal/hooks）；TS 绑定由 `gen-wire-contract.mjs` 生成（126 types，已含 metadata/work_dir 等新字段） |
| `kimi-server` | ✅ | MessageProcessor + in_process + 11 processor（session 44 方法全 + health/config/fs/git/approval/plugin/permission/cron/bg/task）；62+ 测试 |
| `kimi-server-transport` | ✅ | stdio serve + `kimi-server-serve` 二进制（事件扇出 stderr，无 512 行截断）+ WebSocket serve + HTTP/REST v1 投影（前端零改动直连）；29+ 测试 |
| `kimi-server-client` | ✅ | AppServerClient{InProcess, Remote} 门面 + typed methods + 并发调用（挂起 prompt 不阻塞 cancel） |
| `kimi-cli` | ✅ | clap 分发 + print/sessions/resume/config/doctor/health/export/acp/login/provider/upgrade/vis/web；全局 `--server <bin>`；`config --set`；真实 LLM 端到端已打通 |
| `kimi-exec` | ✅ | -p/print + run_prompt 经 AppServerClient |
| `kimi-tui` | ✅ | G-4 攻坚完成：61 命令全命令面 + 交互对拍（§6.4）；kimi-ui 渲染原语 + EventSource 统一事件源 |
| `kimi-sdk` | 🔶 | Session 45/45 + Harness + catalog（models.dev 归一化）+ config/errors + /btw 旁路 + EXIF 图片面；**G-1 补齐中** |
| `kimi-acp` | ✅ | stdio 适配器 + set_mode/set_model + session/update 通知回放 |
| `kimi-oauth` | ✅ | device flow（authorize/poll/refresh）+ `kimi login`（自动开浏览器） |
| `kimi-config` | — | **定案（2026-08-10）：不建独立 crate**——catalog 已内联于 kimi-sdk（`catalog.rs`）、config TOML/env/合并于引擎 `kimi-agent/src/config/`、diagnostics 于 kimi-sdk `config.rs`；§3 原"已建"描述作废，见 §8 |
| `utils/*` | 搁置 | 并入 kimi-native-tools/kimi-shared（path/cache/output_truncation/fuzzy/pty/token_count 均有 Rust 实现） |

**未拆分项**：`kimi-core`/`kimi-state`（保留 `packages/kimi-agent` 未拆分，计划与现状偏差，如需拆分再更新）；`crates/utils/*` 并入 native-tools/kimi-shared。

---

# 4. 依赖图

```
kimi-protocol ← kimi-agent(引擎) ← kimi-server ← kimi-server-transport
      ↑            ↑                ↑              ↑
      └────────────┴────────────────┴── kimi-server-client
                                          ↑
    kimi-cli / kimi-exec / kimi-tui / kimi-sdk / kimi-acp / kimi-oauth ──┘
                                          ↑
                   kimi-web(Vue)/vscode/npm 薄壳（TS）
```

---

# 5. TS → Rust 映射与退役表（当前有效）

| 现 TS 包 | 规模 | 处理 | 目标 | 状态 |
|---|---|---|---|---|
| `apps/kimi-code` TUI | 41k | 迁 Rust | kimi-tui | ✅ G-4 攻坚完成（TS 已删 2026-08-09） |
| `apps/kimi-code` CLI | 9k | 迁 Rust | kimi-cli | ✅ 大部分落地 |
| `apps/kimi-code` i18n/utils/constant | 9.4k | 迁/数据化 | kimi-tui + JSON 数据 | 🔶 |
| `kap-server` | 16.2k | 迁 Rust | kimi-server | ✅ 主体完成 → **已退役**（retired/，2026-08-10） |
| `node-sdk` | 16.2k | 迁 Rust | kimi-sdk | ✅ 消费面切换完成 → **已退役**（retired/，2026-08-10） |
| `kosong` | 11.1k | 迁 Rust | kimi-sdk LLM 面 | ✅ 核心能力引擎已覆盖（§8 决策）→ **已退役**（retired/，2026-08-10） |
| `oauth` | 5.5k | 迁 Rust | kimi-oauth | ✅ device flow → **已退役**（retired/，2026-08-10） |
| `acp-adapter` | 5.4k | 迁 Rust | kimi-acp | ✅ → **已退役**（retired/，2026-08-10） |
| `protocol` | 5.2k | 迁 Rust | kimi-protocol | ✅ → **已退役**（retired/，2026-08-10） |
| `kaos` | 3.1k | 退役/并 | SSH 面评估后裁并 | ✅ → **已退役**（retired/，2026-08-10） |
| `transcript` | 5k | 退役/并 | 本地化至 kimi-inspect | ✅ **已退役**（2026-08-10：唯一消费者 kimi-inspect 本地化，zod 依赖随迁） |
| `migration-legacy` | 4.2k | 退役 | 一次性数据迁移 | ⏳ 随 G-7 TS 入口退役（评估定案 2026-08-10：一次性宿主数据功能，不迁 Rust） |
| `pi-tui` | 13.2k | 退役 | kimi-tui 完成后删除 | ⏳ 仅剩 migration-screen 消费（560 行），随 G-7；slash-command-types/pi-tui-theme 死文件已删（2026-08-10） |
| `kimi-agent` 内 TS（rust-loop 3.4k + runtime 兼容 4k） | 7.4k | 退役 | Rust transport 已覆盖 | ✅ **已删除**（2026-08-10）：kimi-agent 包仅剩 Rust + 生成文件；proxy/logging-core 本地化至 apps/kimi-code |
| `kimi-web`/`kimi-inspect`/`vis/web`/`vscode` | 60k | **保留** | 唯一 web/壳 | ✅ |

**退役消费图（2026-08-10 复核）**：telemetry 已本地化至 apps/kimi-code（2026-08-10）→ **已退役**；剩余 transcript（apps/kimi-code 引用）/ migration-legacy / pi-tui 待 G-5/G-6。

---

# 6. 完成情况（阶段 A–F + G 系列）

## 6.1 阶段 A — 框架落地 ✅（2026-08-03）

crates/ workspace 骨架；kimi-protocol（rpc/methods 91 常量/wire_types）；types.rs 下沉 re-export；gen-wire-contract.mjs 自研生成器（离线无法引入 ts-rs）；cargo 全绿 + typecheck 0 + gen:wire 幂等。

## 6.2 阶段 B — 宿主协议层 ✅

kimi-server（MessageProcessor + in_process + ServerHostCallbacks/EventBus）；kimi-server-transport（stdio serve + kimi-server-serve 二进制 + **WebSocket** + **HTTP/REST v1 投影**）；kimi-server-client（InProcess/Remote + 并发调用）；session 44 方法族 + health/config/fs/git/approval/plugin/permission/cron/bg/task 全部处理器。测试：62+8+4+29+36 全绿。

## 6.3 阶段 C — CLI + exec ✅

kimi-cli（clap 分发 + 全局 `--server` + doctor config 检查 + 事件渲染 + `config --set` + sessions --json）；kimi-exec（print/run_prompt）；CLI 集成测试 36+；**真实 LLM 端到端打通**（2026-08-09：`kimi print "reply with exactly: pong"` → 块渲染 + stream-json + llm.delta 流式）。

## 6.4 阶段 D — TUI ✅（G-4 攻坚完成，2026-08-09）

- kimi-ui（render_event/transcript/EventSource）；kimi-tui（ratatui 主循环）
- **61 命令全命令面**（TS 42 条全覆盖）：/approvals /plan /swarm /goal /tasks /btw /endbtw /steer /import /export-md /discuss /workflow /provider /reload-tui 等 + 别名
- 交互对拍：审批（y/n/s/v + 危险命令检测 8 正则）、Tab 补全（命令/参数/模型/路径/@mention + ghost hint）、选择器（model/session/permission/skills/plugins/provider/tasks）、@mention 文件补全、bash 模式（`!`）、外部编辑器 Ctrl-G、剪贴板图片粘贴、帮助面板、工具结果 chip（Edit/Write/Read/Bash）、会话恢复 replay（history 消息级）、任务浏览器、登录 device flow、主题/locale/设置菜单
- **简化项（对拍记录，非缺失）**：agent-group/read-group 组卡片（单卡片渲染）；banner 网络拉取（footer 本地 tips）；experiments/multi-llm/feedback/web 提示命令；easter-eggs 未迁移
- **测试**：kimi-tui 117 + kimi-ui 11 全绿；TS TUI 已删除（189+123 文件，cba21d159）
- **剩余**：交互路径对拍测试（D-5）、媒体富卡片（终端图形协议，依赖终端支持，另议）、真实终端手动冒烟

## 6.5 阶段 E — SDK/ACP/OAuth/Config ✅（主体）

kimi-sdk（Session 45/45 + Harness + catalog 归一化 + config/errors + /btw）；kimi-acp（stdio 适配器 + 命令面）；kimi-oauth（device flow）；kimi-config（catalog ✅，TOML/env 细化待续）；**宿主面补全**（2026-08-05）：plugin 写面 7 方法、cron 面、archiveSession、plugin commands、cancelCompaction——node-sdk Rust 桥 **零 nativeUnavailable 残留**。

## 6.6 阶段 F — 退役 🔶（主体完成）

- ✅ npm 分发薄壳（kimi-code-rust-bin：bin 包装 + pack.mjs CI 打包 + KIMI_RUST_BIN 覆盖）
- ✅ 入口切换 wrapper（bin/kimi.mjs：优先平台 Rust 二进制，回退 TS dist/main.mjs；SIGINT/SIGTERM/SIGHUP 转发 + 退出码镜像；smoke:entry 冒烟双路径通过）
- ✅ klient 退役（2026-08-05 → retired/klient）
- ✅ F-5 全链路 Rust e2e（CLI/TUI/API/web 全 Rust：`--http` + `--assets` 端到端 + WS 事件流）
- ✅ 包退役第一批（2026-08-10）：node-sdk/kap-server/acp-adapter/oauth/protocol/kaos → retired/（环外引用清零后执行；vscode/vis 死配置清理、migration-legacy 死 kaos devDep 移除、flake.nix/lockfile 同步）

## 6.7 G 系列收口进度

| 步 | 内容 | 状态 |
|---|---|---|
| G-0 | 基线锁定（cargo 全绿 + vitest 收敛 + TS 存量冻结） | 🔶 2026-08-10：vitest 143→2 failed（kosong flaky）；引擎宿主面 4 项修复完成；TS 存量冻结 ✅（入口 FROZEN banner + 根 AGENTS.md 冻结清单） |
| G-1 | node-sdk → kimi-sdk 补齐 + apps 消费面切换 | ✅ 完成（2026-08-10）：kimi-sdk 大块 + vscode sdk-local 21 类型 + apps/kimi-code 本地化 + node-sdk 退役（retired/） |
| G-2 | kap-server → kimi-server + 前端直连 | ✅ 主体（Rust server 前端零改动；v1 wire 契约字段级对拍完成，遗留投影批次见 §7） |
| G-3 | apps/kimi-code CLI 消费面切 kimi-cli | 🔶 native-session 已完成 plugin/cron/archive；oauth 消费已本地化 + workspace 依赖清零（2026-08-10）；telemetry 面待续 |
| G-4 | TUI → kimi-tui 分片搬运（长杆） | ✅ 攻坚完成（P0-P6 分片，§6.4） |
| G-5 | kosong/kaos/protocol LLM 面并入；transcript/telemetry 收编 | 🔶 kimi-schema 规范化移植完成；kosong 核心能力引擎已覆盖（评估定案）；kimi-files 上传/capability/Astron 数据项随 node-sdk 退役 |
| G-6 | 退役（node-sdk/kap-server/acp-adapter/oauth/protocol/kaos → retired/；删 rust-loop.ts、TS i18n、TS 入口、pi-tui） | 🔶 11 包/模块退役完成（2026-08-10：9 包 → retired/ + rust-loop/runtime 删除）；剩余 migration-legacy/pi-tui 随 G-7 TS 入口 |
| G-7 | web-only 验证 + 删除全部旧 TS 测试 | ⏳ |

---

# 7. 当前缺失项（TODO，按 G 系列）

## G-1 — node-sdk → kimi-sdk 补齐（当前主攻）

- [x] kimi-sdk 大块（2026-08-10）：事件广播（subscribe/on_event/EventSubscription）、approval handler 事件驱动自动 resolve、tool handler（embedded HostCallbacks 注入）、MCP 全局配置（mcp.json store + OAuth flow + stdio 探测）、workspace skills、config diagnostics/ensure/removeProvider/getExperimentalFeatures（stub）、auth status 泛化 + getManagedUsage/submitFeedback/upload 三件套
- [ ] kimi-sdk 补齐 session/harness 剩余面（API 差异表：Session 51 方法 ~70% 对应，TOP 缺口为 onEvent/setApprovalHandler——**已完成**（事件驱动）；`set_question_handler` 定案不实现——引擎 AskUserQuestion 走 stop_turn + 下一条消息（§8））
- [ ] vscode 面：21 类型本地化（wire 生成或局部定义）后 `@moonshot-ai/kimi-code-sdk` 依赖可彻底删除（运行时可整体移除：isKimiError/createKimiHarness/effectiveModelAlias 已识别）
- [x] 发布打包补 kimi-server-serve（pack.mjs，2026-08-10：存在时随主二进制一起打包，缺失时警告并提示构建命令）

## G-2 — Rust server v1 wire 遗留投影

- [x] config snake_case 投影、wire_message_from_context 的 ContentPart→WireMessageContent 映射（think/tool_use/tool_result/image）、thinking_level 字段、usage/goal/turn.ended 事件投影（2026-08-10 复核：均已实现且有测试）
- [x] **compaction 事件投影**（2026-08-10：`session.compaction.started` → `event.session.compaction_started`；引擎无完成事件，`session/compact` RPC resolve 判定）
- [x] **tasks cancel 走 task 域**（2026-08-10：`task/cancel` 方法 + 处理器 + client typed；bg/stop 保留给后台任务）
- [x] code review 遗留 v1 #2/#3/#5（2026-08-10 复核）：#2 take_turn 100ms 竞争 → 2000ms 宽限（5b073f396）；#3 usage 全零覆盖 → Rust 投影真实 usage + 前端 usageSeen 守卫 + mappers `event.session.usage_updated` 消费；#5 消息 status 恒 pending → eventReducer `messageUpdated` 传递 status + AppMessage.status 字段 + REST 快照默认 completed（kimi-web）
- [ ] code review 遗留：MINOR 批（无原始记录，待复核）

## G-3 — CLI 消费面

- [x] oauth 消费本地化 + 依赖清零（3dcc1ea88 / 157bcd224，2026-08-10）
- [x] telemetry 消费面本地化（2026-08-10：6 处 import + 5 处 vi.mock → `#/utils/telemetry`；包已退役）

## G-4 — TUI 剩余

- [ ] 交互路径对拍测试（D-5）
- [ ] 真实终端手动冒烟清单（恢复会话/审批/@mention//plugins//tasks//goal next/Ctrl-G/图片粘贴）
- [ ] 媒体富卡片（终端图形协议，另议）

## G-5 — LLM 面并入

- [ ] kimi-files 上传（引擎无对应需求，随 node-sdk 退役）
- [ ] capability 矩阵 / Astron（数据项，随退役）

## 验证类

- [ ] TUI 全交互流式在真实 LLM 下的完整人工验证（引擎侧已通）
- [ ] ACP 兼容矩阵持续测试（依赖真实客户端）

---

# 8. 已决策记录（历史快照提炼，冲突时以本节省略为准）

## 测试策略
- **TS 用例平移 → 重写而非平移**（用户定案，2026-08-05）——TS 测试随层退役，Rust 侧重写
- **vitest 归因修复边界**（2026-08-10 用户质询后定案）：引擎侧修复保留长期价值；TS 层仅做基线必要适配，不深挖过渡层边缘行为（vscode in-process / node-sdk 随 G-6 退役）

## 引擎设计决策（非缺口）
- **setPermission 进程级**：Rust 引擎 permission 为 process-wide 设计（`permission/set_mode` 忽略 session_id）——kimi-sdk 签名已对齐
- **`prompt_cache_key` Moonshot 专属**：仅官方端点（api.moonshot.ai / *.moonshot.ai）发送，非 Moonshot 端点不发（真实 400 修复，对齐上游）
- **GitHub 工具族**：29 工具已移植（表驱动 + reqwest + 审批白名单）；**Workflow 不补**（Rust background+Swarm 已覆盖）
- **kosong 不搬运**：三协议 + SSE + 重试 + prompt_cache_key + usage 引擎已独立覆盖；独有缺口（kimi-schema $ref 规范化已移植、anthropic-profile 已复制本地化、kimi-files/capability/Astron 数据项）随 node-sdk 退役
- **image 不迁 kimi-sdk**：压缩核心已两处 Rust（native codec + engine media pipeline）；TS 退役后以 native codec 为基准合并（两套 Rust 压缩已 drift：EXIF/Triangle vs Lanczos3/alpha）
- **compaction 同步语义**：引擎 compact 是同步 RPC，无 in-flight 可取消 → `session/cancel_compact` no-op（契约注释早已承诺，2026-08-10 补注册）
- **summarizer 仅 native LLM**：host-proxy 会话 compact 报 `compaction.unable`（SDK 精确映射）；summarizer 独立通道是引擎设计缺口（§1.4.1），SDK 已按 `agent.nativeLlmProvider` 显式 opt-in 接线
- **kimi-sdk `set_question_handler` 不实现**（2026-08-10 定案）：引擎 AskUserQuestion 工具已改为"格式化内容 + stop_turn + 答案作为下一条消息"（`tools/ask_user.rs`），无反向 RPC；question 面由该机制覆盖
- **kimi-sdk tool handler 仅 embedded 生效**（2026-08-10 定案）：引擎 `HostCallbacks::execute_tool` 是进程内 trait 调用，stdio 传输无反向通道——与 node-sdk napi 嵌入模式一致；Remote harness 注册 handler 保持 API 对称但引擎侧不可达
- **MCP MRTR + CacheableResult 落地**（2026-07-28 协议，2026-08-10）：`inputRequests` 按 schema map 形状解析（修正 draft 数组偏差）；`roots/list` 自动应答（空 roots）+ 重试一次，sampling/elicitation 报描述性错误；`tools/list` 解析 `ttlMs`/`cacheScope` 提示（引擎不缓存，供宿主）
- **`get_experimental_features` 保持 stub**（2026-08-10 定案）：引擎 flags 无 RPC，node-sdk 侧也是空列表 stub，不新增协议面
- **`kimi-config` 不建独立 crate**（2026-08-10 定案）：catalog 内联 kimi-sdk、config TOML/env/合并在引擎、diagnostics 在 kimi-sdk config.rs——§3 crate 表该项改"不建"，避免重复实现
- **`task/cancel` 落 task 域**（2026-08-10）：TaskService::stop 走 `task/cancel`（bg/stop 保留给后台任务）；未知 id 报错而非假装成功

## 迁移发现并修复的真实 bug（节选）
- `session/export` 丢失 base64 编码；`config/set` 不建父目录；`CronProcessor` 未 start；`session/fs` Glob pattern 丢失
- `prompt_cache_key` 无条件发送破坏非 Moonshot 端点（真实 400，2026-08-09）
- EXIF 旋转：`image::load_from_memory` 不应用 EXIF，竖拍 JPEG 压缩后物理方向（2026-08-08 修复）
- kimi-server-serve stderr 事件 512 行硬截断（长驻宿主断流，2026-08-08 修复为无限扇出）
- `config/get`/`config/set` 误用 validated loader（空 home 50001，2026-08-10 修复）
- homedir 顶替 work_dir（跨宿主 resume/workDir 过滤错位，2026-08-10 修复）
- metadata 不持久化（approval flags 等跨 close/reopen 丢失，2026-08-10 修复）

## 引擎事件契约（宿主消费基准）
引擎事件为 `session.*` / `llm.*` 形状（session.turn.started/ended、llm.delta part、session.tool.started/settled、session.usage.updated、session.goal.updated、session.hook.result、session.task.*、session.compaction.started、session.approval.requested、session.shell.output）。宿主投影参考：kap-server `projectRustEvent`；vscode event-adapter 已迁移（2026-08-10）。SDK 原样转发 + sessionId/agentId 信封；SDK 合成事件仅 error（approval/question handler 失败）。

## 测试环境隔离
- `KIMI_AGENT_HOME` 指向 scratch store（node-sdk/vscode/kap-server，setup 文件预创建防并发竞争）——固定 session id 不跨运行泄漏 work_dir/metadata（2026-08-10）
- `KIMI_CODE_HOME` 隔离（kap-server setup-env / 引擎配置加载）——集成测试不得读真实用户配置

---

# 9. 风险与决策点

1. **TUI 框架**：ratatui/crossterm（评估是否跟 codex 的 nornagon fork——键盘增强/焦点事件；需要交互增强则跟 fork）
2. **协议契约**：TS 绑定由 gen-wire-contract.mjs 生成（126 types 已验证）；ts-rs 离线不可用暂不引入（联网后可选迁移）
3. **i18n**：文案 → 数据文件保留，Rust 读（rust-i18n 或自建）；Rust 内置 en/zh 已对齐关键文案
4. **kaos SSH**：无 Rust 对应且无引擎需求——评估保留薄 TS 或裁剪
5. **双轨运行**：迁移期间 TS 壳与 Rust 宿主并行（同协议），逐步切换入口；wrapper 双轨并存，Rust 全绿后删 TS 入口
6. **node-pty**：TUI 的 pty 依赖 → Rust 侧 portable-pty 或 windows-sandbox 方案
7. **McpServerSpecInput/SkillMetadataInput**：带引擎转换 impl，暂留 kimi-agent；后续以 free-fn 重构下沉

---

# 10. 关键提交索引（迁移批次，倒序）

| commit | 内容 |
|---|---|
| `1f2181881` | node-sdk 跨 harness session 列表、replay tool 记录、引擎 home 测试隔离、vscode 测试裁剪 |
| `1e019baf0` | 引擎：work_dir 独立参数 + set_work_dir_force、metadata 持久化 + SessionSummaryRpc.metadata、cancel_compact no-op |
| `3ed190ab4` | SDK 默认 llmStep + toolExecute 桥；vscode event-adapter 引擎形状迁移；session.tool_handler_error 错误码 |
| `9bf024142` | 测试适配批次（引擎事件契约/G-6 转发器/i18n key/vue 插件/telemetry createRequire） |
| `2b7aaf435` | 引擎：config/get·set 空 home 容忍（unvalidated loader） |
| `0da8dce9f` | kosong native fast-path 与 SDK 错误/usage 语义对齐 |
| `cba21d159` | G-6：TS TUI 退役（189+123 文件删除），run-shell 改 Rust bin 转发器 |
| 2026-08-09 批次 | kimi-schema 规范化移植、真实 LLM 端到端、prompt_cache_key 修复、G-4 P0-P6 分片 |
| 2026-08-08 批次 | G-1/G-2 系列（catalog 归一化、/rust 消费重写、v1 wire 契约对拍、EXIF 修复、F-5 e2e） |
| 2026-08-05 批次 | 宿主面补全（plugin/cron/archive/cancelCompaction）、CLI 收尾、退役消费图复核 |
| `4b4db39e0` + `6681aec78` | 阶段 A 框架落地（2026-08-03） |
