# 消息流滚动稳定性治理 实施计划

> 交给执行者的实施计划。本文档自包含，不需要其他上下文。
> 问题调研结论见 §1（含文件:行号，执行时不必重查）；所有改动先在 `apps/desktop` 开发验证，再同步 `apps/web`（共享包 `packages/*` 改一次两端生效）。

## 1. 背景：问题清单（调研结论）

滚动容器是 `ConversationPane.vue`（desktop/web 各一份同步副本，~2000 行）。当前有 **六套互相独立、没有仲裁的 scrollTop 写入者**：

1. `scheduleFollow` — MutationObserver（整面板 subtree + characterData）/ ResizeObserver 驱动，流式期间每帧 `scrollToBottom(false)`（`ConversationPane.vue:1028`）。有 `isPinned()` 守卫。
2. `scrollKey` watcher — turns 变化时 `scrollToBottom`（`ConversationPane.vue:856-871`）。**无 pin 守卫**。
3. `scheduleStableFollow` — 会话切换 / turn 结束 / 可见性恢复时，连续最多 48 帧每帧写 scrollTop（`ConversationPane.vue:783-809`）。**无 pin 守卫**。
4. `pinScrollFor` — 折叠组件开合时 260ms 内每帧钉住被点行（`ConversationPane.vue:763-781`）。
5. `restoreHistoryScroll` — 向上翻页后的锚点恢复（`ConversationPane.vue:649`）。
6. 原生 `overflow-anchor` — 非跟随时启用（`ConversationPane.vue:1655-1662`，`.is-following` / `.history-prepending` 时为 none）。

由此产生的问题（按严重度排序）：

### P1 流式中展开 thinking / tool 抖动（用户主诉）

链路：跟随时用户点开一个折叠行 → `pinScrollFor` 开始 260ms 钉行 → 流式 delta 触发 **scrollKey watcher（不看 pin）→ 瞬时吸底** → 下一帧 pin 把行拽回 → 再一个 delta 又吸底…… 两个 writer 逐帧对打 260ms。

加重因素：

- pin 窗口 260ms > CSS 折叠动画 `--duration-base: 160ms`（`packages/web-ui/src/style.css:298`）。动画早已结束，pin 还多按 100ms，期间 follow 被压制；pin 松开后的第一次 follow 是瞬时写入 → 补偿性瞬跳。
- pin 的对象是 fold head，但真正位移的是 body。`TurnFold` settle 时把 final text 之前的全部内容（thinking + 所有工具行，可达数千 px）折进一行（`chatTurnRendering.ts:143` `splitAssistantFold`），head 本身不动，pin 钉了无效目标，视口里的 final text 照样上移。
- 自动折叠行为不一致：`TurnFold`/`ActivityRun` settle 自动折叠有 pin（`TurnFold.vue:133-139`、`ActivityRun.vue:128-134`）；`ThinkingBlock` 流走自动折回**无 pin**（`ThinkingBlock.vue:34-39`）；`ActivityRun` 自动重开、`BashTool` 的 `defaultExpanded` 自动展开也无 pin（`BashTool.vue:35-40`）。

### P2 turn 结束瞬间三重叠加

turn 结束同帧发生：① TurnFold 大折叠；② 工作月亮卸载（`working = inFlight || turnActive`，整个 turn 期间都在，`useKimiWebClient.ts:2105`），底部再缩 ~38px；③ `turnActive` watcher 启动 `scheduleStableFollow(48)`（`ConversationPane.vue:937-948`，不看 pin）与 TurnFold 自己的 pin 对打。

### P3 几何地基是估算值（content-visibility）

markstream 给每个 Markdown 渲染器根节点设了 `content-visibility: auto; contain-intrinsic-size: 800px 600px`（其 `dist/index.px.css`；带 `stable-layout` class 时才为 visible）。settled 历史消息（batch-rendering）命中 auto 分支——**屏外每条消息高度一律按 600px 估算**。后果：

- `scrollHeight` / `distanceFromBottom()` 含估算误差；
- TOC 点击 `scrollToTurn` → `scrollIntoView({block:'center'})`（`ConversationPane.vue:716-725`）落点是估算位置，滚动经过的消息逐条从估值修正为真实高度，目标持续漂移，**无二次校正**；
- 滚历史时估值被真实布局替换 → scrollHeight 突变 → 原生 overflow-anchor 补偿 → 一顿一顿。

