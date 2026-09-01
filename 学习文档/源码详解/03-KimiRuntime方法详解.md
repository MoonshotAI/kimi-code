# 03 · KimiRuntime 逐方法详解：291 行里的会话路由器

> 时效基线：基于 commit `68ddf583b`（2026-08-25 提交；行号 2026-08-29 对照源码复核）。行号会随代码演进漂移，**本篇每处 `文件:行号` 引用都附带源码原文**——日后行号对不上时，按代码文本搜索即可重新定位。
> 实测基线：`pnpm -C apps/vscode exec vitest run test/kimi-runtime.test.ts` → **29 个测试全部通过**（2026-08-29）。

## 全局认知

- **定位**：`apps/vscode/src/runtime/kimi-runtime.ts`，291 行。类上的 JSDoc 一句话："Extension-host owner for one in-process Node SDK harness"——扩展宿主进程里**那一个**引擎实例（KimiHarness）的持有人，同时是"webview ↔ 会话"的路由器。

  **会话**＝你和 AI 的一次完整对话：从第一句提问开始，包含之后所有来回消息和 AI 执行过的操作；每个会话有唯一 id 和自己的工作目录，引擎把它存进 homeDir，关掉后还能从磁盘恢复接着聊——webview 会话列表里的每一项就是一个会话。同一个会话有三种形态：
  
  - **躺在磁盘上的记录**——没打开时只有它，`harness.listSessions` 能列出全部，`resumeSession(id)` 恢复。这个形态没有任何 **Session 对象**，只有存储数据。

  - **打开后引擎侧的 SDK Session 对象**——会话**被打开后**，引擎交给你的活实例（`harness.createSession/resumeSession` 的返回值，身上是 `prompt/steer/cancel/getStatus`）。关掉的会话没有这个对象。

  - 以及**插件侧包装它的 SessionRuntime**——不是“另一个会话”，是给 SDK Session
     套的壳：一个 SDK Session 恰好对应一个 SessionRuntime（wrapSession 造，sessions Map
     里存的是壳），出生链见主线三。

- **构成**：2 个接口＋7 个字段＋构造器＋12 个方法（9 公开 3 私有）＋4 个文件级函数（1 个导出）。

- **设计主线一：双表多对多。** 两张 Map 各管一件事：`sessions`（会话 id → SessionRuntime）——引擎里有哪些活会话；`sessionByView`（webviewId → 会话 id）——每个视图当前看哪个会话（视图＝一个 webview 聊天页面实例，[02-BridgeHandler方法详解.md](02-BridgeHandler方法详解.md) 第三节开头有定义与代码）。由此定下两条规则：**一个会话可以被多个视图同看**（侧边栏＋面板同时开同一会话）、**一个视图同一时刻只绑一个会话**。

  多视图 × 多会话, "一个 webview 对一个会话吗？"——**不必然**：多个 webview 可以订阅同一个会话（比如侧边栏和面板同时开着同一会话），靠两张表维护多对多关系（`kimi-runtime.ts:57-58`）：

  ```ts
  sessions:        Map<sessionId, SessionRuntime>   // 引擎里的每个活会话
  sessionByView:   Map<webviewId, sessionId>        // 每个视图当前"看"哪个会话
  ```

- **设计主线二：审批标志三级恢复链。** 每次会话落到手上，都按"会话自己存的 → 旧 kimi-cli 迁移来的 → 默认值"三级恢复 yolo/afk 标志（yolo＝开着它工具执行不逐个请求批准；afk＝离开键盘模式，权限更高；两者映射成引擎权限的规则在第九节 `corePermissionForLegacyApproval`：afk→auto、yolo→yolo、否则 manual），再让全局 yolo 设置盖过会话存的 yolo——`openSession` 和 `attachResumedSession` 各自内联了一遍这条链。

- **设计主线三：实例层级——每层各几个。** 从插件启动起是一条单例链：下面三个类，每个在整个插件代码里都只被 new 一处（已用 grep 全代码搜索确认，不是推断）—— `provider = new KimiWebviewProvider()`（`extension.ts:24`）→  `this.bridgeHandler = new BridgeHandler()` （`KimiWebviewProvider.ts:29`）→  `this.runtime = new KimiRuntime({})` （`bridge-handler.ts:42`）。

  ```
  KimiWebviewProvider ×1（管 webview 们）
    └ BridgeHandler ×1（组装三大资源＋分发 RPC 请求）
        └ KimiRuntime ×1（本类：视图↔会话的对应关系、会话的创建/关闭）
            ├ KimiHarness ×1（引擎：createSession / resumeSession / close）
            └ sessions：SessionRuntime ×N（每个活会话一个，各包一个 SDK Session；多视图共享同一个）
  ```

  所以 **KimiRuntime 全插件只有一个实例**，它持有两样东西：
  
  **KimiHarness 一个**（**引擎的门面**。引擎＝真正干活的那套程序：收到你的消息后调用模型、执行工具（读/改文件、跑命令）、把过程用事件流吐回来、把会话存进homeDir——它的实现在本仓库的 packages/agent-core-v2（默认走这条）和 packages/agent-core（`useAgentCoreV1` 回滚时走这条）。KimiHarness 是 SDK 暴露出来的门面，门面后面才是引擎实体——**DI 容器，代码里就是 `this.app` 这个对象**（下面关停链的最后一步 `this.app.dispose()` 销掉的就是它；"DI 容器是什么"见关停链之后那段）。
  
  harness 在 **KimiRuntime 的构造函数里创建**（`kimi-runtime.ts:66-76`：`this.harness = options.harness ?? createHarness({ homeDir, identity, uiMode: "vscode" })`）——插件启动时随 KimiRuntime 一起出生，全程只这一个。

  引擎的关停也归 harness，整条链画出来：

  ```
  插件停用（VS Code 停用插件 / 窗口关闭）
   → provider.dispose()（KimiWebviewProvider.ts:40/:44）
     → BridgeHandler.dispose()（bridge-handler.ts:292-295：先关 FileManager，再往下）
       → KimiRuntime.dispose()（kimi-runtime.ts:224-231：置 closed → 并发 close 全部 SessionRuntime → 清空双表）
         → harness.close()（kimi-runtime.ts:230，实现在 sdk-rpc-client-v2.ts:503 起）
             ├ 逐个 dispose SDK 侧每个会话的接线（sessionWirings）
             ├ dispose 应用级订阅（appSubscriptions）
             ├ 关底层 klient（await this.klient.close()）
             ├ 把会话索引镜像、追加日志排空落盘
             ├ shutdown MCP OAuth 服务
             └ this.app.dispose()——销毁 DI 容器，引擎退役
  ```

  **DI 容器（`this.app`）是什么**：引擎的总管家对象——引擎启动时，内部几十个服务（配置、会话管理、工具、权限、日志……）不是各写各的 new，而是全交给它集中创建、互相接线；销毁时也由它一声令下全部一起收。所以它是"引擎实体"的本体，KimiHarness 只是拿在手里的门面。

  **SessionRuntime 若干个**——`sessions` 表里每个**活会话**一个。活会话＝当前在内存里开着的会话（用户正在聊的、或从历史恢复出来还没关的）；相对的是躺在磁盘上的历史会话——那不算，要 `resumeSession` 把它恢复成活的才进这张表（openSession 里 `this.sessions.get(requestedId)` 查的就是"表里有没有它"，`kimi-runtime.ts:103`）。造它的是 `wrapSession`（`new SessionRuntime({ session, ... })`，`kimi-runtime.ts:234`；出生链第 2 步细讲）。它从表里消失只有两条路（第五节拆解）：**被动**——看着它的视图陆续退订，最后一个也退了（`runtime.subscribers.length === 0`，`kimi-runtime.ts:194-197`，从表里删并 close）；**主动**——`closeSession`/`deleteSession`/`dispose` 不看视图数直接关。

  会话的出生链——两次构造有先后，都发生在 openSession 的新建分支（第三节分支③）里：

  - **第 1 步，SDK Session 出生，构造它的是引擎**：KimiRuntime 的 openSession 调 `await this.harness.createSession({ workDir, model, ... })`（`kimi-runtime.ts:112`；恢复历史会话则是 `this.harness.resumeSession({ id: requestedId, includeSubagents: true })`，`kimi-runtime.ts:119`）——对象在引擎内部被创建，这次调用一返回，KimiRuntime 手里就拿到了它；

  - **第 2 步，SessionRuntime 出生，构造它的是 KimiRuntime**：紧接着走本类的私有方法 `wrapSession`（`kimi-runtime.ts:233-243`），关键一行是 `new SessionRuntime({ session, ... })`（`kimi-runtime.ts:234`）——把刚拿到的 SDK Session 当构造参数递进去，造完存进 `sessions` 表；

  - **SessionRuntime 从头到尾不构造 SDK Session，只持有它**：构造函数里 `this.session = options.session;`（session-runtime.ts:94）存成字段，之后跑对话都是调 `this.session.prompt(...)`（session-runtime.ts:175）。

  分工一句话：**SDK Session（引擎侧）真正跑对话，身上是 `prompt`/`steer`/`cancel`/`getStatus`；SessionRuntime（插件侧的包装）让多个 webview 能共享它、把它的引擎事件转发给 webview、接审批和提问**（详见 [05-SessionRuntime方法详解.md](05-SessionRuntime方法详解.md)）。


  每层职责一句话：provider 管 webview、BridgeHandler 管组装与分发、KimiRuntime 管视图↔会话的对应关系和会话的创建/关闭、harness 管引擎、SessionRuntime 管单个会话的事件流、假回合、取消（[05-SessionRuntime方法详解.md](05-SessionRuntime方法详解.md)）。

