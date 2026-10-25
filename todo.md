# 301 待对齐事项

更新时间：2026-10-27

## 口径

- 本文件只记录**尚未完成的对齐项**，保留两次 Review 统一整理时的 E 编号，便于回溯。
- 行为基线为 `44cdf8f4039e`；2026-10-27 已 rebase 到 `main@origin=4be3f0b741e1`，后续以当前重叠审查与验收结果为准。
- E02、E03、E04、E05、E16、E18 已在媒体兼容轮次完成并验证，不再列入待办；执行事实见 root `f2bef09f`。
- 优先级沿用 Review 结论；E13 在两个会话中定级不同，本文件按较高的 P1 处理。
- 修改时保留现有工作副本全部改动，不机械回退整个模块，不新增测试文件或测试用例数量，不通过放宽断言掩盖差异。

## 一、最新 main 集成与验证

### M01 最新 main 集成与重叠行为验收

- 当前状态：已 rebase 到 `main@origin=4be3f0b741e1`；`toolSelect.e2e.test.ts` 已同时保留 `sessionService` / MCP discovery 与 native `Message/toolsOf`，本次新增的 `fullCompaction.test.ts` / `scripted-generate.ts` 冲突已合并，fullCompaction 114/114 通过。5 份 main 新带入的测试已完成 native 消息适配，M01 前置集成、MCP、stopped subagent、媒体恢复及 migration／ACP／klient direct-generate 覆盖验收已完成，剩余重叠行为复核与最终验收。
- 对齐目标：保留 main 的 MCP discovery／自动重连、跨 turn／compaction 媒体恢复和 stopped subagent partial output，同时保留 301 native Message 与 LLM 路径，不把 main 后续行为误算成 301 回归。
- 前置集成验收（已完成）：`prompt-cache-guard.ts`、`forkParity.test.ts`、`llmRequester.test.ts`、`llmRequesterService.test.ts`、`undo.test.ts` 已适配旧 requester 路径、legacy DTO 与媒体形状；agent-core-v2 / kap-server / klient typecheck 和根 build 通过，本地及 m0-dev 四份可执行测试均为 131/131，未删除或跳过测试，未放宽断言，测试声明未变。
- MCP 验收（已完成）：pending 和 pending 中取消均为零 provider 请求，取消终态为 `cancelled`；ready 后第一条 history 含 `<tools_added>`；deferred MCP schema 不进入顶层 `tools[]`；transient failure 后自动重连，工具发现恢复且真实 `echo` 调用成功；OAuth callback 关闭随套件通过。本地两份修改测试 57/57，m0-dev 17 份 MCP／toolSelect／workspace／OAuth 文件 423/423，agent-core-v2 typecheck 通过，测试声明未变。
- 媒体验收（已完成）：media-degraded／media-stripped 的恢复状态跨下一轮和 compaction 保留，覆盖 `llmRequester`、`llmRequesterService`、fullCompaction 与 undo。m0-dev 四文件 226/226（18 + 59 + 114 + 35）；两种状态均验证下一轮 prefix extension，auto／manual × tool-select × media 的 18 组矩阵保持 recovered prefix，compaction 内两种恢复及 undo 后完整媒体恢复均通过。未改产品或测试，测试声明未变。
- 子 Agent 验收（已完成）：真实 `fork: true` 后台子 Agent stopped 后公开 `subagent.cancelled` 恰好一次，TaskStop 将两段 partial output 返回父 Agent；非 abort provider failure 返回 `subagent.failed` 和 partial output；`includeSubagents` 完整 replay 保留父子消息且文本不重复，原 live 路径保持通过。本地 `session-prompt-events` 18/18，m0-dev 11 份相关文件 404/404，Core 与 node-sdk typecheck 通过，测试声明未变。
- migration／ACP／klient direct-generate 覆盖（已完成）：migration 严格比较非 assistant `toolCalls`；ACP 同用例覆盖 Bash streaming metadata、实时媒体输出和 `session/load` 媒体 replay；klient 共享 conformance 覆盖 direct-generate 输入 wire 与 part／finish 公开媒体。修改测试本地 95/95，m0-dev ACP 全套、migration、contextTranscript 与 klient memory／IPC 共 18 文件 246/246；三包 typecheck 和 focused lint 通过，三份修改文件声明计数 9 → 9、24 → 24、26 → 26，skip/todo 均为 0 → 0。
- 重叠复核：按本次 main 与 301 的重叠文件逐项核对；TUI、CSP、workspace 回收等非直接重叠变化由最终全量覆盖，不新增定向事项。