### P4 TOC 测量无节流

`updateActiveTocQuery`（`ConversationPane.vue:319-348`）在**每个 scroll 事件**里 `querySelectorAll('.turn-anchor')` 全量查找 + 逐个 `getBoundingClientRect()`，无 raf 合并，长会话每次滚动都是 O(N) 强制同步布局。

### P5 月亮快慢速机制（决策：整体移除）

现状：`MoonSpinner` 有 fast 档（`packages/web-ui/src/components/ui/MoonSpinner.vue`，`fast` prop → `ui-moon--fast`，duration 960↔480ms + 每帧 delay 120↔60ms）；`fastMoon` 判定在 `packages/web-core/src/composables/useAppearance.ts:143-158`（600ms 滑窗、160 chars/s 阈值、1000ms hold）；接线遍布 `useKimiWebClient.ts`（`recordMoonDelta` 调用 :1021、导出 :2853/:3051）、`useWorkspaceState.ts`（:264/:313/:1458/:1937）、`App.vue:981`、`ConversationPane.vue:65/:1514`、`ChatPane.vue:77/:122/:793`（web 侧为同步副本）。

机制本身的问题：fast 切换同时改 duration 和 delay → 8 帧重新对相跳变；阈值边界 flapping；统计口径只算 text+thinking 不算工具输出，速度与画面感受不一致。

**已拍板：不做快慢速度，月亮只保留单一速度（120ms/帧，960ms 一轮），整套 fastMoon 机制删除。** 单一速度下 CSS 动画不存在对相问题，无需 JS 驱动。

### P6 pill「最新消息」smooth 落地过期

`scrollToBottom(true)` 用 `scrollTo({top: scrollHeight, behavior:'smooth'})`（`ConversationPane.vue:585-588`），目标值点击时定死；动画播放期间流式还在增长，落地已不在底部，420ms guard（`SMOOTH_SCROLL_GUARD_MS`，`ConversationPane.vue:534`）过后下一次 follow 瞬时补齐 → 最后小跳一下。

## 2. 目标 / 非目标

**目标**

1. 手动展开/收起任何折叠组件（thinking / tool / activity-run / turn-fold）时被点行钉在原地、无对打抖动；跟随中展开把 tail 推出视口则出「新消息」pill，收起后按几何重判（底部回来则恢复跟随并消 pill）。
2. turn 结束瞬间（折叠 + 月亮卸载 + 稳定跟随）无瞬跳。
3. TOC 点击落点准确（content-visibility 估算修正后有二次校正）；TOC 测量 raf 节流。
4. 移除月亮快慢速机制（fastMoon / `fast` prop / 速率采样），月亮恒定单一速度。
5. pill 点击平滑落在真实底部（流式增长中亦然）。
6. 不改任何视觉设计（颜色 / 字号 / 间距 / 组件结构），纯行为修复。

**非目标（不要做）**

- 不重构 ConversationPane 的整体结构 / 不拆组件（保持 diff 可控）。
- 不改 markstream 包源码；content-visibility 不做全局关闭（长会话渲染优化保留）。
- 不做虚拟滚动、不改 messagesToTurns 数据流、不动 `kimi-code/` submodule。
- 不为折叠状态做持久化、不加设置项。

## 3. 总体设计：pin 期间单一 writer，落定后按几何重判

核心矛盾：「钉住被点的行」和「保持底部」本质互斥，旧代码两个都要（pin 钉行 + scrollKey/stableFollow 吸底），逐帧对打即抖动。两选一只能由场景决定：

