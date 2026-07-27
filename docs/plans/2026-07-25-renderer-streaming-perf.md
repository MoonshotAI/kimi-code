# 渲染层流式性能治理（P0）实施计划

> 交给执行者的实施计划。本文档自包含，不需要其他上下文。
> 问题调研结论见 §1（含文件:行号与实测数据，执行时不必重查）；所有改动先在 `apps/desktop` 开发验证，再同步 `apps/web`（`apps/web` 对应文件为同步副本；共享包 `packages/*` 改一次两端生效）。
> 仓库硬约束：只动 token 不手写样式值；新逻辑抽纯函数并在 `apps/desktop/tests/renderer/` 配单测；每 PR 带 changeset（只选 `kimi-code-app`，`patch`）。

## 1. 背景：调研结论

### 1.1 测量方法与基线

2026-07-25 实测（M5 Pro / 24GB / macOS 26.3.2，dev build 0.0.10，Electron 43.1.1，CDP `Profiler` + `Performance.getMetrics` + rAF 帧间隔 + 页面内 MutationObserver；采集脚本在 `/tmp/kimi-perf/cdp-profile.mjs`，计划固化为 `scripts/perf-profile.mjs`）：

| 场景 | 主线程 Task | Script | RecalcStyle | DOM | Heap |
|---|---|---|---|---|---|
| 空闲 | ~0 ms/s | ~0 | ~0 次/s | 3.7k | 43MB |
| 6-agent swarm 运行（120s） | 峰值 302 ms/s | ~13 ms/s | 54 次/s | 9.4k | 58→76MB |
| 3000 行/30 代码块流式（150s） | **平均 449，峰值 649 ms/s** | 51-75 ms/s | **217 次/s** | 9.4k→**37k**（结束后折叠回落 12k） | 60→峰值 310→78MB |
| 后台会话流式、前台静态（36s） | **158-185 ms/s** | 11-13 ms/s | **120 次/s** | 不变 | 143→230MB |
| 同前台、无后台流式（对照） | 0.1-23 ms/s | ~0 | ~0 次/s | 不变 | 稳定 |

热点函数（150s 大流量流式，self）：markstream 代码块组件 4234ms（total 5.2s）、`updatePanesScrollbarWidth` 2922ms、`updateProps` 2750ms、shiki 引擎 total ~3.3s（js 1.8s + wasm 1.5s）、markdown 结构解析 total 2.1s、`getBoundingClientRect` 1425ms、`messagesToTurns` 860ms（total 1.1s）、GC 1144ms、vue-i18n 735ms。

帧率：M5 Pro 上 120Hz 守住（p50=8ms，max=24ms，无 >50ms 长任务）——问题表现为主线程 45-65% 持续占用与发热降频风险；每帧成本随 transcript 规模线性放大（9k 节点→302ms/s，37k→649ms/s），即「长程任务越跑越卡」的二次方机制。

### 1.2 问题清单（本计划治理范围）

#### P-A 前台 transcript 被后台会话流式无辜重算（跨会话串扰）

实测实锤：前台停在**完全静态**的会话，后台另一会话流式输出时，前台的 `messagesToTurns` 逐帧重跑（`continuesAssistantGroup @ messagesToTurns.ts:325` self 311ms/30s、`absorbContent :378` 82ms/30s），下游前台 `EditTool.vue:27`（72ms/30s）、`toolDiff.parseArg/buildWriteContent`（124ms/30s）全部跟着重渲染。对照组（无后台流式）这些为 0。

根因：reducer 回写是**整表替换**。

- `useKimiWebClient.ts:891-893`：`processEvent` 的 `shallowEqualRecord` 守卫是按 entry 比的——只要后台会话 B 的消息数组变了就 `setMessagesBySession(next.messagesBySession)` 整表替换；
- `useKimiWebClient.ts:588-604`：`setMessagesBySession` / `setSessionMessages` / `updateSessionMessages` 三个 funnel 都是 `{...rawState.messagesBySession, ...}` 整表新建。

