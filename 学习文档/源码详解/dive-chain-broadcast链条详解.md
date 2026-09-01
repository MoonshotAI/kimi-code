# 链条详解 · 一根线走到底：broadcast 的完整旅程

> 时效基线：基于 commit `68ddf583b`（2026-08-25 提交；行号 2026-08-29 对照源码复核）。行号会随代码演进漂移，引用以当前仓库为准。
> 实测基线：`pnpm -C apps/vscode exec vitest run test/bridge-handler.test.ts test/session-runtime.test.ts` → **59 个测试全部通过**（2026-08-29）。

本篇把这根线一站一站拆开（每传递一次就是一站）：**一个函数引用怎么从 provider 出发、经 BridgeHandler 分成三路、穿过四层代码、最后变成 webview 里的一次事件分发**。全插件对"发消息给 webview"这件事只有 `broadcastInternal` 一个函数实现，20 处调用点（grep 实数）全部汇到它身上。

先给全景图（`→` 递给下一层，`★` 是真正调用它的地方）：

```
provider.broadcastInternal（唯一实现，KimiWebviewProvider.ts:112-122）
   │ provider 构造 BridgeHandler 时，把 broadcastInternal.bind(this)
   │ 作为第 1 个构造参数递进去（KimiWebviewProvider.ts:29-30 → bridge-handler.ts:33）
   │
   ├─→ BridgeHandler 构造 KimiRuntime 时放进构造参数：
   │     new KimiRuntime({ ..., broadcast, ... })（bridge-handler.ts:45）
   │     → KimiRuntime 构造函数存进字段 this.broadcast（kimi-runtime.ts:63）
   │     → wrapSession 里 new SessionRuntime({ ..., broadcast: this.broadcast, ... })
   │       ——把这个字段作为构造参数递给 SessionRuntime（kimi-runtime.ts:273）
   │           ├─★ emitStreamEvent 在这里调 this.broadcast(...)：流式事件总出口，
   │           │    对每个订阅视图各发一条（session-runtime.ts:582-586）
   │           ├─★ announceStatus 在这里调 this.broadcast(...)：状态播报，
   │           │    发给刚绑定的那一个视图（session-runtime.ts:151-169）
   │           └─→ ReverseRpcController 构造时拿到一个 emit 回调，
   │                回调体是 (event) => this.emitStreamEvent(event)
   │                （session-runtime.ts:99）——审批/提问汇入上面同一个出口 ★
   │
   ├─→ BridgeHandler 构造 FileManager 时作为第 2 个构造参数：
   │     new FileManager(this.baselineManager, broadcast)（bridge-handler.ts:63）
   │     → 存进字段（file.manager.ts:69）
   │     → ★ refreshChanges 里调这个函数广播 FileChangesUpdated（file.manager.ts:141-149）
   │
   ├─→ BridgeHandler 每个 RPC 请求现拼 context 时放进去一个字段：
   │     broadcast: this.broadcast（bridge-handler.ts:158）
   │     → ★ handlers 的 12 处 ctx.broadcast(...) 调用
   │
   └─★ provider 自己与 extension.ts 的 4 处直调（不经 BridgeHandler）：
        InsertMention / ExtensionConfigChanged / FocusInput / NewConversation（见第 3 站）
                                              │
                    每一站最终回到同一个函数体：
                    带 webviewId（定向）→ webviews.get(id)?.postMessage({event, data})
                    不带（广播）→ forEach 全部 postMessage（KimiWebviewProvider.ts:115-121）
                                              │
                    webview services/bridge.ts handleMessage 按 event 分发（:78-81）
```

**第 0 站：函数的诞生（全插件只有一个实现）**

```ts
// KimiWebviewProvider.ts:112-122
private broadcastInternal(event: string, data: unknown, targetWebviewId?: string): void {
  const msg = { event, data };
  if (targetWebviewId) {
    void this.webviews.get(targetWebviewId)?.postMessage(msg);      // 定向：只发这一个视图
  } else {
    this.webviews.forEach((webview) => { void webview.postMessage(msg); });  // 广播：全体
  }
}
```

三个事实定下整根线的性格：