- **手动 toggle 已落定块**：用户在看这一行 → **行钉住**（pin 生效，包括跟随中）。pin 开始时 `cancelActiveScrollWrites()` 停掉全部其他 writer 并置 `following = false`——pin 窗口内只剩 pin 一个 writer，从根上消除对打。展开把 tail 推出视口正是用户要的语义（行不动、body 向下展开）。
- **手动 toggle 正在流式的块**（streaming thinking / running tool / streaming activity-run）：**不 pin、不碰跟随状态**——用户点开正在输出的块是要「跟读」，跟随中由 follow 吸收展开（落在最新内容处继续流），非跟随时 head 天然不动（展开只推下方内容）。组件各自凭 `streaming` prop / `status === 'running'` 判定，toggle 时跳过 pinScroll（TurnFold 流式时 head 不渲染，无此场景）。
- **pin 自然到期**：`settleAfterPin()` 按真实几何重判——底部回到阈值内（收起把 tail 拉回来了）→ 恢复跟随并隐藏 pill；否则保持非跟随并显示 pill。用户中途滚动/提交/点 pill 会取消 pin（取消的 pin 不定案，状态归新 writer）。
- **自动开合**（settle 折叠、自动重开、defaultExpanded）：不 pin。跟随中由 follow 吸收（tail 之上的高度变化被「保持底部」天然补偿，视口稳定）；非跟随由原生 `overflow-anchor`（已为 auto）锚定。

由此，「pin 压制 follow」的情形不再存在：pin 生效时 following 必为 false，scrollKey / stableFollow 只看 following，自然不会写——不需要引入新的仲裁器或 defer 队列。

## 4. 分任务实施

### Task 1：pin 语义统一（P1 + P2 主修复）

**Files:**
- Modify: `apps/desktop/src/renderer/components/chat/ConversationPane.vue`
- Modify: `apps/desktop/src/renderer/components/chat/TurnFold.vue`
- Modify: `apps/desktop/src/renderer/components/chat/ActivityRun.vue`

**Steps:**

- [x] **Step 1：`pinScrollFor` 重写为「手动 toggle 恒 pin」，窗口 260 → 200ms**（`ConversationPane.vue` pin 段）

```ts
function pinScrollFor(el: HTMLElement, ms = 200): void {
  const panes = panesRef.value;
  if (!panes) return;
  // 历史 prepend 期间 scroll 归 restore 管，不 pin。
  if (historyLoadInProgress.value) return;
  // 清场：停掉排队中的 follow / 进行中的 smooth 滚动 / 上一次 pin
  // （被取消的 pin 永不 settle，状态归新 writer）；连带清 follow lock。
  cancelActiveScrollWrites();
  // pin 的意义就是断开跟随：body 向下展开把 tail 推出视口。
  following.value = false;
  ... // 设 pinEl / pinTargetTop / pinUntil，raf tick 每帧钉住行
}
```

pin tick 三分支：`!pinEl`（被取消）→ 直接退出不定案；`following.value`（外部恢复跟随，如 submit）→ 让位不定案；到期 → `settleAfterPin()`。

- [x] **Step 2：新增 `settleAfterPin()`——pin 自然到期后按真实几何重判**

```ts
function settleAfterPin(): void {
  if (distanceFromBottom() <= BOTTOM_THRESHOLD) {
    following.value = true;   // 收起把 tail 拉回阈值内：恢复跟随、消 pill
    showPill.value = false;
    // 注意：这里不做 scheduleFollow() 瞬时吸底——点击后立刻瞬跳读作 glitch；
    // 贴底交给下一次 follow 触发（流式 delta / resize），安静时不滚。
  } else {
    following.value = false;  // tail 仍在视口外：保持非跟随、显示 pill
    showPill.value = true;
  }
}
```

- [x] **Step 3：删除自动折叠处的 pin（TurnFold / ActivityRun）**

- `TurnFold.vue` phase watch 离开 live 的分支保留 `open.value = false`，**删除**其中的 `pinScroll` 调用（自动折叠非用户触发，交给 follow / overflow-anchor；pin 一个多半在屏外的 head 反而拽动视口）。
- `ActivityRun.vue` settle 分支同理，删 `pinScroll`。
- 两者的**手动 toggle** 保留 pinScroll，由 Step 1 的恒 pin 语义生效。
- `ThinkingBlock.vue`、`ToolDisclosure.vue`、`BashTool.vue` 不改（现状已符合目标语义：手动 toggle 有 pin、自动开合无 pin）。
- 同步更新 `ConversationPane.vue` 顶部「Scroll anchoring for expand/collapse interactions」注释块与 provide('pinScroll') 处注释。
- 注：初版按「跟随时 pin no-op」方案加的 `lib/scrollPin.ts` + 测试已随语义变更删除（pin 不再有条件门控）。