## 总地图 · 构成清单

**2 个接口**：

| 接口 | 行号 | 内容 |
|---|---|---|
| `KimiRuntimeOptions` | `kimi-runtime.ts:22-39` | 构造参数：version、broadcast、captureBaseline、log、homeDir?、harness?、useAgentCoreV1? |
| `OpenSessionOptions` | `kimi-runtime.ts:41-48` | openSession 参数：webviewId、workDir、sessionId?、model、effort、yoloMode |

**7 个字段**：

| 字段 | 行号 | 类型 | 作用 |
|---|---|---|---|
| `harness` | `kimi-runtime.ts:52` | `KimiHarness`（公开 readonly） | 引擎门面；createSession/resumeSession/close/delete 都走它 |
| `broadcast` | `kimi-runtime.ts:54` | `RuntimeBroadcast` | 从 BridgeHandler 来，只转手递给 SessionRuntime（`kimi-runtime.ts:237`），本类零调用（见 broadcast 链条篇） |
| `captureBaseline` | `kimi-runtime.ts:55` | 回调 | 同上，只在 wrapSession 转手（`kimi-runtime.ts:238`），本类零调用 |
| `log` | `kimi-runtime.ts:56` | 回调 | 错误日志出口，本类 3 处调用（`kimi-runtime.ts:134/:176/:252`） |
| `sessions` | `kimi-runtime.ts:57` | `Map<string, SessionRuntime>` | 双表之一：会话 id → 会话运行时 |
| `sessionByView` | `kimi-runtime.ts:58` | `Map<string, string>` | 双表之二：webviewId → 会话 id |
| `closed` | `kimi-runtime.ts:59` | `boolean` | dispose 后置 true，后续 openSession 被 ensureOpen 拒绝 |

**13 个成员（构造器＋12 方法）**（"主要调用方"列附源码原文）：

| 成员 | 行号 | 可见性 | 一句话作用 | 主要调用方（源码原文） |
|---|---|---|---|---|
| `constructor` | `kimi-runtime.ts:61-77` | 公开 | 选引擎（v1/v2）并造 harness | bridge-handler.ts:42：`this.runtime = new KimiRuntime({`（唯一） |
| `getSessionForView` | `kimi-runtime.ts:79-82` | 公开 | 视图绑的会话 | bridge-handler.ts:166（唯一）：`getSession: () => this.runtime.getSessionForView(webviewId),` |
| `getSession` | `kimi-runtime.ts:84-86` | 公开 | 按 id 查活会话 | 4 处，见第二节全表 |
| `openSession` | `kimi-runtime.ts:88-144` | 公开 | 开/复用/恢复会话并绑定视图 | bridge-handler.ts:169（唯一）：`const runtime = await this.runtime.openSession({` → chat.handler.ts:94：`runtime = await ctx.getOrCreateSession(` |
| `attachResumedSession` | `kimi-runtime.ts:146-185` | 公开 | 把一个已在手的 Session 绑到视图 | bridge-handler.ts:193（唯一）：`const runtime = await this.runtime.attachResumedSession(` → session.handler.ts:130：`const runtime = await ctx.resumeSession(params.kimiSessionId);` |
| `detachView` | `kimi-runtime.ts:187-198` | 公开 | 拆视图绑定；末位视图触发关会话 | 宿主 3 处＋类内 3 处，见第五节全表 |
| `closeSession` | `kimi-runtime.ts:200-211` | 公开 | 主动关某会话（不管视图数） | deleteSession `kimi-runtime.ts:214`（类内）：`await this.closeSession(id);`；测试 test/kimi-runtime.test.ts:578：`await runtime.closeSession(opened.id);` |
| `deleteSession` | `kimi-runtime.ts:213-216` | 公开 | 关会话＋删磁盘数据 | session.handler.ts:185（唯一，DeleteKimiSession RPC）：`await ctx.runtime.deleteSession(params.sessionId);` |
| `setYoloModeForActiveSessions` | `kimi-runtime.ts:218-222` | 公开 | 全局 yolo 设置变化时刷新所有活会话 | KimiWebviewProvider.ts:149：`await this.bridgeHandler.runtime.setYoloModeForActiveSessions(enabled);` ← extension.ts:63：`?.setYoloModeForActiveSessions(VSCodeSettings.yoloMode)` |
| `dispose` | `kimi-runtime.ts:224-231` | 公开 | 全关：所有会话＋引擎 | bridge-handler.ts:294（唯一）：`await this.runtime.dispose();` |
| `wrapSession` | `kimi-runtime.ts:233-243` | 私有 | new SessionRuntime 并入 sessions 表 | openSession `kimi-runtime.ts:131`、attachResumedSession `kimi-runtime.ts:173`：`runtime = this.wrapSession(session, approval);` |
| `readMigratedLegacyApproval` | `kimi-runtime.ts:245-255` | 私有 | 三级恢复链的第二级（读旧 kimi-cli state.json） | openSession `kimi-runtime.ts:124`、attachResumedSession `kimi-runtime.ts:164`：`(await this.readMigratedLegacyApproval(session))` |
| `ensureOpen` | `kimi-runtime.ts:257-259` | 私有 | closed 守卫 | openSession `kimi-runtime.ts:89`（唯一）：`this.ensureOpen();` |