- broadcastInternal 的函数体里用的 `this.webviews`，是 provider 的私有字段（`KimiWebviewProvider.ts:20`），类外访问不到——那张"webviewId → webview 对象"的对照表,它只在 provider 手里。递出去的只是函数：BridgeHandler、KimiRuntime、SessionRuntime 拿到函数后只能**调用它**发消息，**拿不到这张对照表**。想给 webview 发消息就只有调这个函数一条路，这是"全插件只有一个实现"能守住的原因；

- 调用时第三个参数**传不传** `webviewId`，决定消息发给谁：传 → 只发给这一个视图（单播）；不传 → 发给全部视图（广播）。分支就是函数体里那个 `if`——所以其他层的调用点只需要决定"传不传第三个参数"，不用关心消息怎么发出去；

- `postMessage` 把消息交给 webview 进程（webview 跑在独立进程），并返回一个 Promise 表示"发送完成还是失败"。这里**不关心发送结果**——发失败也不重试、不报错——所以用 `void` 把返回的 Promise 显式丢弃，表明"故意不等它"。

provider 构造 BridgeHandler 时，递出去的是 `this.broadcastInternal.bind(this)`（`:29-30`）。为什么不能直接递 `this.broadcastInternal`：函数体里用了 `this.webviews`，而 JS 里把一个方法单独递出去之后，别人调用它时函数体里的 `this` 就不再是 provider 了（是 undefined），第一行 `this.webviews` 当场报错。`.bind(this)` 会造出一个新函数，把 provider 实例固定进去——之后无论哪个类、哪个文件里调用，函数体里的 `this` 永远是这个 provider，`this.webviews` 永远是那张对照表。对拿到函数的代码来说，它就是个普通函数：传参数、调用、结束——BridgeHandler、KimiRuntime、SessionRuntime 全程不需要知道 provider 存在。

**第 1 站：BridgeHandler——总代理，但自己从不调用**

grep 全文件，`broadcast` 在 bridge-handler.ts 只出现四处：构造参数（`:33`）、递给 KimiRuntime（`:45`）、递给 FileManager（`:63`）、塞进 context（`:158`）——**没有一处 `this.broadcast(...)`**。它对这根线的全部职责是"收一份、发三份"。收和第一份发长这样：

```ts
// bridge-handler.ts:33、42-45（节选）
constructor(
  private readonly broadcast: BroadcastFn,   // :33 收下，存成自己的字段
  ...
) {
  this.runtime = new KimiRuntime({
    ...
    broadcast,                               // :45 简写，＝ broadcast: broadcast——原样递下去
```

第 1 站把函数发成三路，三路**互相并列**——站号跟着支线走：**2-1** 是 KimiRuntime 这一路（这一路的下一站编号 2-1-1）、**2-2** 是 FileManager、**2-3** 是 handlers。

**第 2-1 站：KimiRuntime——同样是只转手、不使用**

KimiRuntime 在自己的构造函数里把收到的参数存进字段；之后全类唯一一次读取这个字段，发生在 `wrapSession`（新建 SessionRuntime 的私有方法）里——把字段作为构造参数递给 SessionRuntime：

```ts
// kimi-runtime.ts:63（构造函数里）
this.broadcast = options.broadcast;

// kimi-runtime.ts:269-273（wrapSession 里）
private wrapSession(session: Session, legacyApproval: LegacyApprovalFlags): SessionRuntime {
  const runtime = new SessionRuntime({
    session,
    legacyApproval,
    broadcast: this.broadcast,               // :237 存的字段在这里递出去
```

KimiRuntime 自己也从不调用。

**第 2-1-1 站：SessionRuntime——KimiRuntime 这一路的下一站，真正的消费者在这里**

字段落在 `this.broadcast`（`session-runtime.ts:95`）。全类**只有两个直接调用点**，其余全部汇入第一个：

```ts
// session-runtime.ts:582-586 —— 调用点①：流式事件的总出口
private emitStreamEvent(event: UIStreamEvent | { type: string; payload: unknown }): void {
  for (const webviewId of this.webviewIds) {
    this.broadcast(Events.StreamEvent, event, webviewId);   // 对每个订阅视图各定向发一条
  }
}
```

