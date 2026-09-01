# 05 · SessionRuntime 逐方法详解：655 行里的单会话状态机

> 时效基线：基于 commit `68ddf583b`（2026-08-25 提交；行号 2026-08-29 对照源码复核）。行号会随代码演进漂移，**本篇每处 `文件:行号` 引用都附带源码原文**——日后行号对不上时，按代码文本搜索即可重新定位。
> 实测基线：`pnpm -C apps/vscode exec vitest run test/session-runtime.test.ts` → **33 个测试全部通过**（2026-08-29）。

## 全局认知

- **定位**：`apps/vscode/src/runtime/session-runtime.ts`，656 行（2026-09-01 拉取后；#3098 在 announceStatus 补传了 context_usage，:163 起行号整体 +1）。一个会话（SDK `Session`）的**运行时伴侣**——类上的 JSDoc（`session-runtime.ts:65-69`）说清了它存在的理由："拥有这个会话唯一的事件订阅和逆流 RPC handler；**任意多个 webview 订阅，不会互相顶掉审批 handler、不会重复收流式事件**"。

- **构成**：6 个接口＋1 个常量＋20 个字段＋39 个成员（构造器＋6 个 getter＋32 个方法）＋2 个文件级函数（1 个导出）。

- **设计主线一：三根一次性接线。** 构造函数里 `setApprovalHandler`、`setQuestionHandler`、`onEvent` 各接一次，之后**永不重接**——这是"多视图共享会话不重复挂回调"的根（视图＝一个 webview 聊天页面实例，sidebar 或 panel，[02-BridgeHandler方法详解.md](02-BridgeHandler方法详解.md) 第三节开头有定义与代码）。

- **设计主线二：两种"回合"。** **模型回合**（`prompt`→引擎真跑一轮）与**宿主假回合**（`beginHostAction` 家族——宿主自己执行的斜杠命令如 /init、/compact，UI 上要装得像一轮对话；术语表有条目）。两套共享 `isBusy` 互斥。

- **设计主线三：终态去重与错误抑制。** 引擎事件流可能重复发终态（`terminalKeys`）或在报错后补一条已知的错误事件（`suppressedError`）——两个字段分别是这两道闸。

- **与 [01-webview与Bridge通信.md](01-webview与Bridge通信.md) 的分工**：01 那篇第六节讲了本类的分层视图（三根接线、onSdkEvent、event-adapter、reverse-rpc、错误下场）；本篇下到方法级。event-adapter.ts 与 reverse-rpc.ts 两个搭档类各有 446/97 行，不拆开成篇，只在用到处给足坐标。

## 总地图

**20 个字段**（分四组记）：

| 组 | 字段 | 行号 | 作用 |
|---|---|---|---|
| 注入 | `session` | `session-runtime.ts:71` | SDK 会话（公开 readonly） |
| | `broadcast` | `session-runtime.ts:73` | 发事件给 webview（见 broadcast 链条篇） |
| | `captureBaseline` | `session-runtime.ts:74` | 保存基线快照的回调（抢在工具改文件前把原内容读出来存下来；终点在 [02-BridgeHandler方法详解.md](02-BridgeHandler方法详解.md) 第九节，存储在 [04-BaselineManager方法详解.md](04-BaselineManager方法详解.md)） |
| | `log` | `session-runtime.ts:75` | 错误日志 |
| | `legacyApproval` | `session-runtime.ts:90` | yolo/afk 标志（唯一可变注入） |
| 订阅与接线 | `webviewIds` | `session-runtime.ts:76` | 订阅了本会话的视图集 |
| | `reverseRpc` | `session-runtime.ts:77` | 逆流控制器（审批/提问） |
| | `unsubscribe` | `session-runtime.ts:78` | onEvent 的退订函数，close 时用 |
| 回合状态 | `adapterState` | `session-runtime.ts:79` | event-adapter 的折叠状态 |
| | `activePrompt` | `session-runtime.ts:80` | 活着的模型回合（含 resolve） |
| | `hostActionActive` | `session-runtime.ts:81` | 假回合进行中 |
| | `hostActionSequence` | `session-runtime.ts:82` | 假回合编号发号器 |
| | `activeHostActionId` | `session-runtime.ts:83` | 当前假回合的编号 |
| | `cancelledHostActions` | `session-runtime.ts:84` | 被取消过的假回合编号 |
| | `pendingHostCompaction` | `session-runtime.ts:85` | 在途的 /compact |
| | `activeWorkSettledWaiters` | `session-runtime.ts:86` | 等"活干完"的 resolve 集 |
| | `exclusiveActionActive` | `session-runtime.ts:87` | 独占操作（fork）进行中 |
| 防重 | `terminalKeys` | `session-runtime.ts:88` | 已发过的终态键 |
| | `suppressedError` | `session-runtime.ts:89` | 下一条同码同文错误要吞掉 |
| 生命 | `closed` | `session-runtime.ts:91` | close 后置 true |

**39 个成员**（"主要调用方"列＝类外真实调用点的源码原文，grep 实数；类内互调在正文展开）：