前台的 `turns` computed（`useKimiWebClient.ts:2093-2106`）读 `rawState.messagesBySession[sidA]`，依赖挂在 rawState 的 `messagesBySession` 键上——父表身份一变即失效，不管改的是不是自己会话。`approvalsBySession` / `tasksBySession` / `questionsBySession` / `goalBySession` 等切片（`:894-923`）同款问题，各自串扰对应 computed（如 `activeAppTasks :2084`）。

有利条件（结构共享可行性已确认）：`eventReducer.ts:167-190 cloneState` 是**浅克隆**（`{...s.messagesBySession}`），且 reducer 对未变消息保持引用（`eventReducer.ts:85-87` 只替换变化的 entry）——未变消息对象跨事件身份稳定。

#### P-B `messagesToTurns` 全量重建 + ChatTurn 身份全变

`useKimiWebClient.ts:2093` 的 `turns` computed 每个流式帧对**全部**消息 O(n) 重建全部 ChatTurn（`messagesToTurns.ts:554`），且每个 turn 都是新对象 → `ChatPane.vue:729` keyed `v-for` 下游全部子组件重新 patch（Vue patch 成本是流式期间最大的分散项：`updateProps` 2750ms、`resolveTransitionProps` 1278ms、`setFullProps` 1295ms/150s）。`HighlightedCode.vue:138-143` 的注释已经在为这种身份 churn 打补丁（值比较防抖），应在源头解决。

#### P-C 侧栏按流式频率刷新

实测：后台流式期间侧栏 sessions group 以 ~4Hz 变更（152 次属性/子树变化 per 36s，前台 MutationObserver 记录），RecalcStyle 120 次/s，是前台 TaskOther 144-165ms/s 的主要构成。`eventReducer.ts:170-176` 已保证 `sessions` 数组引用在无关事件下稳定，所以驱动源是**别处**——候选：`sessionUsageUpdated` 事件处理（`useKimiWebClient.ts:941-954`，三个 `*BySession` 整表 spread，且该事件在流式期间高频到达）；`turnActiveBySession` 切片回写（`:915-917`）；侧栏用量/状态展示组件。**实施第一步是定位确切驱动源**（方法见 §3 P-C）。

#### P-D 滚动跟随的强制同步布局

`updatePanesScrollbarWidth`（`ConversationPane.vue:519-523`）在 ResizeObserver 回调（`:1636-1653`）里读 `offsetWidth/clientWidth/offsetHeight` 并写 ref——流式期间内容每帧变化 → 每帧强制同步布局，self 2922ms/150s；写出的 `panesScrollbarWidth` 又驱动容器 style 绑定（`:488-491`），是 217 次/s RecalcStyle 的来源之一。`updateActiveTocQuery`（`:351-380`）每次执行 `querySelectorAll('.turn-anchor')` + 逐个 `getBoundingClientRect`（1425ms/150s）。

#### 排除项：markstream skeleton「卡死」动画——误诊，已复核排除

初版报告称发现 markstream 代码块 skeleton shimmer 动画无限运行烧 CPU。复核：页面内全部 `.skeleton-line` 均在 `display:none` 祖先下（`Markdown.vue:381-389` 传入的 `loading: false` 生效，markstream header 的 `vShow` 正常关闭），不参与绘制；`getComputedStyle().animationPlayState` 对 display:none 元素也报 running，系误判方法有误。已静止会话实测 Task 0.1ms/s、TaskOther 0。**此项不做任何改动。**

## 2. 目标 / 非目标

**目标**

1. 消除跨会话串扰：后台会话流式时，前台 `messagesToTurns`/工具卡片重算与重渲染降为 ~0。
2. 流式自身成本去二次方化：已落定 turn 不参与每帧重算与 patch。
3. 侧栏刷新与流式频率解耦。
4. 滚动跟随每帧最多一次强制布局。
5. 全程量化验收：同一负载剧本复测，达到 §5 指标。

**非目标**