谁往 `emitStreamEvent` 里灌事件（全部实测行号）：

| 来源 | 行号 | 事件 |
|---|---|---|
| `onSdkEvent` 投影后的引擎事件 | `session-runtime.ts:491` | `ContentPart` / `ToolCall` / `error` 等全部 UIStreamEvent |
| 宿主动作（宿主斜杠命令的"假回合"） | `:233-242`、`:248-252`、`:271-275` | `TurnBegin` / `StepBegin` / `ContentPart` / `stream_complete` |
| `announceSessionStart` | `:255-262` | `session_start` |
| `steer` | `:380-384` | `SteerInput` |
| `emitError` / `emitTerminal` | `:570`、`:520` `:531` `:545` | `error` / `stream_complete` |
| **审批与提问（逆流 RPC）** | `:99` → `reverse-rpc.ts:27、:35` | `ApprovalRequest` / `QuestionRequest` |

最后一行值得单独说：`ReverseRpcController` **没有自己的广播通道**——它构造时拿到的是一个 `emit` 回调（`reverse-rpc.ts:21`），SessionRuntime 递的是 `(event) => this.emitStreamEvent(event)`（`session-runtime.ts:99`）。引擎要审批时，`requestApproval` 里的 `this.emit({...})`（`reverse-rpc.ts:27`）走的就是同一条路：**审批弹窗不是独立机制，它是 streamEvent 流里的一种事件**。

```ts
// session-runtime.ts:151-168（节选）—— 调用点②：状态播报，直接调、定向发
async announceStatus(webviewId: string): Promise<void> {
  const status = await this.session.getStatus();
  if (this.closed || !this.webviewIds.has(webviewId)) return;
  this.broadcast(Events.StreamEvent, {
    type: "StatusUpdate",
    payload: { model: status.model, thinking_effort: status.thinkingEffort, plan_mode: status.planMode },
    _sessionId: this.id,
  }, webviewId);
}
```

两个调用点的分工：`emitStreamEvent` 是"给**每个**订阅视图各发一条"（多视图同步的机制），`announceStatus` 是"给**刚绑定的那一个**视图发一条"（openSession 每个分支收尾那步 `announceStatus`，`kimi-runtime.ts:147`，调的就是它）。

**第 2-2 站：FileManager——面板刷新**

函数从 BridgeHandler 来：`new FileManager(this.baselineManager, broadcast)`（`bridge-handler.ts:63`）——第 2 个构造参数，参数声明 `private broadcast: BroadcastFn`（`file.manager.ts:69`）直接把它存成字段。

`refreshChanges`（`file.manager.ts:141-149`）：该视图没绑会话 → 定向广播**空数组**（面板清零）；绑了 → `baselineManager.getChanges` 算完 diff → 定向发 `FileChangesUpdated`。触发它的两处：保存快照完成后的 `then`（`bridge-handler.ts:283`）和全工作区 watcher 的 `onFileChange`（`file.manager.ts:137`）——手改磁盘文件面板也会刷新，根源在这条旁支。

**第 2-3 站：handlers 的 12 处调用**

context 的 `broadcast` 字段（`:158`）直通 `this.broadcast`。全部调用点（grep 实数）：

| 调用点 | 事件 | 定向？ |
|---|---|---|
| `auth.handler.ts:19` | `LoginUrl`（OAuth 登录 URL） | 定向（推给发起登录的那个视图） |
| `mcp.handler.ts:39、55、62` | `MCPServersChanged` | **全体**（MCP 列表变了，每个视图都该刷新） |
| `chat.handler.ts:206、221` | `StreamEvent`（error，preflight/runtime 两相位，`emitCaughtError`/`emitPreflightError`） | 定向 |
| `file.handler.ts:105、111` | `FileChangesUpdated` | 定向 |
| `session.handler.ts:158、161、189、191` | `FileChangesUpdated` / `NewConversation` | 定向 |

**第 3 站（与第 1 站并列，同从第 0 站分出）：provider 与 extension.ts 的 4 处直调——不经 BridgeHandler**

事件源就在 provider 身边时，不再绕"递给 BridgeHandler 再递回来"一大圈，直接调：