| 分组 | 成员 | 行号 | 可见性 | 主要调用方（源码原文） |
|---|---|---|---|---|
| 构造 | `constructor` | `session-runtime.ts:93-108` | 公开 | kimi-runtime.ts:270（全类唯一 new 的地方，[03-KimiRuntime方法详解.md](03-KimiRuntime方法详解.md) 第七节）：`const runtime = new SessionRuntime({` |
| 只读 | `id` | `session-runtime.ts:110-112` | getter | chat.handler.ts:123：`emitCaughtError(ctx, error, "preflight", runtime.id);`；bridge-handler.ts:330-333：`id: runtime.id,`（拼 BaselineSession）等 |
| | `summary` | `session-runtime.ts:114-116` | getter | bridge-handler.ts:298：`const active = this.runtime.getSession(sessionId)?.summary;`；slash-command.ts:177：`const dirs = runtime.session.summary?.additionalDirs ?? [];` |
| | `subscribers` | `session-runtime.ts:118-120` | getter | kimi-runtime.ts:213：`if (runtime.subscribers.length === 0) {`；session.handler.ts:184：`const affectedViews = ctx.runtime.getSession(params.sessionId)?.subscribers ?? [];` |
| | `isBusy` | `session-runtime.ts:122-124` | getter | chat.handler.ts:174：`if (runtime === undefined \|\| !runtime.isBusy) return { ok: false };`（Steer 的门） |
| | `legacyApprovalFlags` | `session-runtime.ts:126-128` | getter | kimi-runtime.ts:103：`await applySessionSettings(current.session, options, current.legacyApprovalFlags);`（kimi-runtime.ts:111 同款） |
| 订阅 | `subscribe` | `session-runtime.ts:141-144` | 公开 | kimi-runtime.ts:145：`runtime.subscribe(options.webviewId);`（kimi-runtime.ts:168 `existing.subscribe(webviewId);`、kimi-runtime.ts:196 `runtime.subscribe(webviewId);`——收尾三步第一步） |
| | `announceStatus` | `session-runtime.ts:151-169` | 公开 | kimi-runtime.ts:104：`await current.announceStatus(options.webviewId);`（kimi-runtime.ts:147/:169/:198 同款——收尾第三步） |
| | `unsubscribeView` | `session-runtime.ts:171-173` | 公开 | kimi-runtime.ts:212（唯一）：`runtime.unsubscribeView(webviewId);` |
| 审批标志 | `toggleLegacyApproval` | `session-runtime.ts:130-134` | 公开 | slash-command.ts:121：`const flags = await runtime.toggleLegacyApproval(kind);`（/yolo、/auto） |
| | `setLegacyYoloMode` | `session-runtime.ts:136-139` | 公开 | kimi-runtime.ts:256：`[...this.sessions.values()].map((session) => session.setLegacyYoloMode(enabled)),`（全局设置变化） |
| | `applyLegacyApproval` | `session-runtime.ts:421-438` | 私有 | 上面两个的公共出口（正文第四节） |
| 模型回合 | `prompt` | `session-runtime.ts:175-177` | 公开 | chat.handler.ts:139（唯一）：`const result = await runtime.prompt(prependSystemContext(params.content, systemContext));` |
| | `runTurnAction` | `session-runtime.ts:179-224` | 公开 | prompt `session-runtime.ts:176`（`return this.runTurnAction(input, () => this.session.prompt(toSdkPromptInput(input)));`）、slash-command.ts:54：`const result = await runtime.runTurnAction(command.raw, () =>` |
| 宿主假回合 | `beginHostAction` | `session-runtime.ts:226-245` | 公开 | slash-command.ts:59（唯一）：`const actionId = runtime.beginHostAction(command.raw, command.name === "import");` |
| | `emitHostText` | `session-runtime.ts:247-254` | 公开 | slash-command.ts:60：`const emit = (text: string): void => runtime.emitHostText(text, actionId);` |
| | `announceSessionStart` | `session-runtime.ts:256-263` | 公开 | chat.handler.ts:121（唯一）：`runtime.announceSessionStart(model);` |
| | `completeHostAction` | `session-runtime.ts:265-278` | 公开 | slash-command.ts:105：`runtime.completeHostAction("finished", actionId);`；类内 cancel session-runtime.ts:341 |
| | `failHostAction` | `session-runtime.ts:280-285` | 公开 | slash-command.ts:109（唯一）：`runtime.failHostAction(actionId);` |
| | `wasHostActionCancelled` | `session-runtime.ts:287-289` | 公开 | slash-command.ts:104/:108：`if (runtime.wasHostActionCancelled(actionId)) return false;` |
| | `releaseHostAction` | `session-runtime.ts:291-293` | 公开 | slash-command.ts:112（finally 里）：`runtime.releaseHostAction(actionId);` |
| | `compactHostAction` | `session-runtime.ts:295-328` | 公开 | slash-command.ts:77（/compact，唯一）：`await runtime.compactHostAction(actionId, command.args \|\| undefined);` |
| 取消/独占 | `cancel` | `session-runtime.ts:330-353` | 公开 | chat.handler.ts:152（Stop 按钮）：`await runtime.cancel();`；类内 runExclusiveAfterCancelling session-runtime.ts:369、close session-runtime.ts:407 |
| | `runExclusiveAfterCancelling` | `session-runtime.ts:355-376` | 公开 | session.handler.ts:251（ForkKimiSession，唯一）：`: active.runExclusiveAfterCancelling(forkSettledSession);` |
| 逆流/转向 | `steer` | `session-runtime.ts:378-386` | 公开 | chat.handler.ts:175（唯一）：`await runtime.steer(params.content);` |
| | `respondApproval` | `session-runtime.ts:388-390` | 公开 | chat.handler.ts:157（唯一）：`return { ok: ctx.getSession()?.respondApproval(params.requestId, params.response) ?? false };` |
| | `respondQuestion` | `session-runtime.ts:392-394` | 公开 | chat.handler.ts:162（唯一）：`return { ok: ctx.getSession()?.respondQuestion(id, params.answers) ?? false };` |
| 生命 | `close` | `session-runtime.ts:396-419` | 公开 | kimi-runtime.ts:215/:246（`await runtime.close();`）、kimi-runtime.ts:263（`session.close()`，dispose 并发关）；slash-command.ts:276：`if (activeSource === undefined) await sourceSession.close();`；session.handler.ts:213/:228：`await fork.close();` |
| 事件管线 | `onSdkEvent` | `session-runtime.ts:440-496` | 私有 | 构造器 onEvent 回调 :107（唯一）：`this.unsubscribe = this.session.onEvent((event) => this.onSdkEvent(event));` |
| | `captureFileBaseline` | `session-runtime.ts:498-514` | 私有 | onSdkEvent :455：`this.captureFileBaseline(event);`（tool.call.started 时） |
| | `emitTerminal` | `session-runtime.ts:516-558` | 私有 | onSdkEvent :477：`this.emitTerminal(adapted.terminal);` |
| | `consumeSuppressedError` | `session-runtime.ts:560-565` | 私有 | onSdkEvent :465：`if (event.type === "error" && this.consumeSuppressedError(event.code, event.message)) {` |
| | `emitError` | `session-runtime.ts:567-580` | 私有 | runTurnAction :191/:218（正文第五节代码块内） |
| | `emitStreamEvent` | `session-runtime.ts:582-586` | 私有 | 全类事件总出口（11 处调用，见 broadcast 链条篇） |
| 结算 | `settlePrompt` | `session-runtime.ts:588-595` | 私有 | emitTerminal :526/:537/:557、onSdkEvent :493、runTurnAction :219、close :411（正文各节代码块内） |
| | `hasActiveWork` | `session-runtime.ts:597-599` | 私有 getter | isBusy session-runtime.ts:123：`return this.hasActiveWork \|\| this.exclusiveActionActive;`；session-runtime.ts:603/:609 |
| | `waitForActiveWorkToSettle` | `session-runtime.ts:601-606` | 私有 | runExclusiveAfterCancelling :367：`const settled = this.waitForActiveWorkToSettle();` |
| | `notifyActiveWorkSettled` | `session-runtime.ts:608-612` | 私有 | settlePrompt :593、completeHostAction :276、failHostAction :283、close :413（正文代码块内） |
| | `ensureOpen` | `session-runtime.ts:614-616` | 私有 | 8 处调用点对应 7 个方法（第二节全表） |