- 不做 transcript 虚拟列表（P2 候选，待 P0+P1 后评估）。
- 不动 markstream/shiki 流式高亮降频（另一独立项，见 §6 待办）。
- 不动 reducer/投影层协议与 server。
- 不追求本机帧率进一步提升（M5 Pro 已无掉帧，目标是降 CPU 占用与放大系数）。

## 3. 实施项

### P0-A reducer 回写改为按 key diff-apply（消除串扰）

**改动文件**：`apps/desktop/src/renderer/composables/useKimiWebClient.ts`（同步副本 `apps/web/src/composables/useKimiWebClient.ts`）。

**做法**

1. 新增纯函数 `applyRecordDiff(target, next)`（放 `composables/client/` 下独立文件，配单测）：逐 key 比较 `next` 与 `target` 的 entry 引用，仅对引用变化的 key 执行 `target[key] = next[key]`；`next` 中消失的 key 执行 `delete target[key]`。**不替换父表对象本身**。
2. 改写三个 funnel（`:588-609`）：`setMessagesBySession(next)` 改为 `applyRecordDiff(rawState.messagesBySession, next)`；`setSessionMessages` / `updateSessionMessages` 改为直接 `rawState.messagesBySession[sessionId] = ...`（不再 spread 父表）；`removeSessionMessages` 改为 `delete rawState.messagesBySession[sessionId]`。
3. `processEvent` 回写段（`:891-923`）：`messagesBySession / approvalsBySession / planReviewByToolCallId / questionsBySession / tasksBySession / goalBySession / goalVersionBySession / lastSeqBySession / turnActiveBySession / turnEndedPromptIdBySession / compactionBySession` 全部从「浅比较后整表替换」改为 `applyRecordDiff`（浅比较逻辑被吸收进 diff）。`:941-954` 的 `swarmModeBySession / planModeBySession / thinkingBySession` spread 改为按键赋值。
4. Vue 响应式注意点：按键赋值仍会触发**遍历该表的 effect**（`Object.keys`/`for...in` 依赖 ITERATE key）。排查全仓对 `messagesBySession` 等表的遍历消费（内存管理、LRU 等），确认这些 effect 重跑是可接受的（它们本来就需要在全量增删时跑）；不做规避。

**验收**

- 单测：`applyRecordDiff` 的行为用例（变/不变/删除/新增 key）。
- profile 验收（剧本 §5-A）：后台流式时前台 profile 中 `messagesToTurns`/`continuesAssistantGroup`/`absorbContent`/`EditTool`/`toolDiff` 耗时 ≈0；前台 Script <3ms/s。
- 回归：`pnpm test`、`pnpm typecheck`、`pnpm lint`；手工回归会话切换、归档（`forgetSession` 路径）、乐观消息、加载更早消息。

**风险**：消费方若有依赖「父表身份变化」的隐式契约（如 `watch(() => rawState.messagesBySession, ...)` 非 deep 非逐键），按 key 写入后不再触发。实施时 grep `messagesBySession` 全部读取点逐一确认语义（多数按 key 读，不受影响）。

### P0-B `messagesToTurns` 结构共享（已落定 turn 引用保持）

**改动文件**：`apps/desktop/src/renderer/composables/messagesToTurns.ts`、`useKimiWebClient.ts`、`composables/client/useSideChat.ts`（及 web 侧同步副本）。

**做法**

1. `messagesToTurns` 增加可选参数 `prev?: ChatTurn[]`（或导出 `createTurnsProjector()` 闭包工厂持上一轮结果，推荐工厂形式，调用侧更干净）。内部按 turn id 建 prev 索引；每组装完一个 group，与 prev 同 id turn 做来源级比较：
   - 来源消息引用序列逐位 `===`（浅克隆保证未变消息身份稳定，见 §1.2 P-A 有利条件）；
   - approvals / planReviewByToolCallId 中与本 turn 相关的条目引用 `===`；
   - `sessionActive` 标量相同。
   全部相同 → 直接复用 prev 的 ChatTurn 对象（连同其 `blocks`/`tools` 数组），跳过 `textParts.join` 等重建。