**4 个文件级函数**：

| 函数 | 行号 | 被谁调用（源码原文） |
|---|---|---|
| `applySessionSettings` | `kimi-runtime.ts:262-277` | openSession 三分支各一次：`kimi-runtime.ts:98` `await applySessionSettings(current.session, options, current.legacyApprovalFlags);`、`kimi-runtime.ts:106/:129` `await applySessionSettings(session, options, approval);` |
| `normalizeEffort` | `kimi-runtime.ts:279-281`（**导出**） | openSession `kimi-runtime.ts:115`：`thinking: normalizeEffort(options.effort),`；chat.handler.ts:114：`const effort = normalizeEffort(params.effort ?? (params.thinking === true ? "on" : "off"));` |
| `flagsDiffer` | `kimi-runtime.ts:283-285` | openSession `kimi-runtime.ts:126`、attachResumedSession `kimi-runtime.ts:167`：`if (storedApproval === undefined \|\| flagsDiffer(storedApproval, approval)) {` |
| `assertSessionWorkDir` | `kimi-runtime.ts:287-291` | openSession `kimi-runtime.ts:105`：`assertSessionWorkDir(runtime.session, options.workDir);`、`kimi-runtime.ts:121`：`assertSessionWorkDir(session, options.workDir);` |

## 一、constructor：选引擎，一次定终身

```ts
// kimi-runtime.ts:61-77
constructor(options: KimiRuntimeOptions) {
  this.broadcast = options.broadcast;
  this.captureBaseline = options.captureBaseline;
  this.log = options.log;
  const createHarness = options.useAgentCoreV1 ? createKimiHarness : createKimiHarnessV2;
  this.harness =
    options.harness ??
    createHarness({
      homeDir: options.homeDir,
      identity: {
        productName: "kimi-code-vscode",
        version: options.version,
        platform: "kimi_code_vscode",
      },
      uiMode: "vscode",
    });
}
```

**实参谁递的**——BridgeHandler 的构造函数 bridge-handler.ts:40-50（`const useAgentCoreV1 = VSCodeSettings.useAgentCoreV1;)` 之后就是 `this.runtime = new KimiRuntime({ version, useAgentCoreV1, broadcast, captureBaseline, log })`，完整接线见 [02-BridgeHandler方法详解.md](02-BridgeHandler方法详解.md) 第一节）。`useAgentCoreV1` 来自 VS Code 设置 `kimi.useAgentCoreV1`（默认 false 走 v2 引擎）；选项上的 JSDoc（`kimi-runtime.ts:33-37`）写明回滚语义：

```ts
// kimi-runtime.ts:33-37（选项 JSDoc 原文）
/**
 * Engine rollback: create the legacy v1 harness instead of the default v2
 * one. The decision is made once in `config/vscode-settings.ts`; a change
 * applies on the next window reload, when the runtime is rebuilt.
 */
```