**2 个文件级函数**：`toSdkPromptInput`（`session-runtime.ts:619-652`，导出，类内 `session-runtime.ts:177/:380` 两处用）、`isRecord`（`session-runtime.ts:654-656`，`session-runtime.ts:500` 一处用：`if (!isRecord(event.args)) return;`）。

## 一、constructor：三根一次性接线

```ts
// session-runtime.ts:93-108
constructor(options: SessionRuntimeOptions) {
  this.session = options.session;
  this.broadcast = options.broadcast;
  this.captureBaseline = options.captureBaseline;
  this.log = options.log;
  this.legacyApproval = options.legacyApproval;
  this.reverseRpc = new ReverseRpcController((event) => this.emitStreamEvent(event));   // :99

  // Forward every approval request to the user. The engine permission mode ...
  this.session.setApprovalHandler((request) => this.reverseRpc.requestApproval(request)); // :105
  this.session.setQuestionHandler((request) => this.reverseRpc.requestQuestion(request)); // :106
  this.unsubscribe = this.session.onEvent((event) => this.onSdkEvent(event));            // :107
}
```

**实参谁递的**：kimi-runtime wrapSession（kimi-runtime.ts:269-279——new SessionRuntime 并立即放进 sessions 表，全类唯一 new 的地方，[03-KimiRuntime方法详解.md](03-KimiRuntime方法详解.md) 第七节有完整代码）——Session 是 harness 造的，三个回调是从 BridgeHandler 一路转手来的。

三根接线各是一次、且各自指向唯一的下家：

- **审批线**：引擎要批准工具调用时调我们递的回调 → `reverseRpc.requestApproval` → 把请求变成 `ApprovalRequest` 事件发给 webview 弹卡（用户点选后经 `respondApproval` 回来放行）。`session-runtime.ts:101-104` 原注释点明分工：引擎的权限模式（由 legacy 标志映射）已经自动放行 yolo/auto 允许的东西，**能走到这个 handler 的都是例外**（敏感文件、plan 评审、ask 规则）——必须真人决定。

- **提问线**：同构，`requestQuestion`＋`respondQuestion`。

- **事件线**：`onEvent` 把本类挂成引擎事件的唯一消费者，返回的退订函数存进 `unsubscribe` 字段——close 时用它摘线。

**注意三根线都挂在 Session（引擎对象）上，而不是挂在某个视图上**：第二个视图 subscribe 进来时（KimiRuntime 的收尾三步＝subscribe → sessionByView.set → announceStatus，[03-KimiRuntime方法详解.md](03-KimiRuntime方法详解.md) 第三节）什么也不用重接，`emitStreamEvent` 对 `webviewIds` 里的每个视图各发一份——"多视图不重复订阅"就是这么来的。构造函数尾部没有额外守卫：接线是构造的原子部分，不存在"造了一半的 SessionRuntime"。

## 二、六个只读视图与 ensureOpen

```ts
// session-runtime.ts:110-128
get id(): string { return this.session.id; }
get summary(): SessionSummary | undefined { return this.session.summary; }
get subscribers(): readonly string[] { return [...this.webviewIds]; }
get isBusy(): boolean { return this.hasActiveWork || this.exclusiveActionActive; }
get legacyApprovalFlags(): LegacyApprovalFlags { return this.legacyApproval; }
```