```ts
// KimiWebviewProvider.ts:80-82 —— public 包装，extension.ts 走这里
broadcast(event: string, data: unknown): void {
  this.broadcastInternal(event, data);
}
```

| 调用点 | 事件 | 定向？ |
|---|---|---|
| `KimiWebviewProvider.ts:91`（`insertEditorMention`，Insert Current File 命令） | `InsertMention`（`@路径:行` 引用） | 定向（哪个视图的 workDir 算出引用就发给谁） |
| `extension.ts:57`（设置变更监听） | `ExtensionConfigChanged` | **全体**（配置变了，每个视图都要热更新） |
| `extension.ts:103`（Focus Input 命令） | `FocusInput` | **全体** |
| `extension.ts:118`（New Conversation 命令） | `NewConversation` | **全体** |

（命令类事件全体广播的原因：命令面板不知道焦点在哪个 webview 上，干脆全发、由 webview 自己判断要不要响应。）

**全部调用点总表（20 处，grep 实数）**

| 站 | 调用点 | 事件 | 定向/全体 |
|---|---|---|---|
| 第 2-1-1 站 | `session-runtime.ts:584`（emitStreamEvent） | `StreamEvent`（全部流式事件） | 定向 ×每个订阅视图 |
| 第 2-1-1 站 | `session-runtime.ts:155`（announceStatus） | `StreamEvent`（StatusUpdate） | 定向 |
| 第 2-2 站 | `file.manager.ts:144、148`（refreshChanges） | `FileChangesUpdated` | 定向 |
| 第 2-3 站 | `auth.handler.ts:19` | `LoginUrl` | 定向 |
| 第 2-3 站 | `mcp.handler.ts:39、55、62` | `MCPServersChanged` | 全体 |
| 第 2-3 站 | `chat.handler.ts:206、221` | `StreamEvent`（error） | 定向 |
| 第 2-3 站 | `file.handler.ts:105、111` | `FileChangesUpdated` | 定向 |
| 第 2-3 站 | `session.handler.ts:158、161、189` | `FileChangesUpdated` | 定向 |
| 第 2-3 站 | `session.handler.ts:191` | `NewConversation` | 定向 |
| 第 3 站 | `KimiWebviewProvider.ts:91` | `InsertMention` | 定向 |
| 第 3 站 | `extension.ts:57` | `ExtensionConfigChanged` | 全体 |
| 第 3 站 | `extension.ts:103` | `FocusInput` | 全体 |
| 第 3 站 | `extension.ts:118` | `NewConversation` | 全体 |

数一数：2 ＋ 2 ＋ 12 ＋ 4 ＝ 20，与 grep 结果一致。

**终点站：webview 里发生了什么**

所有线最后都是一次 `postMessage({event, data})`。webview 侧 `services/bridge.ts` 的 `handleMessage`（`:62-82`）先看 `msg.id`——命中 pending Map 就当 RPC 回包；否则看 `msg.event`，从 `eventHandlers` Map 里取出订阅回调逐个调（`:78-81`）——`chat.store` 的归约器表接手（`01` 第 9.2 节）。

**这条链的设计要点**：

1. **中间两层只转手、不用**（"纯导线"：拿到这根线却从不调用，只负责把它续到真正用的地方）：BridgeHandler、KimiRuntime 都是这样——未来在中间插一层，事件代码零改动；

2. **所有事件类型复用一根线**：聊天流、审批弹窗、面板刷新、MCP 通知、登录 URL、编辑器引用、配置热更、UI 命令……全是 `(event, data)` 两个参数——加新事件不需要动中间任何一层；

3. **每层只见签名**：`(event, data, webviewId?) => void`——SessionRuntime 不知道 postMessage、不知道 webview 对象、不知道 provider 存在。**不是下层找到 webview，而是"发消息给 webview"这个能力被一路递到了下层手边**；

4. **事件源在谁身边，谁直调**：provider/extension 的 4 处直调（第 3 站）没有绕中间层——绕圈递给 BridgeHandler 再递回来不增加任何价值，直调不破坏隔离（它们本来就在 provider 的同一个文件或直接持有 provider）。