**验证：** `pnpm --filter kimi-code-app run test`（desktop）、根 `pnpm test`、`pnpm typecheck`、`pnpm lint` 全绿。

### Task 2：TOC 测量节流 + 跳转落点二次校正（P3 跳转部分 + P4）

**Files:**
- Modify: `apps/desktop/src/renderer/components/chat/ConversationPane.vue`

**Steps:**

- [x] **Step 1：`updateActiveTocQuery` 加 raf 合并**

新增 `scheduleActiveTocUpdate()`（参照同文件 `scheduleTocTableHitTest` 的 raf 模式）；`onPanesScroll`（`ConversationPane.vue:573`）改调它；scrollKey / fileReloadKey / sessionLoading / turnActive 各 watcher 里的直接调用保留（一次性事件，不需要合并）。`onUnmounted` 清理对应 raf id。

- [x] **Step 2：`scrollToTurn` 增加落定校正**

`scrollIntoView` smooth 的目标位置基于 content-visibility 估算高度，动画落地后目标可能已漂移。动画约 300-500ms，在 480ms 后重新测量目标：

```ts
// content-visibility: auto 的估算高度会让 smooth 落点漂移：
// 动画落定后按真实布局再校正一次（用户中途滚动则取消）。
let tocSettleTimer: ReturnType<typeof setTimeout> | null = null;

function scrollToTurn(turnId: string): void {
  ... // 现有逻辑不变
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  if (tocSettleTimer !== null) clearTimeout(tocSettleTimer);
  tocSettleTimer = setTimeout(() => {
    tocSettleTimer = null;
    const el2 = panesRef.value;
    const t2 = el2?.querySelector<HTMLElement>(`.turn-anchor[data-turn-id="${attrEscape(turnId)}"]`);
    if (!el2 || !t2) return;
    const delta = (t2.getBoundingClientRect().top + t2.offsetHeight / 2)
      - (el2.getBoundingClientRect().top + el2.clientHeight / 2);
    if (Math.abs(delta) > 48) el2.scrollTop += delta;
  }, 480);
}
```

`stopFollowingForUserIntent`（`ConversationPane.vue:1071`）与 `cancelActiveScrollWrites`（`ConversationPane.vue:1051`）里清掉 `tocSettleTimer`（用户接管滚动时不得再校正）；`onUnmounted` 同步清理。

**验证：** 同 Task 1。

### Task 3：smooth-scroll-to-bottom 实时目标（P6）

**Files:**
- Modify: `apps/desktop/src/renderer/components/chat/ConversationPane.vue`

**Steps:**

- [x] **Step 1：自实现 raf smooth 滚动，目标每帧重算**

替换 `scrollToBottom` 的 smooth 分支（`ConversationPane.vue:585-588`）：

```ts
let smoothRaf = 0;

function smoothScrollToBottom(ms = 320): void {
  const el = panesRef.value;
  if (!el) return;
  const start = el.scrollTop;
  const t0 = performance.now();
  lastSmoothScroll = t0;
  smoothScrollUntil = t0 + ms + SMOOTH_SCROLL_GUARD_MS;
  const tick = () => {
    smoothRaf = 0;
    const p = Math.min(1, (performance.now() - t0) / ms);
    const ease = 1 - Math.pow(1 - p, 3);
    // 目标实时取 scrollHeight：动画期间流式增长也能落在真实底部。
    el.scrollTop = start + (el.scrollHeight - start) * ease;
    lastScrollTop = el.scrollTop;
    if (p < 1) smoothRaf = raf(tick);
  };
  smoothRaf = raf(tick);
}
```

- [x] **Step 2：取消路径接入**

`cancelActiveScrollWrites`（`ConversationPane.vue:1051`）里取消 `smoothRaf`（用户 wheel/touch 打断已有链路：`onPanesWheel` → `stopFollowingForUserIntent` → `cancelActiveScrollWrites`）；`onUnmounted` 清理。`SMOOTH_SCROLL_GUARD_MS` 语义保留（guard 期间 instant follow 让位）。

**验证：** 同 Task 1。

### Task 4：移除月亮快慢速机制（P5）