前两个是对 SDK Session 的**只读透出**（不改写、不缓存）。`subscribers` 每次现场拷贝成数组——调用方拿到的是快照，改它不影响内部 Set（kimi-runtime 的 detachView 靠 `subscribers.length === 0` 做引用计数判定，[03-KimiRuntime方法详解.md](03-KimiRuntime方法详解.md) 第五节）。`isBusy` 是互斥总闸：**模型回合（activePrompt）或假回合（hostActionActive）在跑，或独占操作（fork）在进行**，三者任一为真就是忙。

`ensureOpen`（`session-runtime.ts:614-616`）就一行：

```ts
// session-runtime.ts:614-616
private ensureOpen(): void {
  if (this.closed) throw new Error("Session is closed.");
}
```

它是 7 个方法的第一道门（8 处调用点）：subscribe `session-runtime.ts:142`、announceStatus `session-runtime.ts:152`、runTurnAction `session-runtime.ts:183`、beginHostAction `session-runtime.ts:227`、runExclusiveAfterCancelling `session-runtime.ts:361`＋`session-runtime.ts:371`、steer `session-runtime.ts:379`、applyLegacyApproval `session-runtime.ts:422`（每处都是同一行 `this.ensureOpen();`）——关掉的会话不接受新工作。

## 三、订阅三件：subscribe / unsubscribeView / announceStatus

```ts
// session-runtime.ts:141-144、170-172
subscribe(webviewId: string): void {
  this.ensureOpen();
  this.webviewIds.add(webviewId);          // Set：重复 subscribe 幂等
}
unsubscribeView(webviewId: string): void {
  this.webviewIds.delete(webviewId);       // 注意：不 ensureOpen——close 内部也走得到
}
```

```ts
// session-runtime.ts:151-169（节选，JSDoc :146-150）
async announceStatus(webviewId: string): Promise<void> {
  this.ensureOpen();
  const status = await this.session.getStatus();
  if (this.closed || !this.webviewIds.has(webviewId)) return;   // :154 await 后重验——竞态守卫
  this.broadcast(
    Events.StreamEvent,
    { type: "StatusUpdate", payload: { model: status.model, thinking_effort: status.thinkingEffort, plan_mode: status.planMode,
        context_usage: status.contextUsage },                   // :163 #3098 补传——v2 引擎的实时上下文占用
    _sessionId: this.id },
    webviewId,                                                   // 定向：只发这一个视图
  );
}
```

JSDoc 原话："视图打开或重进会话时把当前状态推过去，让显示（模型、思考档、plan 模式）匹配**引擎真相**而不是全局默认值"。`session-runtime.ts:154` 的重验值得注意：`getStatus` 是一次 await，期间视图可能已被 unsubscribe、会话可能已被 close——回来后再查一遍才广播。三个方法的调用方全是 KimiRuntime 的收尾三步/拆绑（[03-KimiRuntime方法详解.md](03-KimiRuntime方法详解.md) 第三、五节，调用行原文见总地图），**视图生命周期完全不经过本类**——它只维护"谁订阅了我"这张 Set。

## 四、审批标志三件：toggleLegacyApproval / setLegacyYoloMode / applyLegacyApproval

```ts
// session-runtime.ts:421-438（applyLegacyApproval，两个公开方法的公共出口）
private async applyLegacyApproval(flags: LegacyApprovalFlags): Promise<void> {
  this.ensureOpen();
  const permission = corePermissionForLegacyApproval(flags);
  const status = await this.session.getStatus();
  const permissionChanged = status.permission !== permission;
  if (permissionChanged) await this.session.setPermission(permission);
  try {
    await this.session.updateMetadata(legacyApprovalMetadata(flags));   // 持久化，第①级恢复链的数据源
  } catch (error) {
    if (permissionChanged) {                                            // 元数据写失败 → 回滚权限
      await this.session.setPermission(status.permission).catch((rollbackError: unknown) => {
        this.log("Failed to restore session permission after a metadata error", rollbackError);
      });
    }
    throw error;
  }
  this.legacyApproval = flags;                                          // 全部成功才改内存值
}
```

`toggleLegacyApproval`（`session-runtime.ts:130-134`，/yolo、/auto 命令走它）翻转一个键后调这里；`setLegacyYoloMode`（`session-runtime.ts:136-139`，全局设置变化时 KimiRuntime 对每个活会话调它）值没变直接返回（`session-runtime.ts:137`：`if (this.legacyApproval.yolo === enabled) return;`）。这个私有出口做了三件讲究的事：**先改权限后写元数据**（权限生效优先）；**元数据失败回滚权限**（不让两边不一致）；**内存字段最后才改**（`legacyApproval` 永远等于"两边都落定"的值）。[03-KimiRuntime方法详解.md](03-KimiRuntime方法详解.md) 第三节的三级恢复链（三级＝会话存的 metadata → 旧 kimi-cli 迁移来的 state.json → 默认值），第①级读的就是这里写下的 metadata。

## 五、模型回合：prompt / runTurnAction / settlePrompt 一族

```ts
// session-runtime.ts:175-177
async prompt(input: string | LegacyContentPart[]): Promise<PromptResult> {
  return this.runTurnAction(input, () => this.session.prompt(toSdkPromptInput(input)));
}
```

**谁调用**：chat.handler.ts:139（唯一）——用户发消息的最后一站（`const result = await runtime.prompt(prependSystemContext(params.content, systemContext));`）。`runTurnAction` 是通用骨架"跑一个会触发引擎事件的 action"：prompt 是它最直接的用法，slash-command.ts:54 用它跑 `activateSkill`（skill: 命令也要走完整的回合仪式）：

```ts
// slash-command.ts:52-56
if (command.name.startsWith("skill:")) {
  const skillName = command.name.slice("skill:".length);
  const result = await runtime.runTurnAction(command.raw, () =>
    runtime.session.activateSkill(skillName, command.args || undefined));
```