## 二、本轮 Review 外部回归（待修复）

### E22 SDK／klient 自定义工具的旧公开媒体输入在 Core 边界崩溃（P1）

- 外部输入与差异：公开 `toolCall`／`interactions.respond` 返回 `imageUrl`／`audioUrl`／`videoUrl` 旧形状时，main 可把媒体带入后续 LLM 请求；301 的 `bridgeUserTool` 未转换为 Core `source`，后续 blob dehydrate、持久化或协议编码读取 `undefined.kind`，无法发出下一次请求。探针已复现 `TypeError`。
- 落点：`packages/node-sdk/src/v2/session-wiring.ts`、`packages/agent-core-v2/src/agent/userTool/userToolService.ts`、`agent/blob/agentBlobServiceImpl.ts`、`wire/wireService.ts`。
- 验收：从真实 SDK 自定义工具回调返回三类公开媒体，经持久化、恢复和下一次请求均不抛错，最终 provider body 与 main 等价；公开事件仍返回旧形状，内部 native part 不被重复转换。

### E23 三类 durable record 绕过持久化 codec（P1）

- 外部输入与差异：`turn.prompt.input`、`turn.steer.input`、`prompt.steered.content` 可携带媒体，但当前 `toPersistentWireRecord`／`fromPersistentWireRecord` 未覆盖它们，导致 main 的 legacy `imageUrl` 落盘形状变成 native `source/meta`，没有版本提升或 migration。
- 落点：`packages/agent-core-v2/src/agent/loop/turnOps.ts`、`agent/prompt/promptEvents.ts`、`wire/wireService.ts`。
- 验收：三类 record 新写入仍使用既有 legacy 持久化格式；main 旧记录和 301 新记录经统一冷读得到相同 Core 内容，旧 reader／vis 不被新 native 形状破坏，持久化 schema 和版本不被顺带扩大修改。

### E24 WS／node-sdk 的 steer／splice 事件泄漏 native 媒体结构（P1）

- 外部输入与差异：kap WS 的 `turn.steer`／`context.spliced` 以及 node-sdk 的 `turn.steer` 仍走原样转发分支，公开 payload 从 main 的 `imageUrl` 等形状变成 Core `source/meta`；`context.spliced` 的非 assistant 消息还可能缺少公开 `toolCalls`。node-sdk 的 `context.spliced` 原本丢弃，不在本项扩范围。
- 落点：`packages/kap-server/src/transport/ws/v1/sessionEventBroadcaster.ts`、`packages/node-sdk/src/v2/event-mapper.ts`、`packages/agent-core-v2/src/agent/contextMemory/contextMemoryService.ts`。
- 验收：带图片、音频、视频的实时 steer／splice 事件在 kap WS 和 node-sdk 出口恢复旧公开媒体及非 assistant `toolCalls` 形状，不泄漏 Core `source`；普通文本与业务 metadata 不变。

### E25 vis blob rehydration 与新 wire reader 的 native 输出不兼容（P1）

- 外部输入与差异：`readAgentWire` 已在 migration 后把持久记录解码为 Core `source`，但 `rehydrateParts` 仍无条件读取 `imageUrl.url` 等旧字段，含媒体的 `GET /:id/wire` 或 `GET /:id/context` 会抛出 `TypeError` 并返回 500。
- 落点：`apps/vis/server/src/lib/wire-reader.ts`、`blob-resolver.ts`、`routes/wire.ts`、`routes/context.ts`。
- 验收：经真实 `readAgentWire → rehydrateWireEntries → route` 链覆盖 URL、inline、blobref 图片／音频／视频，响应正常返回且 blobref 仍改写为 vis blob URL；legacy 与 native 输入均不读不存在的字段。

### E26 transcript 为以前忽略的普通远程／内联媒体新增附件（P2）