2. 在 ChatTurn 上用一个非模板可见字段（如 `Symbol` key 或 sidecar `WeakMap<ChatTurn, AppMessage[]>`）记录来源引用序列——优先 WeakMap，不污染数据结构。
3. 调用侧改造：`useKimiWebClient.ts:2093-2106` 从 computed 改为 `shallowRef` + `watch([() => messages, ...], project, { immediate: true })`，把 `turns.value` 作为 prev 传给投影器；`useSideChat.ts:76` 同样接入。
4. 已有行为不变式：尾组 live 规则（`messagesToTurns.ts:600-613` 的 running→ok settle、goal-continuation seed 等）必须原样保留——这些分支的 turn 每次都会变化，自然不复用。

**验收**

- 单测：尾部流式追加时前 N-1 个 turn 引用逐一 `toBe` 不变；等价输入两轮投影输出深度相等（防漏比字段）；approvals/planReview 变化只影响相关 turn。
- profile 验收（剧本 §5-B）：`messagesToTurns` total 从 1.1s/150s → <100ms/150s；`updateProps`/`resolveTransitionProps`/`setFullProps` 合计下降 ≥70%；GC 从 1.1s/150s → <400ms/150s。

**风险**：浅比较漏字段 → UI 不更新。防线：来源序列 + 相关外部输入的全字段清单集中在投影器一处；单测覆盖「等价输入输出深度相等」的往返断言。

### P0-C 侧栏刷新解耦（先诊断、后修复）

**诊断步骤（必须先做，半天内）**

1. 在页面注入 MutationObserver 记录 `.sessions` / workspace group 子树的属性与子列表变化（**先断开 agent-browser 连接**，其 `data-__ab-ci` 标注会污染记录）；同时 monkey-patch `Array` 构造与关键响应式写入点打栈，或在 `processEvent` 入口临时插桩：记录每个事件类型导致的 `rawState` 写路径。
2. 确认驱动源是 §1.2 P-C 中哪个候选（大概率：`sessionUsageUpdated` 高频事件 + `:941-954` 的整表 spread 使侧栏读取方失效）。产出结论后更新本文档。

**修复（按诊断结论二选一或组合）**

- 若驱动源是 `*BySession` 整表 spread：P0-A 的按 key 赋值覆盖 `:941-954`，天然消除。
- 若驱动源是侧栏组件对高频数据（用量、活动时间）的直接订阅：在该展示层加 500ms-1s 节流（如 `useThrottledRef`），状态翻转类（busy spinner、attention pill）不节流。

**验收**

- profile 验收（剧本 §5-A）：后台流式时侧栏 DOM 变更 ≤1Hz（状态翻转瞬时除外）；前台 RecalcStyle <20 次/s；前台 TaskOther <50ms/s。

### P0-D 滚动跟随布局读取治理

**改动文件**：`apps/desktop/src/renderer/components/chat/ConversationPane.vue`（web 侧同步副本）。

**做法**

1. `updatePanesScrollbarWidth`（`:519`）加值守卫：新值与 `panesScrollbarWidth.value` / `dockHeight.value` 相同则不写 ref（写 ref → style 绑定更新 → RecalcStyle）。
2. ResizeObserver 回调（`:1636-1653`）内的 `scheduleTocTableHitTest` 与滚动跟随几何读取合并进同一个 rAF（参照已有 `scheduleActiveTocUpdate :388` 的 raf 合并模式），保证每帧最多一次强制布局。
3. `updateActiveTocQuery`（`:351-380`）：锚点 top 数组改为缓存制——turns 结构变化或滚动停止 150ms 后才重测 `getBoundingClientRect`；滚动中按缓存数组二分查找 paneMiddle 对应锚点。缓存逻辑抽 `lib/` 纯函数配单测。

**验收**