**引擎选择不支持热切换**——改动要等下次重载窗口、runtime 重建时才生效，这是有意的：中途换引擎等于所有活会话背后的引擎对象被连根换掉，没有平稳迁移的路径。构造函数里还有两处值得注意，各干各的事：

  - **`options.harness` 是留给测试的口子**（kimi-runtime.ts:66-67 `this.harness = options.harness ?? createHarness({...})`）。先看真引擎时"关一个没打开的会话"这条调用怎么一层层下去，再看测试的假货替换了哪一层。

    **第 1 层·本类的方法**（kimi-runtime.ts:200-205）——查内存表，查不到就交给 harness：

    ```ts
    async closeSession(id: string): Promise<void> {
      const runtime = this.sessions.get(id);   // 拿 id 查内存里的 sessions Map
      if (runtime === undefined) {             // 查不到 → 会话当前没打开（没有视图在看、没有活实例，只在磁盘上）
        await this.harness.closeSession(id);   // 交给下一层：harness 上的同名方法
        return;
      }
    ```

    **第 2 层·`KimiHarness` 包装类**——`harness` 字段的类型，也是**两个工厂共同返回的同一个类**（kimi-harness.ts:72）。不管 v1 还是 v2，工厂干的事一样：先造一个底层客户端，再用 KimiHarness 包一层：

    ```ts
    // v1 工厂（sdk-rpc-client.ts:145-147）：造 v1 客户端，包进 KimiHarness
    const rpc = new SDKRpcClient(options);
    return new KimiHarness(rpc, { ... });

    // v2 工厂（sdk-rpc-client-v2.ts:2663-2665）：同一个包装类，只是吃进 v2 客户端
    const rpc = new SDKRpcClientV2(options);
    return new KimiHarness(rpc, { ... });
    ```

    它的 `closeSession`（kimi-harness.ts:277）只做一件事——关它自己创建/恢复出来、还在 `activeSessions` 表里的 Session 对象；id 不在表里就什么也不发生（对从没打开过的会话是无害的空操作）：

    ```ts
      async closeSession(id: string): Promise<void> {
        await this.activeSessions.get(id)?.close();
      }
    ```

    **第 3 层·`Session.close()`——第 2 层调的就是它**（packages/node-sdk/src/session.ts:738-747）：幂等守卫 → 把"关我"发给底层客户端 → 无论成败都清掉这个会话挂的回调：

    ```ts
      async close(): Promise<void> {
        if (this.closed) return;                          // 关过了就直接回（幂等）
        this.closed = true;
        try {
          await this.rpc.closeSession({ sessionId: this.id });  // ← 落到第 4 层：客户端的 closeSession
        } finally {
          this.rpc.clearSessionHandlers(this.id);         // 无论成败，摘掉这个会话挂的审批/提问/事件回调
          await this.onClose?.();                         // 通知挂了 onClose 的地方
        }
      }
    ```

    **第 4 层·底层客户端的 `closeSession`**——第 3 层 `this.rpc` 的来路（"包"发生在两处）：

    ```ts
    // 接线①：工厂把客户端递给 KimiHarness 构造器，存成字段（kimi-harness.ts:92-95）
      constructor(
        private readonly rpc: SDKRpcClientBase,   // 这个参数写法＝自动存成同名字段 this.rpc
        options: KimiHarnessRuntimeOptions,
      ) {

    // 接线②：KimiHarness 每次 createSession，把同一个 rpc 递给造出来的 Session（kimi-harness.ts:134-139）
      const session = new Session({
        id: summary.id,
        workDir: summary.workDir,
        summary,
        rpc: this.rpc,                            // ← 就是这行：Session 拿到的是 harness 手里同一个客户端
        onClose: () => { ... },
      });

    // 收下（session.ts:97）：Session 构造器里 this.rpc = options.rpc;
    ```

    所以 Session.close 里的 `this.rpc` 和 KimiHarness 里的 `this.rpc` 是**同一个客户端对象**——v1 是 `SDKRpcClient`、v2 是 `SDKRpcClientV2`（都继承 `SDKRpcClientBase`，rpc.ts:180）。它的 `closeSession` 分两条：

    ```ts
    // 基类版本（rpc.ts:247-250）——只服务于 v1：v1 没覆盖 closeSession，直接用这份
      async closeSession(input: SessionIdRpcInput): Promise<void> {
        const rpc = await this.getRpc();
        return rpc.closeSession({ sessionId: input.sessionId });
      }

    // v2 版本（sdk-rpc-client-v2.ts:1363-1367）——覆盖且不调 super，所以基类那份在 v2 下永不执行
      override async closeSession(input: SessionIdRpcInput): Promise<void> {
        await this.runSessionAccess(input.sessionId, () =>
          this.klient.session(input.sessionId).close(),   // 经 klient 把"关这个会话"的命令送进引擎
        );
      }
    ```

    上面基类里的 `getRpc()` 不是没人实现——它是基类的**抽象方法**（rpc.ts:194 `protected abstract getRpc(): Promise<ResolvedCoreAPI>;`），两边各有实现，但含义完全不同：v1 是真实现（sdk-rpc-client.ts:111-113 `return this.ready;`——返回 v1 核心的 API 面）；v2 是一个**故意抛错的桩**（sdk-rpc-client-v2.ts:566-570）：

    ```ts
      protected getRpc(): Promise<never> {
        throw new KimiError(
          ErrorCodes.NOT_IMPLEMENTED,
          'This SDK method is not wired to agent-core-v2 yet.',
        );
      }
    ```

    这是 v2 的迁移护栏，类头注释写明了设计（sdk-rpc-client-v2.ts:8-12 原文："Any method not yet overridden here falls through to `getRpc()`, which fails loudly with `not_implemented` — migrated methods are the ones overridden below. Once every method is migrated, the v1 `getRpc()` dependency (and the v1 core) goes away entirely."）——还没迁移到 klient 的基类方法一旦被 v2 调到，会立刻在 getRpc() 处报"not_implemented"，而不是悄悄走错 v1 的路；全部迁完后这个依赖整体删掉。closeSession 已迁移（就是上面那份 override），所以不会碰到这个桩。

    ```ts
      override async closeSession(input: SessionIdRpcInput): Promise<void> {
        await this.runSessionAccess(input.sessionId, () =>
          this.klient.session(input.sessionId).close(),   // 经 klient 把"关这个会话"的命令送进引擎
        );
      }
    ```

    **第 5 层·klient**——SDK 内部的客户端门面，再往下就进引擎了，本篇到此为止。

    **测试的假货替换的就是第 2 层往下的全部**：塞一个假对象（test/kimi-runtime.test.ts:178-237 的 `createFakeHarness`，末尾 `as unknown as KimiHarness` 冒充类型）。于是第 1 层代码里那句 `await this.harness.closeSession(id);`（kimi-runtime.ts:203，第 1 层代码块的最后一次调用）调到的不再是包装类和它背后的整条链，而是假对象自己的方法——它只把收到的 id 记进数组，往下哪层都不走：

    ```ts
    // 假的（test/kimi-runtime.test.ts:213-222）：把收到的会话 id 各记一笔，不进引擎
        async closeSession(id: string) {
          closeSessionIds.push(id);
        },
        async deleteSession(id: string) {
          deleteSessionIds.push(id);
        },
    ```

    测试拿这些记录做断言，真断言长这样（test/kimi-runtime.test.ts:584-592，"delegates deletion after the active session has been closed"）：

    ```ts
      it("delegates deletion after the active session has been closed", async () => {
        const { runtime, sdk } = createRuntime();
        const opened = await runtime.openSession(openOptions());
        const boundary = sdk.sessions.get(opened.id)!;

        await runtime.deleteSession(opened.id);

        expect(boundary.closeCount()).toBe(1);              // SessionRuntime.close 确实关了引擎侧会话
        expect(sdk.deleteSessionIds).toEqual([opened.id]);  // 确实把 id 交给了 harness.deleteSession
      });
    ```

    两点如实说明：
    
    ① 假 harness 的 `closeSession`（`closeSessionIds`）在这份测试里**没有被任何断言用到**——它存在只是为了凑齐 KimiHarness 类的形状；真正被断言的是 `deleteSessionIds` 和 `boundary.closeCount()`。
    
    ② `closeSession` 有两条分支：**查不到会话 → 交给 harness**（kimi-runtime.ts:202-204，就是前面第 1 层代码块讲的那条；你在会话列表里删一个**没打开**的历史会话走的就是它）；**查到了 → 自己关**（kimi-runtime.ts:206-210：从 `sessions` 表删除、清掉它所有视图的绑定、`await runtime.close()`，第五节拆解）。**当前测试文件只覆盖了第二条**：全部测试里 `runtime.closeSession(` 只出现一次（test:578），那时会话刚 openSession 过、还在表里；"交给 harness"那条分支没有直接测试。

    **`KimiRuntime.sessions` vs `KimiHarness.activeSessions`——两张表是两层各自的“活会话”清单**：

    | - | `KimiRuntime.sessions`（kimi-runtime.ts:57） | `KimiHarness.activeSessions`（kimi-harness.ts:80） |
    |---|---|---|
    | 存什么 | 会话 id → **SessionRuntime**（插件侧的壳），＝插件层"我包装着哪些活会话" | 会话 id → **Session**，＝SDK 门面层"我创建（createSession）或恢复（resumeSession）出来、还没关的 Session 对象" |
    | 谁写入 | `wrapSession`（kimi-runtime.ts:241） | createSession / resumeSession 造出 Session 时（kimi-harness.ts:145/:210） |
    | 谁删除 | 视图清零、`closeSession`/`dispose` 主动关 | Session.close 完成时的 onClose 回调（kimi-harness.ts:140-141） |

    **正常情况两边同步**：出生两步紧挨着（harness 造 Session 时 set → 返回后 wrapSession 里 set）；关闭层层下传（SessionRuntime.close → Session.close → onClose 删）。不同步只出现在窗口期——Session 已造出、还没 wrap 或 wrap 前被拒。

    **那“KimiRuntime 查不到、harness 却有”的窗口**：只有一种——Session 已经从 harness 造出来了（activeSessions.set 已发生），但还没走到 wrapSession，或 wrap 前校验失败正在回滚。这种中间态交给 harness 关是对的。

    **而你真正常走的场景——删一个从没打开过的历史会话——两边都查不到**：`harness.closeSession` 的 `?.close()` 是**无害空操作**；真正删磁盘数据的是紧随其后的 `await this.harness.deleteSession(id)`（kimi-runtime.ts:215）——刚查了它的实现（kimi-harness.ts:283 起）：第一行也是同样的空操作兜底，第二行 `await this.rpc.deleteSession({ sessionId })` 才是真删。

    所以“交给 harness”那条分支的本质是**兜底**：不管这个 id 处于哪种状态（两边都没有＝空操作 无害；只有 harness 有＝ 关掉漏网的 Session），保证引擎侧活实例被告知关闭。


  - **`identity` 是这个插件报给服务端的身份**（kimi-runtime.ts:70-74：`productName: "kimi-code-vscode"`、`platform: "kimi_code_vscode"`）——它最终进 API 请求头（sdk-rpc-client-v2.ts:453：`requestHeaders: createKimiDefaultHeaders({ homeDir: this.homeDir, ...identity })`），服务端遥测据此区分一次请求来自 VS Code 插件还是 CLI。

  - 抛错处理不在这里——构造 harness 失败的 catch 在调用方 bridge-handler.ts:51-61（拼上"可开 kimi.useAgentCoreV1 回滚到 v1"的提示再重抛，见 [02-BridgeHandler方法详解.md](02-BridgeHandler方法详解.md) 第一节）。

## 二、两个查询：getSessionForView 与 getSession