**Files:**
- Modify: `packages/web-ui/src/components/ui/MoonSpinner.vue`
- Modify: `packages/web-core/src/composables/useAppearance.ts`
- Modify: `apps/desktop/src/renderer/composables/useKimiWebClient.ts`
- Modify: `apps/desktop/src/renderer/composables/client/useWorkspaceState.ts`
- Modify: `apps/desktop/src/renderer/App.vue`
- Modify: `apps/desktop/src/renderer/components/chat/ConversationPane.vue`
- Modify: `apps/desktop/src/renderer/components/chat/ChatPane.vue`

**Steps:**

- [x] **Step 1：`MoonSpinner.vue` 删 `fast`**

删除 `fast` prop、`MOON_FAST_FRAME_MS`、`moonFrameStyle` 里的 `--moon-frame-fast-delay`、`ui-moon--fast` class 及其 CSS 块。保留 `size` / `label` props 与单一速度 CSS 动画（120ms/帧、960ms 一轮）不变；`prefers-reduced-motion` 分支不变。`SideChatPanel` 等无 fast 用法的调用点不受影响。

- [x] **Step 2：`useAppearance.ts` 删整套 fastMoon 状态**

删除 `fastMoon` ref、`recordMoonDelta`、`resetFastMoon`、`holdFastMoon`、`moonSpeedSamples` / `moonFastResetTimer` / `lastMoonFastCheckAt` 及 `MOON_FAST_*` 常量；`useAppearance()` 返回值去掉这三项。保留 colorScheme / uiFontSize 不动。

- [x] **Step 3：删调用方接线（desktop，web 在 Task 5 同步）**

- `useKimiWebClient.ts:1021`：删 `appearance.recordMoonDelta(...)` 调用（连同其 `assistantDelta` 分支，若无其他逻辑）；`:2853` 删 `resetFastMoon` 导出；`:3051` 删 `fastMoon` 导出。
- `useWorkspaceState.ts`：删 `:264` 类型声明、`:313` 解构、`:1458` 与 `:1937` 两处 `resetFastMoon()` 调用。
- `App.vue:981`：删 `:fast-moon="client.fastMoon.value"`。
- `ConversationPane.vue`：删 `fastMoon` prop（`:65`）与 ChatPane 上的 `:fast-moon="fastMoon"`（`:1514`）。
- `ChatPane.vue`：删 `fastMoon` prop 声明与默认值（`:77`、`:122`），`<MoonSpinner :fast="fastMoon" />` → `<MoonSpinner />`（`:793`）。

**验证：** `pnpm typecheck` 必须全绿（能兜出所有遗漏的接线点）；`pnpm test`、`pnpm lint` 同前。

### Task 5：同步 apps/web + 全量验证

- [x] 把 Task 1-4 的改动同步到 `apps/web` 对应文件（`ConversationPane.vue` / `TurnFold.vue` / `ActivityRun.vue` / `ChatPane.vue` / `App.vue` / `useKimiWebClient.ts` / `useWorkspaceState.ts`；`packages/*` 共享包无需同步）。同步前先查 `apps/desktop/docs/native-todos.md`，保留 desktop 侧分叉块。
- [x] 根 `pnpm test`、`pnpm typecheck`、`pnpm lint`、`pnpm --filter kimi-code-web run check:style` 全绿，改动文件不新增 style findings。
- [ ] 人工视觉验证（亮色 + 暗色，见 §6 验收清单）。**不擅自启动 agent-browser / `pnpm dev:desktop:debug`**；需要人工验证时交付用户或经其同意。

### Task 6：live 块跟读 + 超高瞬时 reveal（评审后追加，已拍板）

**Files:**
- Modify: `apps/desktop/src/renderer/components/chat/ThinkingBlock.vue`
- Modify: `apps/desktop/src/renderer/components/chat/tool-calls/ToolDisclosure.vue`
- Modify: `apps/desktop/src/renderer/components/chat/ActivityRun.vue`
- Modify: `apps/desktop/src/renderer/components/chat/ConversationPane.vue`（仅注释）

**Steps:**

- [x] **Step 1：live 块 toggle 跳过 pinScroll**