- profile 验收（剧本 §5-B）：`updatePanesScrollbarWidth` self 从 2922ms/150s → <100ms；`getBoundingClientRect` 从 1425ms → <200ms；RecalcStyle 从 217 次/s → <80 次/s。
- 手工回归：底部跟随、翻页恢复、TOC 点击定位与高亮、折叠展开时的 pin 行为（对照 `docs/plans/2026-07-22-chat-scroll-stability.md` 的回归清单）。

**风险**：TOC 高亮滞后半拍（缓存窗口内）。可接受——用 150ms 滚动停止兜底，视觉无感。

## 4. 实施顺序与工作量

| 顺序 | 项 | 预估 | 备注 |
|---|---|---|---|
| 1 | P0-A 按 key diff-apply | 0.5-1 天 | 纯函数 + funnel 改写，风险低，收益立即 |
| 2 | P0-B turns 结构共享 | 1-1.5 天 | 依赖 P0-A 的引用稳定前提；单测要厚 |
| 3 | P0-C 侧栏诊断+修复 | 0.5-1 天 | 诊断半天，修复视结论 |
| 4 | P0-D 布局读取治理 | 0.5-1 天 | 滚动逻辑回归面广，放最后 |

建议拆 4 个 PR 分别合入（每项独立可发、独立可回滚）。

## 5. 量化验收剧本

固化负载剧本（采集脚本 `scripts/perf-profile.mjs`，由 `/tmp/kimi-perf/cdp-profile.mjs` 移入并按仓库规范整理）：

- **剧本 A（后台串扰）**：会话 X 发 3000 行/30 代码块流式任务，立即切到静态会话 Y，采集 60s。目标：前台 Task <30ms/s、Script <3ms/s、RecalcStyle <20 次/s、TaskOther <50ms/s、heap 增长只来自后台会话消息累积（不来自前台重渲染）。
- **剧本 B（前台流式）**：当前会话发同样的任务，采集 150s。目标：Task 平均 <200ms/s、峰值 <300ms/s；`messagesToTurns` total <100ms/150s；markstream+shiki 维持现状（另一项治理）；RecalcStyle <80 次/s；`updatePanesScrollbarWidth` <100ms/150s。
- **剧本 C（swarm）**：6-agent AgentSwarm 并行探索，采集 120s。目标：Task 峰值 <200ms/s（现状 302ms/s）。

每个 PR 合入前跑对应剧本并在 PR 描述贴前后对比数据。

## 6. 后续待办（不在本计划）

- markstream 流式代码块 shiki 降频/增量高亮（实测最大单点：index8+shiki ~8.5s/150s）——方案二选一：自定义 CodeBlock 组件移植 `HighlightedCode.vue` 的 200ms SWR 节流；或 `pnpm patch markstream-vue` 在其 `watch(node.code)` 加节流。
- **shiki oniguruma wasm 堆只增不减（已查清，2026-07-25 heap snapshot）**：压测期间 onig 的 `WebAssembly.Memory` 涨到 **206.8MB**（retainer 链 `OnigScanner → CompiledRule → WasmTrustedInstanceData`，另有 25,948 个 `CaptureRule`）。每次高亮在 wasm 堆分配且内存只能 grow。治理并入流式高亮降频项（少跑=少分配），另可评估会话切换时空闲重建 shiki engine（代价：语法重编译 ~240ms）。
- **detached DOM 驻留：已查清，无泄漏（2026-07-25）**。大会话切走后 CDP Nodes 67k，强制 GC ×2 → 22k；heap snapshot（270MB 文件，3.78M 节点）确认 JS 堆 detached 仅 8,010 节点 / 0.8MB，且 retainer 大头是调试工具自身（DevTools console handles / CDP eval）与少量 Vue tooltip ref 残留。会话切换的游离节点是 GC 节奏问题，无需修。
- **Blink a11y 树脏对象（已查清，工具放大）**：快照中 `AXDirtyObject` 高达 99MB / 2.16M 个 + `AXNodeObject` 系 ~13MB——agent-browser 开启 AX 后，流式 DOM churn 逐变更 dirty 一个 AX 对象所致。此前「后台流式 heap 143→230MB」的读数受其污染，不全是 app 状态。真实用户仅在 VoiceOver/屏幕阅读器/AX 工具在场时才有此路径；根治方向与降 DOM churn 相同（P0 各项 + 虚拟列表）。
- transcript 虚拟列表（P2）、`agentDelta` 事件合帧（`eventBatcher.ts` 参照 `coalesceAppRenderEvents`）、`swarmCardRows.lastNonEmptyLine` 尾部反扫。
- 桌面宠物窗口、空闲基线实测无问题，不动。