```ts
// session-runtime.ts:179-224（节选）
async runTurnAction(input, action): Promise<PromptResult> {
  this.ensureOpen();
  if (this.isBusy) {
    // A re-entrant turn request must never disturb the active turn — it fails only itself. ...
    this.emitError(
      new Error(ALREADY_GENERATING_MESSAGE),
      "runtime",
      { terminal: this.hasActiveWork ? false : undefined },   // :193 独占操作占着 → 终态错误
    );
    return { status: "failed" };
  }

  let resolveCompletion!: (result: PromptResult) => void;
  const completion = new Promise<PromptResult>((resolve) => { resolveCompletion = resolve; });
  const active: ActivePrompt = { input, started: false, settled: false, resolve: resolveCompletion };
  this.activePrompt = active;                                 // :208 记入 activePrompt

  try {
    await action();                                           // :211 引擎开始跑（不等它完）
  } catch (error) {
    if (!active.settled) {                                    // :216 只结算自己造的回合
      this.emitError(error, active.started ? "runtime" : "preflight");
      this.settlePrompt({ status: "failed" });
    }
  }
  return completion;                                          // :222 真正的结束由事件流决定
}
```

这里藏着本类最核心的一个设计：**`await action()` 返回≠回合结束**。`session.prompt` 的 Promise 只表示"引擎接受了请求"，真正的终态来自事件流（`turn.ended` → onSdkEvent → emitTerminal → `settlePrompt`）。所以方法返回的是 `completion`——一个由 `active.resolve` 控制的 Promise，**谁看到 turn.ended 谁来 resolve 它**。`session-runtime.ts:185-190` 原注释解释 `session-runtime.ts:194` 的两态：重入请求失败时，若正在跑的是回合类工作，它的终态事件会解锁视图，发**非终态**警告就够；若正在跑的是独占操作（fork），没有终态事件会来，必须发**终态**错误让输入框解锁，否则挂到握手超时。

`settlePrompt`（`session-runtime.ts:588-595`）：`settled` 标志防重复结算，resolve 后调 `notifyActiveWorkSettled`。`hasActiveWork`（`session-runtime.ts:597-599`）＝ activePrompt 或 hostActionActive（`return this.activePrompt !== undefined || this.hostActionActive;`）；`waitForActiveWorkToSettle`（`session-runtime.ts:601-606`）把 resolve 收进 `activeWorkSettledWaiters`；`notifyActiveWorkSettled`（`session-runtime.ts:608-612`）在活干完时全部放行并清空——**fork 的"等落定"机制**（第七节）靠这三个方法。

## 六、宿主假回合：beginHostAction 八件套

宿主斜杠命令（/init、/compact、/clear、/yolo、/export……slash-command.ts:16-28 的 HOST_COMMANDS）不进引擎，但 UI 上要显示成"一轮对话"——有开头、有文字、有结束。这套 API 就是给 slash-command.ts 造假回合用的：

```ts
// session-runtime.ts:226-245（beginHostAction）
beginHostAction(input: string | LegacyContentPart[], forkable = false): number {
  this.ensureOpen();
  if (this.isBusy) {
    throw new Error(ALREADY_GENERATING_MESSAGE);            // 与 prompt 不同：直接抛，不 emitError
  }
  const actionId = ++this.hostActionSequence;                // 发编号
  this.hostActionActive = true;
  this.activeHostActionId = actionId;
  this.emitStreamEvent({ type: "TurnBegin", payload: { user_input: input, forkable }, _sessionId: this.id });
  this.emitStreamEvent({ type: "StepBegin", payload: { n: 1 }, _sessionId: this.id });
  return actionId;                                           // 编号还给调用方，后续全家福都要带
}
```

开假回合＝手工发两个 UI 事件（TurnBegin＋StepBegin），UI 立刻显示"这轮开始了"。`forkable` 只有 /import 传 true（它内部会真的 createSession）。**后续七个方法全靠 actionId 核对身份**——`emitHostText`/`completeHostAction`/`failHostAction` 第一件事都是 `actionId !== this.activeHostActionId 则忽略`：假的回合可能被用户取消、被新的取代，旧编号的迟到调用全部作废。

| 方法 | 行号 | 干什么 |
|---|---|---|
| `emitHostText` | `session-runtime.ts:247-254` | 发一条 ContentPart（命令的输出文字）；空文本直接吞 |
| `announceSessionStart` | `session-runtime.ts:256-263` | 发 `session_start`（chat.handler 在 prompt 前调，UI 建会话上下文） |
| `completeHostAction` | `session-runtime.ts:265-278` | 发 `stream_complete`（status: finished/cancelled）＋通知落定 |
| `failHostAction` | `session-runtime.ts:280-285` | 静默失败：不发终态事件（调用方自己抛错走 emitCaughtError），只清状态＋通知落定 |
| `wasHostActionCancelled` | `session-runtime.ts:287-289` | 查这个编号是否被 cancel 记进过 `cancelledHostActions` |
| `releaseHostAction` | `session-runtime.ts:291-293` | 从取消记录里删掉这个编号（finally 里调，防 Set 无限涨） |
| `compactHostAction` | `session-runtime.ts:295-328` | /compact 专用，见下 |

slash-command.ts:59-113 是这套 API 的标准用法（begin → try{干活＋emit} → 成功侧 `wasCancelled? complete` / 失败侧 `wasCancelled? fail` → finally `release`），关键几行：