`ThinkingBlock.onHeadClick`（`streaming` prop）、`ToolDisclosure.toggle`（`status === 'running'`）、`ActivityRun.toggle`（`streaming` prop）三处在 live 状态下 toggle 不调 `pinScroll`、不动跟随状态：跟随中展开由 follow 吸收（落在最新内容处跟读，之后上滚即走现有打断逻辑转场景一）；非跟随时 head 天然不动（展开只推下方内容）。`ConversationPane.vue` 的 pin 段注释与 provide 注释同步写明「SETTLED 才 pin」。

- [x] **Step 2：超高 body 瞬时 reveal（ThinkingBlock）**

live thinking 展开时若 body 内容高度超过视口（`bodyInnerEl.scrollHeight > window.innerHeight`），给 `.think-body` 加 `instant` class（`transition: none`）——160ms 的 grid-rows 动画会让几千 px 以残影滑过，跳切更干净；匹配的收起沿用同一 instant（ latch 到下次展开重算）。

- [x] **Step 3：同步 apps/web 三个组件**（仅文件头注释分叉，保留）。

**说明（评审结论记录）：** 跟读时若 body 高于视口，head 会被顶出屏幕——这是几何必然（新文本追加在 body 末尾，跟读就必须待在末尾），不特殊处理：① 跟读意图就是看最新内容；② thinking 流走即自动折回，折回时 head 正好落回 tail 上方、自动回到视口；③ 想退出跟读，上滚断跟随 + pill 兜底。

### Task 7：代码高亮流式闪烁修复（验收中发现，已拍板）

**Files:**
- Modify: `apps/desktop/src/renderer/components/HighlightedCode.vue`

**根因：** 每个流式 delta 都会让 `messagesToTurns` 重算并重建**所有** turn 的 tool 对象（`useKimiWebClient.ts:2070` 的 turns computed，无缓存）——不只 arg 正在增长的流式工具，**已完成的工具的 props 也每个 delta 换新身份**。`HighlightedCode` 的 watch 按对象身份触发，于是每个 delta 都跑 `highlight()`，而它**先 `clear()` 清空旧 token**（模板立即掉回纯文本）再异步 `codeToTokens` 重算——每个 delta 一次「着色 → 纯文本 → 着色」，已完成的 Edit 块在下方内容流式时同样持续闪烁。

**Steps:**

- [x] **Step 1：watch 源改为按值比较的字符串**（`plainText` / `diffBefore` / `diffAfter` computed）——内容没变的重渲染不再触发重高亮，已完成块在流式期间零重算、零闪烁。
- [x] **Step 2：stale-while-revalidate**——内容真实变化时不再 `clear()`，旧 token 保留到新 token 落地（模板本来就按行兜底：`plainTokens?.[i]` 不存在的新行渲染当前纯文本，追加流只有最后一行短暂延迟 ≤1 个节流周期）。
- [x] **Step 3：节流 200ms**（非防抖——模板渲染的是 token 内容，纯防抖会让整个流式期间文本冻结）；定时器始终读最新输入，流停后必有一次终态重算。
- [x] **Step 4：语言/主题切换仍立即 `clearTokens()`**（旧 token 颜色/语法错误）；`onUnmounted` 作废 ticket + 清定时器。
- [x] **Step 5：同步 apps/web**（仅文件头注释分叉，保留）。

**验证：** 根 `pnpm test`、`pnpm typecheck`、`pnpm lint` 全绿；人工验收：流式中展开 Write/Edit 的高亮块（无论自身在流式还是已完成）无闪烁，颜色随内容增长至多 200ms 追齐；语言未知/主题切换行为不变。

### Task 8：已完成 thinking 呼吸闪烁（验收中发现，已拍板）

**Files:**
- Modify: `apps/desktop/src/renderer/components/chat/ThinkingBlock.vue`

**根因：** 呼吸动画选择器 `.streaming .think-title` 是 scoped CSS——编译后 `.streaming` 祖先段**不**带组件 data-v 属性，于是任何带 `streaming` class 的祖先都能命中。`TurnFold` 根节点在 turn 流式期间带 `streaming` class 且 body 强制展开，导致折叠体内**所有已完成 thinking 行**的标题一起呼吸。数据层（`streaming` prop / `durationMs` 判定）全部正确，纯 CSS 泄漏。

**Steps:**