## 7. 实施日志（2026-07-25 完成）

P0 全部落地，两端（`apps/desktop` + `apps/web` 同步副本）均已实施并验证。除 §3 四项外，验证阶段经 profile 新发现并修复两个**既有 bug**（不修它们，P0 效果完全被掩盖）：

### 7.1 落地清单

- **P0-A（按 key diff-apply）**：新增 `composables/client/applyRecordDiff.ts`（+两端单测）；`useKimiWebClient.ts` 三个 messages funnel 与 `processEvent` 全部 Record 切片回写、`sessionUsageUpdated`、快照 seed、`clearWorkingFlags` 等 17 处整表替换全部改为按 key 写入；`useSideChat.ts` 同步。
- **P0-B（turns 结构共享）**：`messagesToTurns.ts` 增加 `options.startNo/collect`（回报每个 turn 的源消息 span）；新增 `composables/client/turnsProjector.ts`（前缀 span 复用：源消息引用逐位比对；尾部 assistant turn 仅在仍是 transcript 尾且 `sessionActive` 未翻转时复用；approvals/planReview/getFileUrl 门控，planReview 因按 key 就地可变的特性按值快照比对）。调用侧保持 `computed` 包裹（同步拉取语义，集成测试证明 `shallowRef+watch` 的异步推送会让同步读取方读到旧值）。接线时发现并规避：`?? []` 兜底空数组每次新建引用会击穿 approvals 门控——已提升为模块级常量（`NO_PENDING_APPROVALS`）。
- **P0-C（侧栏串扰）**：诊断确认驱动源即 P0-A 的回写 churn（`turns` computed 被整表替换误触发），随 P0-A 消除，无需单独改动。
- **P0-D（滚动布局治理）**：`updatePanesScrollbarWidth` 改 rAF 合帧 + 值守卫；TOC 锚点改内容坐标缓存（`tocAnchorsCache`，dirty 由 MutationObserver/RO/rebind/`kimi-table-layout` 标记），watcher 直接调用统一降级为 rAF 合并；`scrollToBottom` 即时路径不再读 `scrollHeight`（改用 RO 维护的 `lastObservedScrollHeight`，`Math.max` 防回拽）；`distanceFromBottom` 同样改用 RO 缓存高度。

### 7.2 验证阶段新发现的既有 bug（已修）

1. **函数 ref 每 patch 重放 → 每帧全量 rebind（54.5s/150s，36%）**：Vue 对每个带 ref 的 vnode patch 都无条件调用 `setRef`（`chunk:7951`，对函数 ref 无身份判断），流式期间 `ConversationPane` 每帧重渲染 → `bindChatPane` → `rebindScrollObservers`（observer disconnect/observe + `scrollHeight/clientHeight` 强读 → 每次 ~1.2ms 强制全文档布局）。此前被同一循环吞掉 MutationObserver 记录的副作用掩盖。修复：`bindChatPane`/`bindChatDock` 加节点身份守卫（`node === panesRef.value ? return`）。
2. **`scrollToBottom` 每帧 `scrollHeight` 强读（22.4s/150s）**：ref 修复后 MutationObserver 恢复正常投递，暴露出跟随路径的强制同步布局。修复见 P0-D 末两条（改 RO 缓存高度后降至 4.8s/150s，剩余为写入驱动的绘制成本）。

### 7.3 验收数据（M5 Pro / dev build / 120Hz）