- 外部输入与差异：同一 main legacy 记录中的普通远程 `imageUrl` 等 media，main 不生成附件，301 现在返回新的 `att_N` 和 `attachmentIds`；内联媒体也扩大了附件生成范围，超出 E04 恢复 native store 附件的目标。
- 落点：`packages/transcript/src/history/groupTurns.ts` 及 kap transcript 投影。
- 验收：相同旧记录在 main 与 301 的 `attachments`／`attachmentIds` 基数和形状一致；普通远程／内联媒体不新增契约外附件，同时保留 E04 已确认的 daemon／file／store 附件恢复行为。

## 三、独立基线跟踪

### V01 非 301 的 survey 基线失败仍需单独跟踪

- 当前全量结果为 `17373 passed / 9 failed / 39 skipped`，9 个失败均为此前已证明的 survey 基线失败，不是本轮媒体改动引入。
- 对齐要求：不要把这 9 个计入 301 的新增回归，也不要通过删除/跳过测试使其变绿；如需全量全绿，应在独立基线任务中处理。
- `sessionExport` 的首轮独立失败已单跑 22/22 通过，按环境波动记录，不列为待办。

## 完成判定

- [x] E06–E20 中上述未完成项全部实现并勾选，不引入新的行为差异。
- [ ] E22–E26 的外部回归全部修复并完成对应真实调用链验收，不引入新的行为差异。
- [ ] M01 rebase 集成、MCP discovery／自动重连、跨 turn／compaction 媒体恢复、stopped subagent partial output 与重叠行为验收完成。
- [x] E01 修复后根 `corepack pnpm build` 通过；相关包 typecheck/build/lint 通过。
- [ ] 聚焦测试和 m0-dev 全量套件无新增失败；测试声明总数不增加。
- [ ] 除 E06 明确确认的 LLM tool-call ID 规范化新契约外，所有公开 replay、klient/kap/ACP wire、旧会话恢复、媒体与四协议请求/响应行为与基线对齐。

## 已完成，不再列入待办

- E01 公开 replay 非 assistant 消息缺少 `toolCalls`，以及 import-context 的 Core 非法字段。
- E02 kap 冷读取媒体历史失败。
- E03 `media://` 恢复后无法进入 media store。
- E04 transcript 跳过 native store 附件。
- E05 工具媒体输出泄漏 Core `source`。
- E06 LLM 统一处理 tool-call ID 的合法化、唯一化、`rawId`、流式与最终消息一致及 attempt 隔离；E06 前快照对照已排除 migration/sessionIndex 为新增回归，migration 归 E07 收尾。
- E07 facade 不再引入 `undefined` 自有属性；旧会话 transcript 的非 assistant 消息恢复 `toolCalls: []`，assistant 保留真实调用。
- E08 直接 Kimi factory 默认经 `kimiEndpoint` 读取环境连接，显式 endpoint 与 model 字段保持优先。
- E09 旧 `kimiProvider` 默认 beta 路由改变。
- E10 自定义 discovery seed 的运行时 capability；由 requester 按协议推导，显式字段优先，不在 snapshot 物化推导结果。
- E11 Kimi thinking 被静默改写。
- E12 OpenAI reasoning 方言记忆丢失。
- E13 混合 reasoning 历史被重写。
- E14 上下文窗口合并规则：有效正数窗口单一取值、双窗口取最小，显式 cap 与 Kimi 缺省填充统一；不恢复旧低层不钳制行为。
- E16 data URL MIME 参数丢失。
- E17 异常顶层 usage 遮蔽有效 choice usage。
- E18 Anthropic 重复音频占位。
- E19 非法 headers timeout 恢复对 custom client 与 Google 的豁免；默认 OpenAI / Responses / Anthropic 仍提前校验并保持既有错误路径。
- E20 低层 OpenAI / Responses / Anthropic catalog ping 恢复 headers-timeout fetch；Google、主 Agent 请求与 `IModelCatalog.ping` 路径不变。
- E21 历史 reasoning key 推断跳过 `reasoning_details`，未标记 ThinkPart 不再把详情数组覆盖成字符串；OpenAI／Kimi 真实请求体恢复详情数组与普通 reasoning 字段，E12／E13 行为不变。