- [x] **Step 1：选择器收紧到自身**：`.streaming .think-title` → `.think.streaming .think-title`（含 `prefers-reduced-motion` 覆盖分支），呼吸只由本组件自己的 `streaming` prop 驱动。注释写明原因。
- [x] **Step 2：同步 apps/web**（仅文件头注释分叉，保留）。

**验证：** 根 `pnpm test`、`pnpm typecheck`、`pnpm lint` 全绿；人工验收：turn 流式期间（TurnFold 展开直播）折叠体内已完成的 thinking 行标题静止，只有正在流式的那一个 thinking 呼吸；`prefers-reduced-motion` 下全部静止。

### Task 9：评审反馈第二轮（3 条，全部属实，已修）

**Files:**
- Modify: `apps/desktop/src/renderer/components/chat/ConversationPane.vue`
- Modify: `apps/desktop/src/renderer/components/chat/tool-calls/ToolDisclosure.vue`

**Steps:**

- [x] **Step 1：TOC 落定校正响应用户接管**。原实现里 `tocSettleTimer`（480ms 校正）只被向上滚轮/触摸/抓滚动条取消；用户 TOC 跳转后向下滚、点 pill、再提交消息，校正仍会按时触发把视口拽回旧目标。新增 `cancelTocSettleCorrection()`：`onPanesWheel`（任意方向，`deltaY` 不再早退）、`onPanesTouchMove`（任意方向）、`scrollToBottom`（任何新滚动写入者）均取消；`cancelActiveScrollWrites` 改调该 helper。
- [x] **Step 2：pin 窗口禁用原生 overflow-anchor**。pin 开头置 `following=false` → `.is-following` 移除 → `overflow-anchor: auto` 恢复，pin 循环与浏览器原生锚定在窗口内互相对冲。新增响应式 `pinActive` 驱动 `.is-pinned` class（pin 开始置真，到期/让位/取消三路径置假），`.panes.is-pinned { overflow-anchor: none; }`。
- [x] **Step 3：撤销 ToolDisclosure 的 running 跳过 pin**（Task 6 修正）。评审指出等待审批的 tool 仍是 `status: 'running'` 但 body 已静止，跳过 pin 会让被点行滑动。复盘确认当初前提错误：tool body 有界（`OutputPanel` 12 行封顶 + 内部滚动），不存在无界增长，pin 不会与之对打——直接撤掉 skip，**所有 tool 行 toggle 一律 pin**。`ThinkingBlock`（无界 body）与 `ActivityRun`（其 `streaming` prop 在 parked 时为 false，本就会正确走 pin）的 skip 保持不变。Task 6 的 live 规则随之收窄为「streaming thinking / streaming activity-run」。
- [x] **Step 4：修 ticket 即时失效引入的饥饿回归**（评审第三轮）。第一条评审建议的「输入变化即 `ticket++`」与 200ms 节流叠加后，tokenize 慢于 delta 间隔时每次运行都在提交前被杀死——巨大文件流式时高亮整段冻结。取舍：**content watch 不再作废气在途运行**（`highlight()` 启动时照常递增 ticket），保证每 200ms 必有提交落地，旧文本窗口有界 ≤1 个节流周期；`ticket++` 保留在语言/主题切换路径（旧 token 错语法/错配色，且无饥饿问题）。
- [x] **Step 5：RAF smooth 滚动响应 reduced-motion**（评审第四轮）。`smoothScrollToBottom` 的 320ms JS 动画不受仓内纯 CSS 的 reduced-motion 规则约束；开头检测 `matchMedia('(prefers-reduced-motion: reduce)')`，命中则瞬时 `scrollTop = scrollHeight` 落地、不设 guard。

**验证：** 根 `pnpm test`、`pnpm typecheck`、`pnpm lint` 全绿；两端副本 diff 核对仅有意分叉。

## 5. 测试（随对应 Task 提交）

测试：

- pin / settle / TOC 校正 / smooth 滚动均为 DOM 滚动行为，靠人工验收（§6）覆盖，不新增单测（初版的 `scrollPin.test.ts` 已随语义变更删除）。
- 月亮快慢速移除不新增测试：已确认现有测试无 `fastMoon` / `recordMoonDelta` / `resetFastMoon` 生产代码引用；`apps/web/test/workspace-state.test.ts` 的 mock 残留已一并删除，typecheck 兜住其余接线。