```ts
// kimi-runtime.ts:79-86
getSessionForView(webviewId: string): SessionRuntime | undefined {
  const id = this.sessionByView.get(webviewId);
  return id === undefined ? undefined : this.sessions.get(id);
}
getSession(id: string): SessionRuntime | undefined {
  return this.sessions.get(id);
}
```

一个查两次（视图→id→会话，两次 Map 查找），一个只查一次。**getSessionForView 全插件唯一外部调用点**是 bridge-handler.ts:166——context 的 `getSession` 闭包，handlers 里所有 `ctx.getSession()` 最终都到这。**getSession 的 4 个调用点**各有用途（全部附源码原文）：

- bridge-handler.ts:181（resumeSession 闭包里，先查活会话，活着的直接复用它的 Session 对象）：`const current = this.runtime.getSession(sessionId);`

- bridge-handler.ts:298（getBaselineContent 取活会话的 summary）：`const active = this.runtime.getSession(sessionId)?.summary;`

- session.handler.ts:184（删会话前先记下它的订阅视图，好给它们广播 NewConversation）：`const affectedViews = ctx.runtime.getSession(params.sessionId)?.subscribers ?? [];`

- session.handler.ts:248（fork 前查源会话是否活着——活着才需要独占等待：runExclusiveAfterCancelling 会先 cancel 在途工作、等终态事件落地后再独占执行 fork，见 [05-SessionRuntime方法详解.md](05-SessionRuntime方法详解.md) 第七节）：`const active = ctx.runtime.getSession(params.sessionId);`

## 三、openSession：三分支＋收尾三步

**谁调用**：bridge-handler.ts:169（context 的 `getOrCreateSession` 闭包）——真实触发点是 chat.handler.ts:94，用户每次发消息的第一步（`runtime = await ctx.getOrCreateSession(params.model, params.effort ?? ..., params.sessionId);`，完整代码在 [02-BridgeHandler方法详解.md](02-BridgeHandler方法详解.md) 第五节）。参数 `OpenSessionOptions`：webviewId 和 workDir 来自闭包捕获与 `requireWorkDir`，model/effort 是 UI 挑选器选的值，sessionId 可选（webview 记着的会话 id），yoloMode 是全局设置快照。

```ts
// kimi-runtime.ts:88-101 —— 分支①：视图、会话、目录都没变
async openSession(options: OpenSessionOptions): Promise<SessionRuntime> {
  this.ensureOpen();
  const current = this.getSessionForView(options.webviewId);
  const requestedId = options.sessionId ?? current?.id;        // :91 请求的 id，没请求就用当前绑的

  if (
    current !== undefined &&
    requestedId === current.id &&
    areSameFsPath(current.session.workDir, options.workDir)    // :96 大小写/分隔符不敏感比较
  ) {
    await applySessionSettings(current.session, options, current.legacyApprovalFlags);
    await current.announceStatus(options.webviewId);
    return current;                                            // :100 直接复用
  }
```

分支①是快路径：同一视图对同一会话同一目录再发消息，**不新建不重连**，只重放权限设置（`applySessionSettings`，见第九节）＋把当前状态播报给视图（模型/思考档/plan 模式，让 UI 显示引擎真相而不是全局默认值）。

```ts
  // kimi-runtime.ts:103-138 —— 分支②③
  let runtime = requestedId === undefined ? undefined : this.sessions.get(requestedId);
  if (runtime !== undefined) {                                 // 分支②：会话仍在表里活着（必有别的视图正订阅(使用)着它）
    assertSessionWorkDir(runtime.session, options.workDir);    // :105 目录不符直接抛
    await applySessionSettings(runtime.session, options, runtime.legacyApprovalFlags);
    await this.detachView(options.webviewId);                  // :107 先拆本视图的旧绑定
  } else {
    const defaultApproval: LegacyApprovalFlags = { yolo: options.yoloMode, afk: false };
    const session =
      requestedId === undefined
        ? await this.harness.createSession({ workDir, model, thinking: normalizeEffort(effort), ... })  // :112 全新
        : await this.harness.resumeSession({ id: requestedId, includeSubagents: true });               // :119 恢复
    try {
      assertSessionWorkDir(session, options.workDir);          // :121 恢复出来的会话目录也得对
      const storedApproval = readLegacyApprovalFlags(session.summary?.metadata);          // 三级链第①级
      const restoredApproval =
        storedApproval ?? (await this.readMigratedLegacyApproval(session)) ?? defaultApproval; // ②③级
      const approval = withGlobalYoloMode(restoredApproval, options.yoloMode);             // 以全局 yolo 设置为准
      if (storedApproval === undefined || flagsDiffer(storedApproval, approval)) {
        await session.updateMetadata(legacyApprovalMetadata(approval));                    // :127 变了才写回
      }
      await applySessionSettings(session, options, approval);
      await this.detachView(options.webviewId);                // :130
      runtime = this.wrapSession(session, approval);           // :131 → 分支③出口
    } catch (error) {
      await session.close().catch((closeError: unknown) => {   // :133 拒收的会话关掉再抛
        this.log("Failed to close a rejected session", closeError);
      });
      throw error;
    }
  }

  runtime.subscribe(options.webviewId);                        // :140 收尾三步
  this.sessionByView.set(options.webviewId, runtime.id);       // :141
  await runtime.announceStatus(options.webviewId);             // :142
  return runtime;
}
```

分支②处理"会话还活着但不是本视图当前绑的"（典型：两个视图看同一个会话；或本视图还绑着旧会话 A、这次发消息却指名了 B——即**想要切换**：切换正是由分支②＋收尾三步完成的，先 `detachView` 拆 A 再 subscribe 绑 B，等切完，下一条消息就命中分支①、不会再进②），还有一个边缘情况：requestedId === current.id 但 workDir 不一致掉下来——此时 runtime === current，进②后立刻被 assertSessionWorkDir 抛错，不算复用。

注意"从历史列表点开某会话"走的是另一条路（LoadKimiSessionHistory → resumeSession → attachResumedSession，`session.handler.ts:130`），那条路有自己的表内复用（`kimi-runtime.ts:151-158`），不经过 openSession——openSession 全插件唯一入口是发消息（`chat.handler.ts:94`），"切换"在这里表现为这次消息带的 sessionId ≠ 该视图当前绑定的会话。

分支③是真正的新建/恢复，**model/effort 只在 createSession 时生效**（`kimi-runtime.ts:113-115`），恢复的会话保留自己的模型——`kimi-runtime.ts:268-272` 

**1. 代码事实：分支③的两条子路径待遇不同**
```ts
  // kimi-runtime.ts:112-118 —— 新建：model/effort 被当作出生参数传进去
  ? await this.harness.createSession({
        workDir: options.workDir,
        model: options.model || undefined,        // :114 生效
        thinking: normalizeEffort(options.effort), // :115 生效
        ...
      })
  // kimi-runtime.ts:119 —— 恢复：只传 id，model/effort 根本不在参数里
  : await this.harness.resumeSession({ id: requestedId, includeSubagents: true });
```
  
而且不止恢复路径——分支①②复用活会话时调的 `applySessionSettings（kimi-runtime.ts:262-277）` 只同步权限标志，不碰 model/effort。那段“原注释”就写在这个函数里：
> Model and thinking effort are applied only when the session is created. An existing session keeps its own — the global config values are defaults for new sessions, matching CLI/TUI resume semantics. Changes made in the pickers reach the active session through the SaveConfig handler instead.