```ts
// slash-command.ts:59-60、104-113（节选）
const actionId = runtime.beginHostAction(command.raw, command.name === "import");
const emit = (text: string): void => runtime.emitHostText(text, actionId);
...
    if (runtime.wasHostActionCancelled(actionId)) return false;
    runtime.completeHostAction("finished", actionId);
    return true;
  } catch (error) {
    if (runtime.wasHostActionCancelled(actionId)) return false;
    runtime.failHostAction(actionId);
    throw error;
  } finally {
    runtime.releaseHostAction(actionId);
  }
```

`compactHostAction` 特殊在**它真的进引擎**（`session.compact`，`session-runtime.ts:316`）却没有 turn 事件流——引擎用 `compaction.completed`/`compaction.cancelled` 事件报结果。所以它自己造 Promise，把 resolve/reject 存进 `pendingHostCompaction`，由 onSdkEvent 的专用分支（`session-runtime.ts:443-449`）结算；cancel 路径把 `"cancelled"` 翻译成异常抛出（`session-runtime.ts:325-327`）。已有一个在途 compaction 时拒绝第二个（`session-runtime.ts:299-301`：`if (this.pendingHostCompaction !== undefined) { throw new Error("A context compaction is already running."); }`）。

## 七、cancel 与 runExclusiveAfterCancelling

```ts
// session-runtime.ts:330-353
async cancel(): Promise<void> {
  // Always reach the engine, even when the host believes nothing is active. ...
  if (this.closed) return;
  this.reverseRpc.cancelAll("Turn cancelled");                // 逆流请求全部作废（弹着的审批卡过期）
  const cancellingHostAction = this.hostActionActive;
  const hostActionId = this.activeHostActionId;
  if (cancellingHostAction && hostActionId !== undefined) {
    this.cancelledHostActions.add(hostActionId);              // 记录：complete/fail 时查
    this.completeHostAction("cancelled", hostActionId);       // 假回合立即以 cancelled 收场
  }
  // A manual compaction is not a model turn, so Session.cancel() alone does not stop it. ...
  const results = await Promise.allSettled([
    this.session.cancel(),                                    // 引擎侧取消
    ...(cancellingHostAction ? [this.session.cancelCompaction()] : []),   // /compact 的取消面
  ]);
  const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failure !== undefined) throw failure.reason;
}
```

**谁调用**：chat.handler.ts:152（Stop 按钮，`await runtime.cancel();`）。`session-runtime.ts:331-334` 原注释值得整段读：**即使宿主这边认为没活，也要打到引擎**——宿主记录可能在异常路径后与引擎真相不一致，`session.cancel()` 在引擎空闲时是无害空操作，但它是找回"宿主跟丢的回合"的唯一手段。两个取消面并行（allSettled：一个失败不挡另一个，最后统一抛）。

```ts
// session-runtime.ts:360-376（节选）
async runExclusiveAfterCancelling<T>(action: () => Promise<T>): Promise<T> {
  this.ensureOpen();
  if (this.exclusiveActionActive) {
    throw new Error("Another session operation is already in progress.");
  }
  this.exclusiveActionActive = true;
  try {
    const settled = this.waitForActiveWorkToSettle();   // :367 先挂等（在 cancel 之前！）
    await this.cancel();                                // :368
    await settled;                                      // :369 等终态事件落地
    this.ensureOpen();                                  // :370 cancel 期间可能被 close
    return await action();                              // :371 在完全落定的会话上干活
  } finally {
    this.exclusiveActionActive = false;
  }
}
```

JSDoc（`session-runtime.ts:355-359`）说清动机："停掉在途工作、等它的终态事件、再挡住新回合直到操作完成。**fork 用它读到完全落定的会话**，避免与异步的 cancel 事件赛跑"。**谁调用**：session.handler.ts:251（ForkKimiSession）——fork 要复制"到第 N 轮为止"的会话，若 cancel 的事件还在天上飞，复制品可能多一轮少一轮（`session-runtime.ts:249-252`：`const active = ctx.runtime.getSession(params.sessionId); return active === undefined ? forkSettledSession() : active.runExclusiveAfterCancelling(forkSettledSession);`）。`session-runtime.ts:368` 在 cancel **之前**挂 waiter 是顺序关键：先挂才收得到 settlePrompt 触发的放行。

## 八、steer 与逆流应答

```ts
// session-runtime.ts:378-386
async steer(input: string | LegacyContentPart[]): Promise<void> {
  this.ensureOpen();
  await this.session.steer(toSdkPromptInput(input));
  this.emitStreamEvent({ type: "SteerInput", payload: { user_input: input }, _sessionId: this.id });
}
```

**谁调用**：chat.handler.ts:173-176——回合进行中用户又打了字，UI 判 `runtime.isBusy` 后调它，把内容**插进正在跑的回合**（不新开回合）。成功后发 `SteerInput` 事件让 UI 把这条插话显示出来：

```ts
// chat.handler.ts:173-176
const runtime = ctx.getSession();
if (runtime === undefined || !runtime.isBusy) return { ok: false };
await runtime.steer(params.content);
```

`respondApproval`（`session-runtime.ts:388-390`）/`respondQuestion`（`session-runtime.ts:392-394`）各一行——转给 `reverseRpc.respondApproval/respondQuestion`，返回布尔（false＝Map 里没这个 id：回合已被 cancelAll 收尾。逆流＝引擎→宿主→用户的反方向调用，靠"宿主把 Promise 的 resolve 存进 Map、等用户点按钮的 RPC 回来再放行"实现，[01-webview与Bridge通信.md](01-webview与Bridge通信.md) 第 6.4 节讲过整个机制）。**唯一调用方** chat.handler.ts:157/:162（调用行原文见总地图），对应 webview 侧的两个 RPC 方法调用。

## 九、close：按固定顺序收尾