回归：根 `pnpm test` 既有用例全绿（重点：`apps/web/test/` 与 `apps/desktop/tests/` 的 chat 相关用例不受行为变更影响）。

## 6. 验收清单（人工，亮色 + 暗色各一遍）

1. **流式跟随时展开**：跟随底部流式输出时，点开一个 thinking 行 / Bash 输出行 / activity-run——被点行**钉在原地**，body 向下展开；若 tail 被推出阈值，「新消息」pill 出现，流式继续时视口不再被拽回底部。
2. **再收起**：收起后底部回到阈值内 → pill 消失、自动恢复跟随贴底；若期间已有大量新内容（底部仍远）→ pill 保留。
3. **非跟随时展开/收起**：滚到历史中上部，展开/收起折叠行——被点行钉在原地，body 向下展开/向上收起，无拽动。
4. **跟读模式**：跟随时点开一个正在流式的 thinking——不断跟随，文本持续流入视口（跟读）；上滚即断跟随出 pill；thinking 结束自动折回时 head 回到视口。body 超长的展开无残影（瞬时 reveal）。running tool / streaming activity-run 同样不 pin。
5. **turn 结束**：观察一轮完整 turn 的收尾（TurnFold 折叠 + 月亮消失）：跟随时 final text 稳定在底部；非跟随时阅读位置不被拽动。
6. **长会话 TOC**：50+ 条消息会话，滚到中部后点 TOC 第一条/中间条目——落点居中准确，无落地后再漂移；TOC active 高亮跟随滚动流畅。
7. **pill**：流式中滚上去 → pill 出现 → 点击平滑回到底部，落地后不再补跳。
8. **月亮**：等待响应期间恒定单一速度（120ms/帧），任何输出速度下节奏一致；代码中不再有 fast 档与速率采样（typecheck 兜住全部接线）。
9. **向上翻页**：顶部 sentinel 加载历史后视口位置保持（既有行为回归）。
10. `prefers-reduced-motion`：月亮静态、折叠动画关闭下各场景无跳变。

## 7. 风险与回滚

- **风险：小展开（body ≤ 80px）在跟随时不会断开跟随。** settle 时底部仍在阈值内 → 直接恢复跟随，pill 不出现（与全局 BOTTOM_THRESHOLD 语义一致）；只有足够高的展开才推走 tail 出 pill。这是有意语义，体感需人工确认（验收 1-2）。
- **风险：pin 200ms 窗口内的流式增长会拉长 settle 时的底部距离。** 即收起后 pill 是否消失取决于「展开期间新增内容 + 展开体高度」的代数和，属「根据情况消失」的预期行为。
- **风险：TOC 校正 480ms 后内容仍在估算修正中。** 校正阈值 48px 留了余量；若个别长会话仍有残余偏差，校正最多偏一次二次滚动的距离，可接受，后续再迭代为多次校正。
- **风险：Task 4 删的是共享包 API。** `useAppearance` 的 `fastMoon` / `recordMoonDelta` / `resetFastMoon` 导出被移除；已确认消费方仅 desktop/web 两端的本计划涉及文件（`MoonSpinner` 的 `fast` 仅 `ChatPane` 一处使用，`SideChatPanel` 为无参用法），typecheck 会兜出任何遗漏；若未来有第三方依赖这些导出，按破坏性变更评估——当前仓内无此情形。
- **回滚：** 各 Task 独立 commit，任一 Task 出问题单独 revert 即可（Task 间无耦合，Task 5 除外）。

## 8. 仓库规则（执行时遵守）

- 按 AGENTS.md：**先在 `apps/desktop` 开发并验证**，再同步 `apps/web`；改两端共有文件前先查 `apps/desktop/docs/native-todos.md`。
- UI 相关改动遵循设计系统（`DesignSystemView.vue`）；样式只用 token；亮 + 暗验证。
- 不改 `kimi-code/` submodule；不擅自启动 agent-browser / `pnpm dev:desktop:debug`。
- 完成后必须走 `changeset` skill：`.changeset/` 只写 `kimi-code-app`，**patch**；Conventional Commits，无 AI 署名；stage 用显式路径，不用 `git add -A`。