**2. 对齐 CLI/TUI 的 resume 语义**
  
在 CLI/TUI 里，resume 一个历史会话＝接着原来的对话继续聊，原来用的什么模型还用什么；全局配置里的默认模型只是新会话的出生默认值。模型被看作对话历史的一部分——resume 时悄悄换成今天的默认模型，行为、风格、成本都会变，属于意外副作用。所以恢复出来的会话保留自己持久化的模型。

**3. UI 挑选器后来改的值, 经 SaveConfig handler 另路生效：**
  
- 挑选器改动 → `SaveConfig RPC（config.handler.ts:39-70）`：把选择持久化为新的全局默认（:57-60），并且对当前活会话立刻
  `setModel/setThinking（:63-68）`
  
- 每条消息发送时（`chat.handler.ts:108-117`，就是这段后面引的代码）：消息自带 params.model/params.effort，回合开始前和 getStatus() 比对，不一致就 setModel/setThinking 补齐。
```ts
const sreamChat: = async (params, ctx) => {
  // chat.handler.ts:104-107（注释原文）＋ :110-116（另路生效的代码）
  // Attach no longer overwrites session modes with the configured defaults
  // (resumed sessions keep their own), so apply the model/effort that the
  // composer submitted with this prompt before the turn starts.
  const status = await runtime.session.getStatus();
  let model = status.model;
  if (params.model && model !== params.model) {
    await runtime.session.setModel(params.model);
  }
}
```

输入框工具条上的模型下拉（`InputArea.tsx:447`）

```
    onClick={() => updateModel(model.id)}
      → updateModel（settings.store.ts:198）—— 先乐观更新本地状态
      → saveConfigWithRollback（settings.store.ts:207，RPC 失败时回滚 UI）
      → bridge.saveConfig（webview-ui/src/services/bridge.ts:137）
          即 RPC：Methods.SaveConfig，载荷 SessionConfig { model, thinking, effort, effortChanged }
      → 扩展宿主侧 handler：config.handler.ts:39 saveConfig
          ├ 持久化为全局默认：harness.setConfig({ defaultModel, thinking })（:57-60）
          └ 对当前活会话立刻生效：setModel / setThinking（:63-68）★
```

几个细节：

- **“挑选器”不只模型下拉**。同一排的思考按钮（`ThinkingButton`，`InputArea.tsx:467-476`）的开关和档位选择（`toggleThinking` /
`selectThinkingEffort`）也走同一个 `SaveConfig RPC`，载荷里的 `thinking/effort` 字段就是它们。注意 `plan` 模式按钮不走这里——它是随每条消息的`params.planMode` 传的（`chat.handler.ts:118`）。

- ★ 那一步就是上一轮说的“另路生效”：你在下拉里换了模型，**当前正聊着的会话**立刻被 `setModel`——不经过 openSession（openSession 只在 createSession出生时消费 model/effort）。同时这个选择被写成全局默认，影响**之后新建**的会话。

`selectThinkingEffort`也走同一个 **SaveConfig RPC**，载荷里的 `thinking/effort` 字段就是它们。注意 plan 模式按钮不走这里——它是随每条消息的`params.planMode` 传的（`chat.handler.ts:118`）。

- effortChanged 字段（shared/types.ts:7-13）实现 TUI 的 `persistModelSelection` 规则：重新确认界面上已显示的档位不算显式选择，只持久化模型、不动存的档位偏好。

一句话：**聊天框旁边的模型下拉（和思考按钮）＝“挑选器”；你一选，webview 就发一条 SaveConfig RPC，扩展宿主既把它存成全局默认、又立刻 setModel到活会话上**。

**审批标志三级恢复链**（`kimi-runtime.ts:122-128`，attachResumedSession `kimi-runtime.ts:161-169` 同构）：

- 第①级 `readLegacyApprovalFlags`：会话 metadata 里 `vscode_legacy_approval` 键下存的 `{yolo, afk}`——`legacy-approval.ts:13-17`：`const value = metadata?.[LEGACY_APPROVAL_METADATA_KEY]; return parseLegacyApprovalFlags(value);`

- 第②级 `readMigratedLegacyApproval`（本类私有方法，第八节）：metadata 里 `kimi_cli_source_path` 指向的旧 kimi-cli 安装目录，读它的 `state.json` 里的 approval——`legacy-approval.ts:27-33`：`text = await readFile(join(sourcePath, "state.json"), "utf8");` 然后 `const state = JSON.parse(text) as { readonly approval?: unknown }; return parseLegacyApprovalFlags(state.approval);`

- 第③级默认值 `{ yolo: 全局设置, afk: false }`（`kimi-runtime.ts:109`：`const defaultApproval: LegacyApprovalFlags = { yolo: options.yoloMode, afk: false };`）。

三级取第一个非空的，再过 `withGlobalYoloMode`（legacy-approval.ts:66-71）——**全局 yolo 设置是权威**，会话存的 yolo 与它冲突时以设置为准；afk 没有全局对应物，保持会话值。最后 `flagsDiffer` 判断有变化才 `updateMetadata` 写回（省一次无谓写盘，也保证下次的第①级能读到正确值）。

**收尾三步**（`kimi-runtime.ts:140-142`）是所有分支共享的出口：`subscribe`（视图进会话的订阅集）→ 双表之二 `set`（绑定）→ `announceStatus`（状态播报）。测试对这条链有四个直接断言（测试标题原文即文件内容）：

- test:399 `it("preserves the resumed session's model instead of reapplying the configured default", async () => {`

- test:409 `it("preserves the resumed session's thinking effort instead of reapplying the configured default", async () => {`

- test:419 `it("announces the session's actual status to the attaching view so the display matches it", async () => {`

- test:461 `it("lets the global yolo setting override a persisted off flag on resume", async () => {`（test:497 `it("keeps the persisted afk flag while applying the global yolo setting on resume", async () => {`）

## 四、attachResumedSession：把在手的 Session 绑上来

与 openSession 的分工：openSession 自己从 harness 拿 Session（create 或 resume）；attachResumedSession **收一个已经拿到的 Session 对象**再绑视图。

**谁调用**：bridge-handler.ts:193（context 的 `resumeSession` 闭包）——触发点 session.handler.ts:130（LoadKimiSessionHistory，用户点开历史会话）：`const runtime = await ctx.resumeSession(params.kimiSessionId);`。注意闭包里的分工（[02-BridgeHandler方法详解.md](02-BridgeHandler方法详解.md) 第五节讲过）：**workDir 校验在闭包里做过了**（bridge-handler.ts:185：`if (!areSameFsPath(session.workDir, this.requireWorkDir(webviewId))) {`，目录不符先 close 再抛），所以这里不会再遇到目录不符的路径。