```ts
// session-runtime.ts:396-419
async close(): Promise<void> {
  if (this.closed) return;                                     // 幂等
  this.closed = true;
  this.pendingHostCompaction?.reject(new Error("Session closed during context compaction."));  // :398
  this.pendingHostCompaction = undefined;
  this.reverseRpc.cancelAll("Session closed");                 // :400 弹着的审批卡全部作废
  this.unsubscribe();                                          // :401 摘事件线
  this.session.setApprovalHandler(undefined);                  // :402 摘审批线
  this.session.setQuestionHandler(undefined);                  // :403 摘提问线
  if (this.activePrompt !== undefined || this.hostActionActive) {
    try { await this.session.cancel(); }                       // :406 还有活 → 打引擎停
    catch (error) { this.log("Failed to cancel the active turn while closing a session", error); }
    if (this.activePrompt !== undefined) this.settlePrompt({ status: "cancelled" });  // :410 别让调用方挂着
    this.hostActionActive = false;
    this.activeHostActionId = undefined;
    this.notifyActiveWorkSettled();                            // :413 放行 fork 等待者
  }
  this.cancelledHostActions.clear();
  await this.session.close();                                  // :416 最后关 SDK 会话
  this.webviewIds.clear();
}
```

顺序本身就是文档：先置 closed（挡新工作）→ 结算在途 Promise（compaction 拒绝、prompt 以 cancelled 结算——**调用方不能永远挂着**）→ 按构造时接线的**反序**摘线（unsubscribe、两个 handler 置 undefined）→ 有活则 cancel → 关 SDK 会话。**谁调用**（6 处，调用行原文见总地图）：kimi-runtime.ts:215（末位视图 detach）、kimi-runtime.ts:246（closeSession）、kimi-runtime.ts:263（dispose）；slash-command.ts:276 与 session.handler.ts:213/:228（fork 流程关临时会话）。

## 十、事件管线：onSdkEvent 一族（引擎事件进来的地方）

```ts
// session-runtime.ts:440-496（逐段）
private onSdkEvent(event: Event): void {
  if (this.closed) return;                                     // :440 摘线后的迟到事件直接丢

  if (event.type === "compaction.completed" || event.type === "compaction.cancelled") {   // :442
    const pending = this.pendingHostCompaction;                // → compactHostAction 的结算分支
    if (pending !== undefined) { this.pendingHostCompaction = undefined;
      pending.resolve(event.type === "compaction.completed" ? "completed" : "cancelled"); }
  }
  if (event.type === "turn.started" && event.agentId === "main" && this.activePrompt !== undefined) {
    this.activePrompt.started = true;                          // :451 preflight→runtime 的分界
  }
  if (event.type === "tool.call.started") {
    this.captureFileBaseline(event);                           // :455 保存快照的触发点
  }
  if (event.type === "turn.step.retrying") {
    this.log(`Provider retry ${event.nextAttempt}/${event.maxAttempts} in ${event.delayMs}ms`, ...);  // :459
  }
  if (event.type === "error" && this.consumeSuppressedError(event.code, event.message)) {
    return;                                                    // :465 已报过的错不再报
  }

  const pendingInput = this.activePrompt?.input;
  const adapted = adaptSdkEvent(this.adapterState, event, {    // :470 纯函数投影（event-adapter.ts）
    pendingInput,
    errorPhase: this.activePrompt?.started === false ? "preflight" : "runtime",
  });
  this.adapterState = adapted.state;

  if (adapted.terminal !== undefined) {
    this.emitTerminal(adapted.terminal);                       // :477 终态 → 收尾
    return;
  }
  if (adapted.event !== undefined) {
    // Errors the core reports while the active turn keeps running ... must not look turn-ending to the Webview ...
    const wireEvent = adapted.event.type === "error" && this.activePrompt?.started === true
      ? { ...adapted.event, terminal: false as const }         // :488 回合中的错误不锁 UI
      : adapted.event;
    this.emitStreamEvent(wireEvent);
    if (adapted.event.type === "error" && this.activePrompt !== undefined && !this.activePrompt.started) {
      this.settlePrompt({ status: "failed" });                 // :492 preflight 失败直接结算
    }
  }
}
```

管线六站：**compaction 结算 → started 标记 → 保存快照 → 重试日志 → 错误抑制 → 投影分发**（投影器 event-adapter.ts 本身的拆解在 [01-webview与Bridge通信.md](01-webview与Bridge通信.md) 第 6.3 节）。`session-runtime.ts:482-490` 原注释点明 `session-runtime.ts:489` 的用意：引擎在回合仍进行时报的错误（后面不会跟 turn.ended）若被 UI 当成回合结束，输入框提前解锁、下一发 prompt 撞上还在跑的这发——所以强制 `terminal: false`。测试 kimi-runtime.test.ts:780 `it("marks a mid-turn core error as non-terminal until the turn ends", async () => {` 锁的正是这一行。

`emitTerminal`（`session-runtime.ts:516-558`）按 adapter 给的 reason 分三路：completed → `stream_complete`＋settlePrompt(finished)；cancelled → `reverseRpc.cancelAll`＋`stream_complete`＋settlePrompt(cancelled)；错误路 → 算 code、`getUserMessage` 转人话、发 `error` 事件、**把这条错误记进 `suppressedError`**（`session-runtime.ts:554-556`：`if (terminal.error !== undefined) { this.suppressedError = { code: terminal.error.code, message: terminal.error.message }; }`）、settlePrompt(failed)。`session-runtime.ts:517-518` 的 `terminalKeys` 是第一道防重：同一个终态键（adapter 保证键唯一）只发一次（`if (this.terminalKeys.has(terminal.key)) return; this.terminalKeys.add(terminal.key);`）。`consumeSuppressedError`（`session-runtime.ts:560-565`）是第二道：emitTerminal 刚报过的错，引擎又发一条**一模一样**的 error 事件时吞掉——记下的 code＋message 双匹配才吞，且只吞一条。