| 剧本 | 指标 | 修复前 | 修复后 |
|---|---|---|---|
| A 后台串扰 | 前台 Task | 158-185 ms/s | **8.9 ms/s（-95%）** |
| A | 前台 RecalcStyle | 95-120 次/s | 0.1 次/s |
| A | 侧栏 DOM 变更 | 152 次/36s | 2 次/36s |
| B 前台流式（全新会话同题 3000 行） | 帧间隔（120Hz） | p50=8/max=24ms | **p50=8/p99=10/max=17ms，9000 帧仅 1 帧 >16ms** |
| B | Task（按 DOM 规模归一） | 12.1 ms/s/千节点 | **5.7 ms/s/千节点（-53%）** |
| B | Script / RecalcStyle / TaskOther | 51-75 / 85-127 / 299-441 ms/s | 51 / 62 / 200 ms/s |
| B | 热点函数 | rebindScrollObservers 54.5s、scrollToBottom 22.4s、updatePanesScrollbarWidth 2.9s、updateProps 2.75s、resolveTransitionProps 1.3s | **全部 ≈0**（scrollToBottom 4.8s 为写入驱动绘制） |
| C 6-agent swarm | Task 峰值 | 302 ms/s | **138 ms/s**（profile 93% idle） |

未达标项说明：剧本 B 的 Task 均值目标（<200ms/s）为 347ms/s，剩余成本集中在 markstream/shiki 逐 token 高亮（index8 4.3s + wasm 1.1s/150s）——即本计划 §6 首条待办（流式高亮降频），不属 P0 范围。

### 7.4 回归验证

- 全量测试 1585/1585（含 `event-batcher` resync 集成、`apply-event-slices` 切片隔离、`turn-logic`/`turn-injection-boundary`）；新增 `applyRecordDiff`（6 例）与 `turnsProjector`（9 例 ×两端）；`typecheck` 0 错；`lint` 0 error；`check:style` 无新增 findings。
- 手工回归（dev app 实测）：流式底部跟随（dist=0）、TOC 高亮随滚动跟踪与点击定位、折叠开合无拽动、会话切换内容/TOC 正常、历史「加载更早消息」prepend + 锚点恢复正确、swarm 卡片运行状态、侧栏工作态/未读点。
- 既有问题（非本次回归，已核实基线同样存在）：会话切换的滚动位置恢复在内容未排版完成时被钳位（`docs/plans/2026-07-22-chat-scroll-stability.md` P3 content-visibility 估算高度族），基线表现为直接回到底部。留待该文档的后续治理。

### 7.5 追加修复：会话切换闪烁（同日，滚动时序实测定因）

- **现象**：侧栏点击切换会话时，先闪现 transcript 顶部 ~26ms，再有 ~140ms 的平滑滚动爬升到底部。
- **根因（两条）**：① ChatPane 按 `fileReloadKey` 键控整体 remount（`ConversationPane.vue:2001`），内容先塌缩、新 transcript 在钳位位置（顶部）首绘一帧；② `scrollKey` watcher 的 rewind-smooth（本意是 undo/compaction 的会话内平滑回卷）在「旧→空」的跨会话转换上误触发，`smoothScrollToBottom` 逐帧读**新内容的实时 scrollHeight** 爬升 320ms，且 420ms 的 `smoothScrollUntil` 守卫挡住了即时跟随。
- **修复**：`scrollKey` watcher 跨会话转换直接跳过（定位交还 `fileReloadKey`/`sessionLoading` watcher）；新增落位幕帘（`.session-settling`，`visibility:hidden` 保布局可测、加载 spinner 不被遮蔽），切换开始上帘、`scheduleStableFollow` 稳定回调（新增 `onDone` 参数）或恢复写落位后 2 帧揭帘，1200ms 兜底。
- **验证**：切换至 3000 行文档会话的时序追踪——`ms=186` 幕帘下精确落位底部（68380/69198），`ms=244` 揭帘即所见；全量测试 1585 绿、流式跟随 dist=0 不受影响。