```ts
// kimi-runtime.ts:146-185（节选）
async attachResumedSession(webviewId: string, session: Session, defaultYoloMode = false): Promise<SessionRuntime> {
  const existing = this.sessions.get(session.id);
  if (existing !== undefined && this.sessionByView.get(webviewId) === session.id) {  // :152 已绑给本视图
    existing.subscribe(webviewId);
    await existing.announceStatus(webviewId);
    return existing;                                            // :155 幂等重入
  }
  await this.detachView(webviewId);                             // :157
  let runtime = existing ?? this.sessions.get(session.id);
  if (runtime === undefined) {                                  // :159 会话不在表里 → wrap 一条
    try {
      const storedApproval = readLegacyApprovalFlags(session.summary?.metadata);   // 同一套三级链
      const restoredApproval = storedApproval ?? (await this.readMigratedLegacyApproval(session))
        ?? { yolo: defaultYoloMode, afk: false };
      const approval = withGlobalYoloMode(restoredApproval, defaultYoloMode);
      if (storedApproval === undefined || flagsDiffer(storedApproval, approval)) {
        await session.updateMetadata(legacyApprovalMetadata(approval));
      }
      const status = await session.getStatus();                 // :170 与 openSession 的差异点：
      const permission = corePermissionForLegacyApproval(approval);
      if (status.permission !== permission) await session.setPermission(permission); // :172
      runtime = this.wrapSession(session, approval);
    } catch (error) { /* 同 :174-179：close＋重抛 */ }
  }
  runtime.subscribe(webviewId);                                 // :181 收尾三步同 openSession
  this.sessionByView.set(webviewId, runtime.id);
  await runtime.announceStatus(webviewId);
  return runtime;
}
```

与 openSession 分支③的两处差异：这里的权限走 `getStatus + setPermission` 直改（`kimi-runtime.ts:170-172`，因为 Session 是外面 resume 出来的，可能带着旧权限）；openSession 里则统一由 `applySessionSettings` 处理。测试 "reattaches the same resumed session without replacing its handlers"（test:560：`it("reattaches the same resumed session without replacing its handlers", async () => {`）锁的是幂等分支：同一视图重入不换 handler（不重复 setApprovalHandler，避免双份审批回调）。

## 五、拆与关家族：detachView / closeSession / deleteSession / dispose

```ts
// kimi-runtime.ts:187-198
async detachView(webviewId: string): Promise<void> {
  const id = this.sessionByView.get(webviewId);
  if (id === undefined) return;
  this.sessionByView.delete(webviewId);            // 双表之二先删
  const runtime = this.sessions.get(id);
  if (runtime === undefined) return;
  runtime.unsubscribeView(webviewId);              // 订阅集里去掉
  if (runtime.subscribers.length === 0) {          // 引用计数清零
    this.sessions.delete(id);                      // 双表之一再删
    await runtime.close();                         // 真正关会话
  }
}
```

**谁调用**（最多面的方法，6 处全列）：

- bridge-handler.ts:125（setCustomWorkDir 换目录时）：`await this.runtime.detachView(webviewId);`

- bridge-handler.ts:202（context 的 closeSession，"新会话"按钮）：`await this.runtime.detachView(webviewId);`

- bridge-handler.ts:216（disposeView，webview 关闭）：`await this.runtime.detachView(webviewId);`

- 类内 openSession `kimi-runtime.ts:107`/`kimi-runtime.ts:130`、attachResumedSession `kimi-runtime.ts:157`（换绑前先拆旧的，三处都是 `await this.detachView(options.webviewId);` 或 `await this.detachView(webviewId);`）。

**删除顺序是双表之二先于一**：先解视图→会话的引用，才轮到会话本身被关。末位判定 `subscribers.length === 0` 就是引用计数清理：两个视图同看一个会话，关一个另一个照常（test:537：`it("keeps a shared session open when one of its Webview detaches", async () => {`）；最后一个关掉，会话整个 close（test:549：`it("closes an SDK session when its last Webview detaches", async () => {`）。

```ts
// kimi-runtime.ts:200-216
async closeSession(id: string): Promise<void> {
  const runtime = this.sessions.get(id);
  if (runtime === undefined) {              // 不在表里＝不是本 runtime 管的活会话
    await this.harness.closeSession(id);   // 直接让引擎关（磁盘上的休眠会话）
    return;
  }
  this.sessions.delete(id);
  for (const webviewId of runtime.subscribers) {
    this.sessionByView.delete(webviewId);  // 反向清双表之二：一个会话多个视图
  }
  await runtime.close();
}
async deleteSession(id: string): Promise<void> {
  await this.closeSession(id);
  await this.harness.deleteSession(id);    // 关完再删磁盘数据
}
```

`closeSession` 与 `detachView` 方向相反：detachView 从**视图**出发（可能只拆不关），closeSession 从**会话**出发（必关，且把它所有视图的绑定一并清掉，test:573：`it("removes every Webview mapping when a shared session is closed", async () => {`）。它的外部调用方只有 deleteSession（类内 `kimi-runtime.ts:214`：`await this.closeSession(id);`）和测试（test:578：`await runtime.closeSession(opened.id);`）——**生产代码里没有"只关会话不删数据"的入口**，UI 的删除走 `deleteSession`（session.handler.ts:185：`await ctx.runtime.deleteSession(params.sessionId);`）。不在表里的 id 也要能关：harness 里可能有本 runtime 没绑定过的休眠会话（比如 fork 出来还没人看过的），`harness.closeSession` 兜住它们。

```ts
// kimi-runtime.ts:224-231
async dispose(): Promise<void> {
  if (this.closed) return;                          // 幂等守卫
  this.closed = true;
  await Promise.all([...this.sessions.values()].map((session) => session.close()));
  this.sessions.clear();
  this.sessionByView.clear();
  await this.harness.close();                       // 最后关引擎
}
```

**谁调用**：bridge-handler.ts:294（插件 dispose，`await this.runtime.dispose();`）。顺序：先置 closed（挡住之后的 openSession）→ 并发关所有会话 → 清双表 → 关引擎。test:595 `it("closes every active SDK session when the host runtime is disposed", async () => {` 锁这条链。

## 六、setYoloModeForActiveSessions：设置变化时刷新所有活会话

```ts
// kimi-runtime.ts:218-222
async setYoloModeForActiveSessions(enabled: boolean): Promise<void> {
  await Promise.all(
    [...this.sessions.values()].map((session) => session.setLegacyYoloMode(enabled)),
  );
}
```

**谁调用**（调用链两层）：KimiWebviewProvider.ts:149——`await this.bridgeHandler.runtime.setYoloModeForActiveSessions(enabled);`，再往上 extension.ts:61-65（用户改了 `kimi.yoloMode` 设置时）：

```ts
// extension.ts:61-65
if (changedKeys.includes("yoloMode")) {
  void provider
    ?.setYoloModeForActiveSessions(VSCodeSettings.yoloMode)
    .catch((error) => logError("Unable to update session permission", error));
}
```

对每个活会话调 `setLegacyYoloMode`（SessionRuntime 的方法，内部先改引擎权限再写会话 metadata、写失败回滚权限，见 [05-SessionRuntime方法详解.md](05-SessionRuntime方法详解.md) 第四节）。`setLegacyYoloMode` 自己有"值没变就返回"的守卫，所以这里无脑全员调用是安全的。

## 七、wrapSession：全类唯一 new SessionRuntime 的地方（私有）

```ts
// kimi-runtime.ts:233-243
private wrapSession(session: Session, legacyApproval: LegacyApprovalFlags): SessionRuntime {
  const runtime = new SessionRuntime({
    session,
    legacyApproval,
    broadcast: this.broadcast,              // :237 从 BridgeHandler 一路转手来的
    captureBaseline: this.captureBaseline,
    log: this.log,
  });
  this.sessions.set(session.id, runtime);
  return runtime;
}
```