`emitStreamEvent`（`session-runtime.ts:582-586`）是全类事件总出口：

```ts
// session-runtime.ts:582-586
private emitStreamEvent(event: UIStreamEvent | { type: string; payload: unknown }): void {
  for (const webviewId of this.webviewIds) {
    this.broadcast(Events.StreamEvent, event, webviewId);
  }
}
```

每视图定向一条（[dive-chain-broadcast链条详解.md](dive-chain-broadcast链条详解.md) 第 2-1-1 站）。`emitError`（`session-runtime.ts:567-580`）是本类**自己产生**的错误（不是引擎事件）的出口：isKimiError 取 code、`getUserMessage` 转人话、发 error 事件＋写日志。

`captureFileBaseline`（`session-runtime.ts:498-514`）：`event.name` 是 Write 或 Edit、args 是对象、`args["path"]` 是非空字符串——三关全过才调注入的 `captureBaseline` 回调，实参是会话三字段＋文件路径＋`this.subscribers`：

```ts
// session-runtime.ts:498-514
private captureFileBaseline(event: Extract<Event, { type: "tool.call.started" }>): void {
  if (event.name !== "Write" && event.name !== "Edit") return;
  if (!isRecord(event.args)) return;
  const filePath = event.args["path"];
  if (typeof filePath !== "string" || filePath.length === 0) return;

  const summary = this.session.summary;
  this.captureBaseline(
    { id: this.session.id, workDir: this.session.workDir, metadata: summary?.metadata },
    filePath,
    this.subscribers,
  );
}
```

**这是全插件保存基线快照的唯一触发点**，链条后半段（BridgeHandler.captureFileBaseline 的三道目录校验 → BaselineManager 落盘 → 面板刷新）在 [02-BridgeHandler方法详解.md](02-BridgeHandler方法详解.md) 第九节。

## 十一、文件级函数

```ts
// session-runtime.ts:619-652（节选）
export function toSdkPromptInput(input: string | LegacyContentPart[]): string | PromptInput {
  if (typeof input === "string") return input;
  const parts: SdkContentPart[] = [];
  for (const part of input) {
    switch (part.type) {
      case "text": parts.push({ type: "text", text: part.text }); break;
      case "image_url": parts.push({ type: "image_url", imageUrl: { url: ..., ...(id ? {id} : {}) } }); break;
      case "video_url": /* 同构 */ break;
      case "audio_url":
      case "think":
        // PromptInput intentionally accepts user text/images/videos only.
        break;                                                  // 用户输入只收文字/图/视频
    }
  }
  return parts as PromptInput;
}
```

把 webview 协议的旧 ContentPart 形状翻译成 SDK 的 PromptInput——**兼容层**，只在新旧形状有差异时才有存在感（旧 `image_url` 蛇形键 → 新 `imageUrl` 驼峰键）。`isRecord`（`session-runtime.ts:654-656`）是 unknown 收窄的惯用一行函数（`return typeof value === "object" && value !== null && !Array.isArray(value);`）。

## 十二、设计复盘

1. **三根线挂在会话上、不挂在视图上。** setApprovalHandler/setQuestionHandler/onEvent 一生一次。反例：每视图接一次线，第二个视图进来时引擎的 handler 被顶掉（第一个视图收不到审批了）或叠了两份（同一事件双收）——这正是 JSDoc 点名要防的事。

2. **回合的结束由事件流宣布，不由发起调用宣布。** runTurnAction 返回的 completion 由 settlePrompt resolve。反例：`await session.prompt()` 完就当回合结束，流式内容还在天上飞、UI 已解锁，下一发 prompt 与在途事件交错，聊天记录错序。

3. **重入失败只失败自己。** isBusy 拒绝新请求时按当前工作的类型选终态/非终态错误。反例：重入请求把 activePrompt 顶掉，原回合的结算 resolve 了另一个 Promise，第一个调用方拿到属于别人的结果。

4. **假回合与模型回合共享 isBusy，互斥免费获得。** 反例：/compact 跑到一半用户发消息也进引擎，两股输出在同一个 UI 时间线上交叉显示。

5. **cancel 永远打到引擎，即使宿主认为没活。** 反例：宿主记录漂移后跟丢一个回合，它永远跑下去，Stop 按钮变成摆设。

6. **终态双闸（terminalKeys＋suppressedError）。** 反例：adapter 与引擎事件流在异常序列下各报一次终态，UI 收两个 stream_complete，第二个把"已解锁"又解锁一遍、settlePrompt 二次结算。

7. **close 按"先结算 Promise、再摘线、最后关资源"的顺序。** 反例：先关 SDK 会话再结算 pendingHostCompaction，那个 Promise 永远悬挂，/compact 的调用方（slash-command 的 actionId 流程）卡死到超时。

## 下一步

- 谁造出本类：[03-KimiRuntime方法详解.md](03-KimiRuntime方法详解.md) 第七节（wrapSession，全类唯一 new SessionRuntime 的地方）。

- 三根出线的另一端：逆流审批的 webview 侧闭环在 [01-webview与Bridge通信.md](01-webview与Bridge通信.md) 第 6.4、七节；保存基线快照的下游在 [04-BaselineManager方法详解.md](04-BaselineManager方法详解.md)。

- 引擎侧接着发生什么（turn/step、权限链、compaction 触发）：[学习文档/04-agent引擎入门.md](../04-agent引擎入门.md) 第二节起。