全类**只有这里 new SessionRuntime**，openSession `kimi-runtime.ts:131`（`runtime = this.wrapSession(session, approval);`）与 attachResumedSession `kimi-runtime.ts:173`（同款调用）两条路径汇于此。递下去的四样：SDK Session、算好的审批标志、以及从 BridgeHandler 一路转手来的 broadcast/captureBaseline/log（broadcast 这根线的旅程见 [dive-chain-broadcast链条详解.md](dive-chain-broadcast链条详解.md) 第 2-1 站——本类对它们**只转手、零调用**，grep 全文件可证：`broadcast` 只出现在 `kimi-runtime.ts:24`（类型）、`kimi-runtime.ts:54`（字段）、`kimi-runtime.ts:62`（赋值）、`kimi-runtime.ts:237`（转递）四处）。造完立即 `sessions.set` 入表——**入表和造对象在同一段代码里完成**，不存在"造了还没入表"的窗口。

## 八、readMigratedLegacyApproval：三级链的第二级（私有）

```ts
// kimi-runtime.ts:245-255
private async readMigratedLegacyApproval(session: Session): Promise<LegacyApprovalFlags | undefined> {
  const metadata = session.summary?.metadata;
  try {
    return await readMigratedLegacyApprovalFlags(metadata);
  } catch (error) {
    this.log("Unable to restore legacy session approval settings", error);
    return undefined;                     // 失败降级为"没有"，让链条落到第③级
  }
}
```

`readMigratedLegacyApprovalFlags`（legacy-approval.ts:20-34）读 `kimi_cli_source_path` 指向目录下的 `state.json`——旧 kimi-cli 的审批状态，迁移工具把这个路径写进会话 metadata。这个私有包装的唯一增值是**错误降级**：读旧文件可能遇到 JSON 损坏、权限等各种错，全吞掉记日志返回 undefined，让三级链自然落到默认值——**恢复不了偏好也不该挡住会话打开**。

## 九、ensureOpen 与文件级函数四件

`ensureOpen`（`kimi-runtime.ts:257-259`）就一行：

```ts
// kimi-runtime.ts:257-259
private ensureOpen(): void {
  if (this.closed) throw new Error("Kimi runtime is closed.");
}
```

openSession 的第一道门（`kimi-runtime.ts:89`：`this.ensureOpen();`），dispose 后的迟到请求在这里被拦。

```ts
// kimi-runtime.ts:262-277
async function applySessionSettings(session: Session, options: OpenSessionOptions, legacyApproval: LegacyApprovalFlags): Promise<void> {
  const status = await session.getStatus();
  // Model and thinking effort are applied only when the session is created (see openSession)...
  const permission = corePermissionForLegacyApproval(legacyApproval);
  if (status.permission !== permission) {
    await session.setPermission(permission);
  }
}
```

注意它**不动 model/effort**（注释 `kimi-runtime.ts:268-272` 解释了为什么——见第三节）。三个参数分别来自：openSession 的 options、和那条会话当前生效的审批标志。`corePermissionForLegacyApproval`（legacy-approval.ts:56-59）把两布尔翻译成引擎的 PermissionMode：

```ts
// legacy-approval.ts:56-59
export function corePermissionForLegacyApproval(flags: LegacyApprovalFlags): PermissionMode {
  if (flags.afk) return "auto";
  return flags.yolo ? "yolo" : "manual";
}
```

**先 getStatus 再对比才 set**：省掉无谓的 setPermission 往返。

`normalizeEffort`（`kimi-runtime.ts:279-281`，导出）：

```ts
// kimi-runtime.ts:279-281
export function normalizeEffort(effort: string): ThinkingEffort {
  return (effort.trim() || "off") as ThinkingEffort;
}
```

空串归一为 off。它是**导出**函数且有类外调用方（chat.handler.ts:114：`const effort = normalizeEffort(params.effort ?? (params.thinking === true ? "on" : "off"));`），所以不放进类里。

`flagsDiffer`（`kimi-runtime.ts:283-285`）：两布尔对比（`return a.yolo !== b.yolo || a.afk !== b.afk;`），"变了才写回"的门闸。`assertSessionWorkDir`（`kimi-runtime.ts:287-291`）：

```ts
// kimi-runtime.ts:287-291
function assertSessionWorkDir(session: Pick<Session, "workDir">, expectedWorkDir: string): void {
  if (!areSameFsPath(session.workDir, expectedWorkDir)) {
    throw new Error("The selected session belongs to a different working directory.");
  }
}
```

`areSameFsPath` 大小写/分隔符不敏感比较——**会话与目录的锁死关系**在 openSession 的两个调用点（`kimi-runtime.ts:105/:121`）把关，测试 test:608 `it("does not retain a resumed session when it belongs to a different working directory", async () => {` 锁的就是它。

## 十、设计复盘

1. **双表而不是一张 `Map<webviewId, SessionRuntime>`。** 拆成 id→会话、视图→id 两张表，"多视图共享会话"才有落点：任何一个视图都能通过 `sessions.get(id)` 摸到同一个 SessionRuntime 实例（事件只订一份、审批 handler 只挂一份）。反例：若一张表存视图→会话实例，两个视图绑定同一会话 id 时要么各造一个实例（事件重复订阅、审批回调挂两份），要么得另开反向索引找共享——那就是把双表换个地方重写。

2. **视图数清零才关会话（引用计数），且删表顺序固定。** 先 `sessionByView.delete` 再判 `subscribers.length === 0`，最后 `sessions.delete + close`。反例：若 detachView 无条件 close，第二个视图正看着会话时第一个视图关掉，会话被杀，活视图的下一发 prompt 打在一个已关闭的会话上。

3. **openSession 三分支共享一套收尾。** 无论快路径复用、换绑还是新建，出口都是 subscribe＋set＋announceStatus 三步——**绑定视图的仪式只有一份代码**。反例：三分支各自手写绑定，漏掉任何一步（比如忘了 announceStatus）就是"UI 显示的模型和引擎实际用的不一致"这类只在特定路径出现的 bug。

4. **拒收的会话必须 close 再抛。** openSession `kimi-runtime.ts:132-137` 与 attachResumedSession `kimi-runtime.ts:174-179` 的 catch 块。反例：直接抛，harness 里积一个谁也不绑的活会话；它是内存里的 SDK 对象，不关就泄漏到插件停用。

5. **全局 yolo 是权威、afk 是会话私有。** `withGlobalYoloMode` 只盖 yolo 不动 afk（legacy-approval.ts:61-65 注释原话："The global `kimi.yoloMode` setting is authoritative whenever a session attaches to the runtime; afk stays per-session because it has no global setting counterpart."）。反例：恢复时全按会话存的来，用户改了全局设置却对已恢复的会话无效，两处开关显示一致行为相反。

6. **wrapSession 是 SessionRuntime 的唯一出生点。** 反例：若 openSession 和 attachResumedSession 各自 new，"造完立即入 sessions 表"这个不变量要靠两处自觉；将来加第三个入口（比如 IDE 协议接入）再漏一处，就出现"活着的会话查不到"的漏网会话。

## 下一步

- wrapSession 造出来的东西：[05-SessionRuntime方法详解.md](05-SessionRuntime方法详解.md)（三根出线接线、模型回合与宿主假回合、取消/独占、终态去重）。

- 谁在 BridgeHandler 的构造函数里把能力递进本类：[02-BridgeHandler方法详解.md](02-BridgeHandler方法详解.md) 第一、五节。

- 双表的高层视图与"发一条消息的完整旅程"：[01-webview与Bridge通信.md](01-webview与Bridge通信.md) 第五、七节。
