# 02 · BridgeHandler 逐方法详解：357 行里的 RPC 中枢

> 时效基线：基于 commit `68ddf583b`（2026-08-25 提交；行号 2026-08-29 对照源码复核）。行号会随代码演进漂移，**本篇每处 `文件:行号` 引用都附带源码原文**——日后行号对不上时，按代码文本搜索即可重新定位。
> 实测基线：`pnpm -C apps/vscode exec vitest run test/bridge-handler.test.ts` → **26 个测试全部通过**（2026-08-29）。

## 全局认知

- **定位**：`apps/vscode/src/bridge-handler.ts`，357 行。它持有多项全局能力（三大资源 KimiRuntime / BaselineManager / FileManager 全在它的构造函数里出生——全插件"谁 new 谁、把什么递给谁"集中定在这一处）、**webview 消息的唯一入口与查表分发点**（每条从 webview 进来的 RPC 请求都从 `handle` 进来、查 `handlers` 表找到对应函数）、**四种"关"的持有者**（插件关 / 视图关 / 会话解绑 / 换目录解绑，见第十三节）。

- **构成**：4 个字段＋构造器＋18 个成员（2 个 getter、16 个方法）＋4 个文件级函数。本篇逐个讲"作用、参数、谁调用、为什么这样写"。

- **设计主线**：**每个 RPC 请求现拼一份 context**。`handle → dispatch → createContext(webviewId)` 每处理一个 RPC 请求都新建一个 `HandlerContext` 对象，把 webviewId 捕获进约 10 个闭包里——所有"按视图隔离"的逻辑（视图＝一个 webview 聊天页面实例，侧边栏或面板，第三节开头有完整定义与代码；工作目录、会话绑定、定向广播都按它隔离）都靠这一步，而不是靠调用方自己传 webviewId。

- **与 [01-webview与Bridge通信.md](01-webview与Bridge通信.md) 的分工**：01 那篇第二节给了这类的高层视图（RPC 中枢兼资源主人：消息怎么从 webview 进来、协议长什么样）；本篇下到方法级。broadcast 这根线的四层旅程见同目录 [dive-chain-broadcast链条详解.md](dive-chain-broadcast链条详解.md)，本篇只在构造注入处点到为止。

## 总地图

**4 个字段**（"出生处"列附出生那行的源码原文）：

| 字段 | 行号 | 类型 | 出生处（源码原文） |
|---|---|---|---|
| `baselineManager` | `bridge-handler.ts:26` | `BaselineManager`（readonly，公开） | `bridge-handler.ts:62` `this.baselineManager = new BaselineManager(globalStoragePath, this.runtime.harness.homeDir);` |
| `runtime` | `bridge-handler.ts:27` | `KimiRuntime`（readonly，公开） | `bridge-handler.ts:42` `this.runtime = new KimiRuntime({` |
| `customWorkDirs` | `bridge-handler.ts:29` | `Map<string, string>`（私有） | `bridge-handler.ts:29` `private readonly customWorkDirs = new Map<string, string>();`（字段声明即出生，空表） |
| `fileManager` | `bridge-handler.ts:30` | `FileManager`（私有） | `bridge-handler.ts:63` `this.fileManager = new FileManager(this.baselineManager, broadcast);` |

**18 个成员＋构造器**（"主要调用方"列＝真实调用点的源码原文，grep 实数；类内自调用不算）：

| 成员 | 行号 | 可见性 | 一句话作用 | 主要调用方（源码原文） |
|---|---|---|---|---|
| `constructor` | `bridge-handler.ts:32-64` | 公开 | 出生三大资源，接线六项能力 | `KimiWebviewProvider.ts:29`：`this.bridgeHandler = new BridgeHandler(`（全插件唯一一处 new） |
| `handle` | `bridge-handler.ts:66-88` | 公开 | RPC 唯一入口：校验→分发→兜错→trace | `KimiWebviewProvider.ts:107`：`const result = await this.bridgeHandler.handle(msg, webviewId);`（唯一） |
| `workspaceRoot` | `bridge-handler.ts:90-92` | 私有 getter | 工作区根目录字符串，没有则 null | 类内 7 处，如 `bridge-handler.ts:99`：`return this.customWorkDirs.get(webviewId) ?? this.workspaceRoot;` |
| `workspaceRootUri` | `bridge-handler.ts:94-96` | 私有 getter | 工作区根 Uri | 类内 5 处，如 `bridge-handler.ts:91`：`return this.workspaceRootUri?.fsPath ?? null;` |
| `getWorkDir` | `bridge-handler.ts:98-100` | 私有 | 某视图的工作目录：自定义表优先，否则工作区根 | 类内 3 处，如 `bridge-handler.ts:151`：`workDir: this.getWorkDir(webviewId),` |
| `getWorkDirUri` | `bridge-handler.ts:102-108` | 私有 | 同上的 Uri 版 | 类内 3 处，如 `bridge-handler.ts:226`：`const workDirUri = this.getWorkDirUri(webviewId);` |
| `setCustomWorkDir` | `bridge-handler.ts:110-127` | 私有 | 记住/清除某视图的自定义工作目录，并拆掉旧会话绑定 | `bridge-handler.ts:206` `setCustomWorkDir: (workDir) => this.setCustomWorkDir(webviewId, workDir),` → session.handler.ts:66/:124 两处调用，均在 RPC 处理器内（第三节） |
| `requireWorkDir` | `bridge-handler.ts:129-133` | 私有 | getWorkDir 的抛错版 | 类内 3 处，如 `bridge-handler.ts:171`：`workDir: this.requireWorkDir(webviewId),` |
| `requireWorkDirUri` | `bridge-handler.ts:135-139` | 私有 | getWorkDirUri 的抛错版 | `bridge-handler.ts:157`：`requireWorkDirUri: () => this.requireWorkDirUri(webviewId),` |
| `dispatch` | `bridge-handler.ts:141-146` | 私有 | 查 handlers 表调对应 handler | `handle`（bridge-handler.ts:77，唯一）：`const result = await this.dispatch(msg.method, msg.params, webviewId);` |
| `createContext` | `bridge-handler.ts:148-208` | 私有 | 每个 RPC 请求现拼一份 HandlerContext | `dispatch`（bridge-handler.ts:145，唯一）：`return handler(params, this.createContext(webviewId));` |
| `saveAllDirty` | `bridge-handler.ts:210-213` | 私有 | 保存所有脏文档（非 untitled） | `bridge-handler.ts:205` `saveAllDirty: () => this.saveAllDirty(),` → chat.handler.ts:85：`await ctx.saveAllDirty();` |
| `disposeView` | `bridge-handler.ts:215-219` | 公开 | 一个 webview 关了：拆会话绑定＋清两张表 | provider KimiWebviewProvider.ts:56/:73/:139（3 处）：`void this.bridgeHandler.disposeView(webviewId);` |
| `getEditorMention` | `bridge-handler.ts:221-242` | 公开 | 把当前编辑器选区拼成 `@路径:行` 引用 | provider KimiWebviewProvider.ts:88：`const mention = await this.bridgeHandler.getEditorMention(webviewId, documentUri, selection);` |
| `captureFileBaseline` | `bridge-handler.ts:244-290` | 公开 | 保存基线快照的宿主侧关卡：三道校验＋转交＋后台刷面板 | 构造器闭包 `bridge-handler.ts:47`：`this.captureFileBaseline(session, filePath, webviewIds);` ← session-runtime.ts:504：`this.captureBaseline(`（链条见第九节） |
| `dispose` | `bridge-handler.ts:292-295` | 公开 | 整个插件停用：FileManager 先关、runtime 后关 | provider KimiWebviewProvider.ts:40：`void this.bridgeHandler.dispose();`、KimiWebviewProvider.ts:44：`return this.bridgeHandler.dispose();` |
| `getBaselineContent` | `bridge-handler.ts:297-302` | 公开 | 取某会话某文件的基线内容（diff 视图左栏用） | provider KimiWebviewProvider.ts:145：`return this.bridgeHandler.getBaselineContent(sessionId, filePath);` |
| `trace` | `bridge-handler.ts:304-309` | 私有 | 每个 RPC 请求记一行耗时日志 | `handle` 三个出口，如 `bridge-handler.ts:78`：`this.trace(msg.id, msg.method, Date.now() - startedAt, true);` |
| `logRuntimeError` | `bridge-handler.ts:311-316` | 私有 | 错误统一出口：console.error＋写日志 | 类内 8 处（全表见第十二节），如 `bridge-handler.ts:82`：``this.logRuntimeError(`Bridge request failed: ${msg.method}`, error);`` |

**4 个文件级函数**：

| 函数 | 行号 | 被谁调用（源码原文） |
|---|---|---|
| `errorDetail` | `bridge-handler.ts:319-327` | `bridge-handler.ts:312`（唯一）：`const detail = errorDetail(error);` |
| `baselineSession` | `bridge-handler.ts:329-335` | `bridge-handler.ts:177/:198` 各一次：`this.fileManager.setSession(webviewId, baselineSession(runtime));` |
| `baselineSummary` | `bridge-handler.ts:337-343` | `baselineSession`（bridge-handler.ts:330）：`return baselineSummary({`；`getBaselineContent`（bridge-handler.ts:301）：`return this.baselineManager.getContent(baselineSummary(summary), filePath);` |
| `resolveSessionFilePath` | `bridge-handler.ts:345-357` | `bridge-handler.ts:265`（唯一）：`const resolved = resolveSessionFilePath(workDirUri, session.workDir, filePath);` |

## 一、constructor：三大资源在这里出生

```ts
// bridge-handler.ts:32-64（节选）
constructor(
  private readonly broadcast: BroadcastFn,          // :33 发消息给 webview 的能力
  private readonly workspaceState: vscode.Memento, // :34 工作区级键值存储
  globalStoragePath: string,                        // :35 全局存储目录（没存成字段，用完即弃）
  private readonly reloadWebview: ReloadWebviewFn,  // :36 重载某个 webview
  private readonly showLogs: ShowLogsFn,            // :37 打开输出面板
  private readonly writeLog: (message: string) => void, // :38 写一行日志
) {
  const useAgentCoreV1 = VSCodeSettings.useAgentCoreV1;
  try {
    this.runtime = new KimiRuntime({ ... });        // :42 引擎包装层
  } catch (error) {
    // No silent fallback: report the failure with the rollback path...
    const rollbackHint = useAgentCoreV1
      ? ""
      : " You can roll back to the legacy engine: enable the 'kimi.useAgentCoreV1' setting and reload the window.";
    throw new Error(
      `Failed to start the Kimi engine: ${error instanceof Error ? error.message : String(error)}.${rollbackHint}`,
      { cause: error },
    );
  }
  this.baselineManager = new BaselineManager(globalStoragePath, this.runtime.harness.homeDir); // :62
  this.fileManager = new FileManager(this.baselineManager, broadcast);                        // :63
}
```

**六个参数的实参全部来自 provider 的构造调用**：

```ts
// KimiWebviewProvider.ts:23-37（provider 的构造函数；provider 本身由 extension.ts:24 new 出来）
constructor(
  private readonly extensionUri: vscode.Uri,
  context: vscode.ExtensionContext,
  showLogs: () => void,
  writeLog: (message: string) => void,
) {
  this.bridgeHandler = new BridgeHandler(
    this.broadcastInternal.bind(this),    // ← broadcast：postMessage 的总出口
    context.workspaceState,               // ← workspaceState
    context.globalStorageUri.fsPath,      // ← globalStoragePath
    this.reloadWebview.bind(this),        // ← reloadWebview（provider :124-129 重设 webview.html）
    showLogs,                             // ← extension.ts:27 递进来的 () => outputChannel?.show(),
    writeLog,                             // ← extension.ts:28 递进来的 (message) => log(message)（写输出通道）
  );
}
```

- `broadcast` ← `this.broadcastInternal.bind(this)`：它在本类里的完整去向见 broadcast 链条篇——一句话：本类**自己从不调用**它（grep 全文件，`broadcast` 只在 `bridge-handler.ts:33` 收下、`bridge-handler.ts:45` 递给 KimiRuntime、`bridge-handler.ts:63` 递给 FileManager、`bridge-handler.ts:158` 塞进 context 四处出现，没有一处 `this.broadcast(...)`），它对这根线的全部职责是"收一份、发三份"；

- `globalStoragePath` ← `context.globalStorageUri.fsPath`：只用来算 BaselineManager 的根（`bridge-handler.ts:62`），**不存成字段**——本类后续不再需要它；

- `writeLog` ← extension.ts:28：`(message) => log(message)`，`log` 往输出通道追加一行（extension.ts:150-152 `outputChannel?.appendLine(...)`）——`trace` 和 `logRuntimeError` 靠它落盘。

**构造器做了三件事**：

1. **new KimiRuntime（`bridge-handler.ts:42-50`）**，构造参数里有两个闭包值得展开——它们是本类两个私有方法的"接线"：

   - `captureBaseline: (session, filePath, webviewIds) => { this.captureFileBaseline(session, filePath, webviewIds); }`（`bridge-handler.ts:46-48`）。KimiRuntime 不认识 BaselineManager（防止上层依赖下层），但引擎改文件前需要保存基线快照（**保存基线快照＝代码里的 `capture`：抢在工具改文件之前，把这个文件当前的内容读出来存下来，当后续比对的"基准"**；之后算 File Changes、回滚、看 diff 都是拿这份基准跟现状比——存储机制全在 [04-BaselineManager方法详解.md](04-BaselineManager方法详解.md)），于是 BridgeHandler 的构造函数把这个回调递进去。递进去之后的完整路线：

     ```ts
     // kimi-runtime.ts:63（构造函数里存成字段）
     this.captureBaseline = options.captureBaseline;
     // kimi-runtime.ts:238（wrapSession 里转递给 SessionRuntime）
     captureBaseline: this.captureBaseline,
     // session-runtime.ts:504-512（最终调用点：引擎要改文件了）
     this.captureBaseline(
       {
         id: this.session.id,
         workDir: this.session.workDir,
         metadata: summary?.metadata,
       },
       filePath,
       this.subscribers,
     );
     ```

     **绕一圈回到本类的 `captureFileBaseline`**——这就是术语表"控制反转"条目的实例（什么时候调用由 SessionRuntime 定，函数体干什么由本类定）。

   - `log: (message, error) => this.logRuntimeError(message, error)`（`bridge-handler.ts:49`）。同样绕一圈：KimiRuntime/SessionRuntime 里所有 `this.log(...)` 最终都落到本类的 `logRuntimeError`，写进同一个输出通道。

2. **引擎启动失败不静默兜底（`bridge-handler.ts:51-61`）**：catch 后拼上回滚提示（v2 引擎起不来时提示用户开 `kimi.useAgentCoreV1` 回 v1）再 throw。注释原话 "No silent fallback"——与其带着坏引擎继续跑出诡异行为，不如当场报错给用户一条出路。

3. **按依赖顺序出生剩下两个资源**：`bridge-handler.ts:62` BaselineManager 需要 `this.runtime.harness.homeDir`（引擎的homeDir＝引擎存自己配置、会话数据的根目录，不指定时依次取 `KIMI_CODE_HOME` 环境变量、`~/.kimi-code`——解析逻辑在 agent-core-v2/src/app/bootstrap/bootstrap.ts:165：`return homeDir ?? env['KIMI_CODE_HOME'] ?? join(osHomeDir, '.kimi-code');`。拿它做命名空间隔离＝BaselineManager 把homeDir的哈希拼进基线根目录路径，baseline.manager.ts:76：`this.baselinesRoot = path.join(globalStorageRoot, 'baselines', hash(homeNamespace));`——不同家目录的基线各写各的子目录、互相看不见。完整机制见 [04-BaselineManager方法详解.md](04-BaselineManager方法详解.md) 第一节），所以必须排在 KimiRuntime 之后；`bridge-handler.ts:63` FileManager 需要 BaselineManager（算 diff）和 broadcast（刷面板），排在最后。**这个 new 的顺序就是三个类的依赖方向**：FileManager → BaselineManager → KimiRuntime → SDK。

## 二、handle：RPC 唯一入口

```ts
// bridge-handler.ts:66-88
async handle(value: unknown, webviewId: string): Promise<RpcResult> {
  const startedAt = Date.now();
  const validation = validateRpcMessage(value);
  if (!validation.ok) {
    this.trace(validation.id, validation.method, Date.now() - startedAt, false);
    this.logRuntimeError(`Bridge request rejected: ${validation.method}`, validation.error);
    return { id: validation.id, error: validation.error };
  }

  const msg = validation.message;
  try {
    const result = await this.dispatch(msg.method, msg.params, webviewId);
    this.trace(msg.id, msg.method, Date.now() - startedAt, true);
    return { id: msg.id, result };
  } catch (error) {
    this.trace(msg.id, msg.method, Date.now() - startedAt, false);
    this.logRuntimeError(`Bridge request failed: ${msg.method}`, error);
    return {
      id: msg.id,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
```

**参数**：`value` 是 webview `postMessage` 过来的原始 JSON（`unknown`，因为 webview 是不可信输入——页面脚本可能被注入、新旧构建的协议可能不齐，参数形状必须逐字段手写校验，[01-webview与Bridge通信.md](01-webview与Bridge通信.md) 第 3.4 节展开）；`webviewId` 是 provider 分配的 `sidebar_xxx` / `panel_xxx`。**实参谁递的**——全插件唯一调用点：

```ts
// KimiWebviewProvider.ts:106-109（setupWebview 里挂的消息回调）
webview.onDidReceiveMessage(async (msg: unknown) => {
  const result = await this.bridgeHandler.handle(msg, webviewId);
  webview.postMessage(result);
});
```

这也是 webview→宿主方向唯一的数据入口。四段逻辑：

1. `validateRpcMessage`（`shared/bridge.ts:104`：`export function validateRpcMessage(value: unknown): RpcMessageValidation {`）先验形状。失败也**必须回包**（带同样的 id），否则 webview 侧 pending Map 里的 Promise 要等到 10 分钟超时——所以校验失败走 `return { id, error }` 而不是 throw。

2. 成功路径 `await this.dispatch(...)`，任何 handler 抛的错在这里被 catch 成 `{ id, error }` 回给 webview。**这层 catch 是所有 handler 的公共安全网**：47 个 handler（按 `[Methods.` 键计，grep 实数）谁抛错都不会打断 `onDidReceiveMessage` 循环。

3. 成败两条路都调 `trace`（第十二节）。

4. 回包由上面临调用点里的 `webview.postMessage(result)` 送回 webview。

## 三、工作目录家族：5 个成员一台戏

先立住三个概念，每个都有代码：

**① 视图＝一个 webview 页面实例。** 插件的聊天界面跑在 webview（插件内嵌的网页，只有浏览器 API）里，来源有两种，provider 给每个实例发一个带前缀的 id：

```ts
// KimiWebviewProvider.ts:51-53（侧边栏：VS Code 左侧活动栏的 Kimi 面板）
resolveWebviewView(webviewView: vscode.WebviewView): void {
  const webviewId = `sidebar_${crypto.randomUUID()}`;

// KimiWebviewProvider.ts:61-63（面板："Kimi: Open in Tab" 命令开的独立标签页）
createPanel(): vscode.WebviewPanel {
  const webviewId = `panel_${crypto.randomUUID()}`;
```

同一个窗口可以同时开着一个侧边栏＋多个面板——**每个都是独立视图**：各自渲染一份聊天 UI，可以各自绑不同的会话，也各自有自己的工作目录。

**② 视图的工作目录＝该视图发消息、开会话时使用的目录。** 就是下面 `getWorkDir(webviewId)` 的返回值：先查 `customWorkDirs` 这张"视图 → 自定义目录"映射，没查到则退回工作区根（`workspaceFolders[0]`）。会话的引擎就跑在这个目录里——它划定会话的默认**工作区**，但**不是"只能读这个目录"**（边界规则见下面；保存基线快照倒是严格限死在会话目录内，第九节的三道门）。

  **1. 引擎的文件边界：“工作区”的范围 ＝ 工作目录＋additionalDirs；界外绝对路径可过闸。** ：

  ```ts
  // packages/agent-core-v2/src/tool/path-access.ts:181-191（"工作区内"的判定：工作目录，或任一 additionalDir）
  export function isWithinWorkspace(candidate, config, pathClass): boolean {
    if (isWithinDirectory(candidate, config.workspaceDir, pathClass)) return true;
    for (const dir of config.additionalDirs) {
      if (isWithinDirectory(candidate, dir, pathClass)) return true;
    }
    return false;
  }
  ```

  `additionalDirs` 是用户在会话里用 `/add-dir` 命令加的（`slash-command.ts:183：const result = await runtime.session.addAdditionalDir(input, { persist: false });`），加完就是“界内”。

  **2. 界外的文件不是读不了——默认策略下给绝对路径就能过闸，** 只有相对路径才被拒：
  
  ```ts
  // path-access.ts:95-98（默认策略）＋ :271-285（节选：界外的两条规则）
  export const DEFAULT_WORKSPACE_ACCESS_POLICY: WorkspaceAccessPolicy = {
    guardMode: 'absolute-outside-allowed',
    checkSensitive: true,
  };
  ...
  if (policy.checkSensitive && isSensitiveFile(canonical)) {
    throw new PathSecurityError('PATH_SENSITIVE', ...);   // 敏感文件（env/凭据/SSH key）：无论界内界外，直接拦
  }
  // :271-285（节选）
  if (outsideWorkspace) {
    switch (policy.guardMode) {
      case 'absolute-outside-allowed':
        if (!rawIsAbsolute) {
          throw new PathSecurityError('PATH_OUTSIDE_WORKSPACE', ...);  // 相对路径出界 → 拒
        }
        break;   // 绝对路径出界 → 放行，只在返回值里标记 outsideWorkspace: true
  ```

  这也和插件侧 `getEditorMention` 的注释互相印证（bridge-handler.ts:227-231 原文）：“目录外（比如会话 additionalDirs 下的文件）回退到绝对路径，**由会话的工具层决定可读性**”。


  **3. 真正无论在哪都读不了的是敏感文件**——`checkSensitive: true` 时 env/凭据/SSH key 模式直接抛 `PATH_SENSITIVE（path-access.ts:261-268）`，不分界内界外。另外个别入口更严：`workspaceContextService.ts:78` 对出工作区的路径直接抛 `FS_PATH_ESCAPES`，不分绝对相对。

  总结：界外文件给绝对路径就能访问（相对路径才被拒）；`/add-dir` 可把别的目录正式加进工作区；敏感文件无论在哪都被拦

**③ "用户能在对话框里选子目录"的完整链条**——界面按钮 → RPC → VS Code 原生选择框 → `setCustomWorkDir`，四段代码：

- 界面入口：

```ts
// webview-ui/src/components/ActionMenu.tsx:58-61（聊天界面的操作菜单里点"换工作目录"）
const handleChangeWorkDir = () => {
  useSettingsStore.getState().setWorkDirModalOpen(true);   // 弹出 WorkDirModal
  setOpen(false);
};
```

- 弹窗按钮：

```ts
// webview-ui/src/components/WorkDirModal.tsx:35-47（弹窗里的 Browse 按钮）
const handleBrowse = async () => {
  setLoading(true);
  try {
    const result = await bridge.browseWorkDir();    // :38 发 RPC（wire 名 "browseWorkDir"，shared/bridge.ts:46）
    if (result.ok && result.workDir) {
      setCurrentWorkDir(result.workDir === workspaceRoot ? null : result.workDir);
      await startNewConversation();                 // 换目录＝换会话，与宿主侧的 detachView 呼应
      setWorkDirModalOpen(false);
    }
  } finally {
    setLoading(false);
  }
};
```

宿主侧收到 RPC 后弹的"对话框"其实是 VS Code 原生的**快速选择框**（QuickPick，列工作区根下的子目录）：

```ts
// session.handler.ts:74-98（BrowseWorkDir handler，节选）
[Methods.BrowseWorkDir]: async (_, ctx) => {
  ...
  const entries = await vscode.workspace.fs.readDirectory(workspaceUri);  // :79 列工作区根的内容
  subdirectories = entries
    .filter(([name, type]) => type === vscode.FileType.Directory && !name.startsWith("."))
    .map(([name]) => name)
    .toSorted();                                                          // 只留子目录、去掉隐藏目录、按序
  const picked = await vscode.window.showQuickPick(                       // :87 ★"对话框"＝这个
    [
      { label: "$(folder) Browse...", description: "Open folder picker", alwaysShow: true },
      { label: "", kind: vscode.QuickPickItemKind.Separator },
      ...subdirectories.map((name) => ({
        label: `$(folder) ${name}`,
        description: path.join(ctx.workspaceRoot!, name),
      })),
    ],
    { placeHolder: "Select a subdirectory or browse...", title: "Working Directory" },
  );
  if (!picked) return { ok: false, workDir: null };
```

选了 Browse... 则走系统文件夹选择框；两条路汇合后还有"必须在工作区内"的校验，最后落到本类的 `setCustomWorkDir`：

```ts
// session.handler.ts:101-110（Browse... 分支：系统文件夹选择框）
if (picked.label === "$(folder) Browse...") {
  const result = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    defaultUri: workspaceUri,
    openLabel: "Select Working Directory",
  });
  if (!result?.[0]) return { ok: false, workDir: null };
  selectedUri = result[0];
}
```

- 校验＋落点 `isWorkspacePathContained` 拦截工作区外的选择：

```ts
// session.handler.ts:119-125（校验＋落点）
if (!(await isWorkspacePathContained(workspaceUri, selectedUri))) {
  await vscode.window.showWarningMessage("Selected directory must be within the workspace.");
  return { ok: false, workDir: null };
}
const selected = selectedUri.fsPath;
await ctx.setCustomWorkDir(selected === ctx.workspaceRoot ? null : selected);   // :124 → 本类 :110
```

这套成员维护的"webviewId → 自定义目录"映射（`customWorkDirs` 字段），就是给上面这条链记账：选过的子目录记进表，选回根目录就从表里删。

```ts
// bridge-handler.ts:90-96
private get workspaceRoot(): string | null {
  return this.workspaceRootUri?.fsPath ?? null;
}
private get workspaceRootUri(): vscode.Uri | null {
  return vscode.workspace.workspaceFolders?.[0]?.uri ?? null;
}
```

两个 getter 是"多根工作区只认第一个文件夹"策略的落点（`workspaceFolders?.[0]`）。没有打开文件夹时返回 null——**上层所有"没工作区"报错都源于这两个 null**。

```ts
// bridge-handler.ts:98-108
private getWorkDir(webviewId: string): string | null {
  return this.customWorkDirs.get(webviewId) ?? this.workspaceRoot;
}
private getWorkDirUri(webviewId: string): vscode.Uri | null {
  const workspaceRoot = this.workspaceRoot;
  const workspaceRootUri = this.workspaceRootUri;
  const workDir = this.getWorkDir(webviewId);
  if (workspaceRoot === null || workspaceRootUri === null || workDir === null) return null;
  return workDirUriFromPath(workspaceRootUri, workspaceRoot, workDir) ?? null;
}
```

`getWorkDir` 是本家族的核心：**自定义表优先，工作区根兜底**。`getWorkDirUri` 把字符串目录换算回 Uri：`workspaceRoot`（`bridge-handler.ts:90-92`）就是 `workspaceRootUri.fsPath`，两种形态都传给工具函数——字符串根算相对路径，根 Uri 拼结果：

```ts
// utils/workspace-path.ts:13-23
export function workDirUriFromPath(
  workspaceRootUri: vscode.Uri,
  workspaceRoot: string,
  workDir: string,
): vscode.Uri | undefined {
  const relativePath = relativeFsPath(workspaceRoot, workDir);   // 用字符串根：workDir 相对根在哪（不在根之下 → undefined）
  if (relativePath === undefined) return undefined;
  return relativePath === ""
    ? workspaceRootUri                                            // 用根 Uri：workDir 就是根 → 直接返回它
    : vscode.Uri.joinPath(workspaceRootUri, ...toPathSegments(relativePath));  // 用根 Uri：拼出结果 Uri
}
```

`relativeFsPath(workspaceRoot, workDir)` 返回 undefined 即"workDir 不在工作区根之下"——`getWorkDirUri` 返回 null 的判定就在这。

```ts
// bridge-handler.ts:110-127
private async setCustomWorkDir(webviewId: string, workDir: string | null): Promise<void> {
  const workspaceRoot = this.workspaceRoot;
  const workspaceRootUri = this.workspaceRootUri;
  if (workspaceRoot === null || workspaceRootUri === null) throw new Error("No workspace folder open");
  if (workDir !== null) {
    const workDirUri = workDirUriFromPath(workspaceRootUri, workspaceRoot, workDir);
    if (workDirUri === undefined || !(await isWorkspacePathContained(workspaceRootUri, workDirUri))) {
      throw new Error("Working directory must be within the workspace");
    }
  }
  if (workDir && workDir !== this.workspaceRoot) {
    this.customWorkDirs.set(webviewId, workDir);
  } else {
    this.customWorkDirs.delete(webviewId);
  }
  await this.runtime.detachView(webviewId);
  this.fileManager.clearSession(webviewId);
}
```

**谁调用**：context 闭包（`bridge-handler.ts:206`：`setCustomWorkDir: (workDir) => this.setCustomWorkDir(webviewId, workDir),`），即 handler 里的 `ctx.setCustomWorkDir(...)`。真实触发点有两个，都在 session.handler.ts：

```ts
// session.handler.ts:57-66（SetWorkDir RPC：webview 直接设工作目录）
[Methods.SetWorkDir]: async (params: { workDir: string | null }, ctx) => {
  ...
  try {
    await ctx.setCustomWorkDir(target);

// session.handler.ts:124（SelectWorkingDirectory RPC：用户在对话框里选完目录的落点）
await ctx.setCustomWorkDir(selected === ctx.workspaceRoot ? null : selected);
```

**四段逻辑**：先拒绝无工作区；再验证所选目录**必须在工作区内**（`isWorkspacePathContained`，异步 realpath 级判断）；然后更新映射——选根目录等于"清除自定义"（delete 而不是 set 根路径），这样 `getWorkDir` 的 `??` 兜底自然生效；最后两行是关键副作用：**换目录 = 换会话**，把该视图从旧会话上拆下来（`detachView`：把视图从会话的订阅集移除，订阅清零才会话整个关掉，见 [03-KimiRuntime方法详解.md](03-KimiRuntime方法详解.md) 第五节），并清掉 FileManager 里该视图的会话绑定与跟踪文件（面板归零）。

`requireWorkDir` / `requireWorkDirUri`（`bridge-handler.ts:129-139`）是前两者的抛错版——`if (!workDir) throw new Error("No workspace folder open")`。存在意义：context 里给 handler 的 `workDir` 是可空的（`bridge-handler.ts:151`），但**开会话类的操作必须有目录**，于是 `getOrCreateSession`/`resumeSession` 闭包里用 `this.requireWorkDir(webviewId)`（`bridge-handler.ts:171`：`workDir: this.requireWorkDir(webviewId),`、`bridge-handler.ts:185`：`if (!areSameFsPath(session.workDir, this.requireWorkDir(webviewId))) {`）把"没目录"从"静默 null"升级成一条明确报错。

## 四、dispatch：查表，不写 switch

```ts
// bridge-handler.ts:141-146
private dispatch(method: RpcMethod, params: unknown, webviewId: string): Promise<unknown> {
  if (!Object.hasOwn(handlers, method)) throw new Error(`Unknown method: ${method}`);
  const handler = handlers[method];
  if (!handler) throw new Error(`Unknown method: ${method}`);
  return handler(params, this.createContext(webviewId));
}
```

`handlers` 是七个 handler 文件合并出来的一张表——按主题分组、文件名即分组名（workspace/config/mcp/session/chat/file/auth，每个都是 `<名>.handler.ts`）：

```ts
// handlers/index.ts:12-20
export const handlers: Record<string, Handler<any, any>> = {
  ...workspaceHandlers,
  ...configHandlers,
  ...mcpHandlers,
  ...sessionHandlers,
  ...chatHandlers,
  ...fileHandlers,
  ...authHandlers,
};
```

加一个新 RPC 方法，**BridgeHandler 这一层确实零改动**——表里多一个键而已，这就是查表分发相对 switch 的好处；但端到端把它加到能用——RPC 通道（编号、校验、回包）本来就在，加的只是这条通道新服务的一个 RPC 方法——要在四处登记（少一处，请求根本到不了 handler）。第三节"选工作目录"那条链，就是这四处登记先做完才跑得起来的：先按下面四步登记一个名叫 `BrowseWorkDir` 的 RPC 方法，之后才有 ActionMenu 弹窗、`bridge.browseWorkDir()` 调用、handler 弹 QuickPick 那一串。四处各是哪行代码：

- ① `shared/bridge.ts` 的 `Methods` 枚举加键（wire 名，宿主和 webview 共用这份枚举）——方法名不在这个集合里的消息在校验层就被拒：

```ts
// shared/bridge.ts:46
BrowseWorkDir: "browseWorkDir",

// shared/bridge.ts:100 ＋ :117-119（枚举值汇成合法方法名集合，不在集合里 → 拒收）
const rpcMethods = new Set<string>(Object.values(Methods));
...
if (!rpcMethods.has(method)) {
  return invalidMessage(id, method, `Unknown bridge method: ${method}`);
}
```

- ② 同一个文件（shared/bridge.ts）的 `validateParams`，按有没有参数二选一。

  无参方法：把方法名添进这串共享 case，加一行就完（BrowseWorkDir 添在 :147）：

```ts
// shared/bridge.ts:147、:151（:131-151 一串无参方法共用这个返回值）
    case Methods.BrowseWorkDir:
    ...
      return params === undefined;
```

  带参方法：写自己的 case 和检查（SaveConfig 的写法，:155-160）：

```ts
// shared/bridge.ts:155-160
    case Methods.SaveConfig:
      return isPlainObject(params)
        && typeof params["model"] === "string"
        && isOptionalType(params["thinking"], "boolean")
        && isOptionalType(params["effort"], "string")
        && isOptionalType(params["effortChanged"], "boolean");
```

  没在 `validateParams` 里写 case 的方法，会落到结尾的 `default: return false`（shared/bridge.ts:255-256）——请求直接被判"参数不合法"。

- ③ 对应 handler 文件加处理器——BrowseWorkDir 的处理器全段如下（session.handler.ts:74-126）：

```ts
// session.handler.ts:74-126
export const sessionHandlers: Record<string, Handler<any, any>> = {
  [Methods.BrowseWorkDir]: async (_, ctx) => {
    if (!ctx.workspaceRoot || !ctx.workspaceRootUri) return { ok: false, workDir: null };
    const workspaceUri = ctx.workspaceRootUri;
    let subdirectories: string[] = [];
    try {
      const entries = await vscode.workspace.fs.readDirectory(workspaceUri);
      subdirectories = entries
        .filter(([name, type]) => type === vscode.FileType.Directory && !name.startsWith("."))
        .map(([name]) => name)
        .toSorted();
    } catch {
      // The native picker remains available when directory enumeration fails.
    }

    ...

    const selected = selectedUri.fsPath;
    await ctx.setCustomWorkDir(selected === ctx.workspaceRoot ? null : selected);
    return { ok: true, workDir: selected };
  },
},

```

  它经 `sessionHandlers` 汇进上面那张 `handlers` 表——③ 落地后，这条 RPC 请求才有人干活；

- ④ webview 侧 `services/bridge.ts` 加包装方法——把"发一条 RPC 请求"包成本地函数。③④ 都落地后，WorkDirModal 里才有 `bridge.browseWorkDir()` 可调（就是第三节那段）：

```ts
// webview-ui/src/services/bridge.ts:226-228
browseWorkDir() {
  return this.call<{ ok: boolean; workDir: string | null }>(Methods.BrowseWorkDir);
}
```

四个落点里 ③ 是干活的人，①②④ 是"让请求能到它、让界面能调它"的登记手续。协议侧的完整清单见 [01-webview与Bridge通信.md](01-webview与Bridge通信.md) 第 3.2、3.4 节。两次检查（`hasOwn` + 真值）防的是原型链污染：`Object.hasOwn` 保证 `"toString"` 这类键名不会从 Object.prototype 上捞出一个函数来。**谁调用**：只有 `handle :77`（`const result = await this.dispatch(msg.method, msg.params, webviewId);`）。

## 五、createContext：每个 RPC 请求现拼一份 HandlerContext

**谁调用**：只有 `dispatch :145`（`return handler(params, this.createContext(webviewId));`）——意味着**每个 RPC 请求一份新对象**。20 个字段分四组看（完整类型定义在 handlers/types.ts:14-39）：

**第 1 组·视图身份与目录**（`bridge-handler.ts:150-157`）：`webviewId`、`workDir`、`workDirUri`、`workspaceRoot`、`workspaceRootUri`——后四个就是第三节那几个 getter 的直接调用。`requireWorkDir`/`requireWorkDirUri` 是闭包，捕获了本次的 webviewId。

这组有个对照值得看清：`bridge-handler.ts:151-152` 的 `workDir: this.getWorkDir(webviewId)` 存进 context 的是**当场调用的结果**（字符串或 null）——函数在 createContext 里执行完就没了，不存在 this 丢失，所以不用 `.bind(this)`；而 `bridge-handler.ts:156` 递出去的是函数，用的是箭头函数写法 `requireWorkDir: () => this.requireWorkDir(webviewId)`——箭头函数没有自己的 this，用的是定义处（createContext，类方法）的 this，永远是本实例，也不用 bind。什么时候必须 bind：递**裸方法引用**的时候——provider 递 broadcast 就是（`this.broadcastInternal.bind(this)`，KimiWebviewProvider.ts:30），不加 bind 的话对方一调用，函数体里的 `this` 不再是 provider，第一行 `this.webviews`（KimiWebviewProvider.ts:116）就报错。一句话：**立即调用不用 bind；递箭头函数不用 bind；递裸方法引用必须 bind**。

**第 2 组·三大资源原样递**（`bridge-handler.ts:158-162`）：`broadcast`、`fileManager`、`baselineManager`、`runtime`、`harness`（= `this.runtime.harness`，把最常用的 SDK 门面单独露出来，mcp/auth handler 直接用）。

**第 3 组·UI 能力**（`bridge-handler.ts:163-165`）：`reloadWebview`（捕获 webviewId，重载**发起请求的这个**视图）、`showLogs`、`logError`（包到 logRuntimeError）。

**第 4 组·会话生命周期闭包**——本方法的核心，四个闭包全是"捕获 webviewId ＋ 调 runtime"的形状：

```ts
// bridge-handler.ts:166-204
getSession: () => this.runtime.getSessionForView(webviewId),        // :166 查"这个视图绑的会话"
getSessionId: () => this.fileManager.getSessionId(webviewId),       // :167 查基线侧绑的会话 id
getOrCreateSession: async (model, effort, sessionId) => {           // :168-179 开新会话或复用
  const runtime = await this.runtime.openSession({
    webviewId,
    workDir: this.requireWorkDir(webviewId),
    model,
    effort,
    yoloMode: VSCodeSettings.yoloMode,
    ...(sessionId === undefined ? {} : { sessionId }),
  });
  this.fileManager.setSession(webviewId, baselineSession(runtime)); // :177 两侧同时记下会话
  return runtime;
},
resumeSession: async (sessionId) => {                                // :180-200 恢复历史会话
  const current = this.runtime.getSession(sessionId);
  const session = current?.session ?? (await this.runtime.harness.resumeSession({ id: sessionId, includeSubagents: true }));
  if (!areSameFsPath(session.workDir, this.requireWorkDir(webviewId))) {   // :185 目录必须对得上
    if (current === undefined) {
      await session.close().catch((error: unknown) => {              // :187 拒收的会话要关掉
        this.logRuntimeError("Unable to close a rejected session", error);
      });
    }
    throw new Error("The selected session belongs to a different working directory.");
  }
  const runtime = await this.runtime.attachResumedSession(webviewId, session, VSCodeSettings.yoloMode);
  this.fileManager.setSession(webviewId, baselineSession(runtime));  // :198
  return runtime;
},
closeSession: async () => {                                          // :201-204 只拆绑定不删数据
  await this.runtime.detachView(webviewId);
  this.fileManager.clearSession(webviewId);
},
```

`bridge-handler.ts:177`/`bridge-handler.ts:198` 的 `setSession` 是"两侧同时记下会话"：KimiRuntime 的路由表记一份（openSession 内部），FileManager 的视图状态记一份（`file.manager.ts:95-97`：`setSession(webviewId: string, session: BaselineSession): void { this.getViewState(webviewId).session = session; }`）——前者管"消息发给谁"，后者管"这个视图的 File Changes 面板按哪个会话算"。

四个闭包的**触发流程**——webview 上什么动作、发哪条 RPC、最后落到哪一行（handler 里这些闭包叫 `ctx.xxx`）：

- `getSession`——以"停止生成"为例，从按钮到这一行：输入框旁的停止按钮（InputArea.tsx:493：`<Button variant="destructive" size="icon-xs" onClick={abort}>`）→ webview store 的 `abort()` 动作（chat.store.ts:366：`void bridge.abortChat().catch(() => undefined);`）→ RPC `AbortChat` → 宿主 abortChat 处理器第一步 `chat.handler.ts:148`：`const runtime = ctx.getSession();`。webview 发这条 RPC 的时机共四个：点停止按钮（`abort()` 动作，chat.store.ts:365-366）；发出消息后等不到首包、握手超时定时器自动放弃（chat.store.ts:149-153，`bridge.abortChat()` 在 :152）；切到别的会话时正在生成（`bridge-handler.ts:289`）；开新会话前先停掉在途流（`bridge-handler.ts:341`）。其余调 `ctx.getSession()` 的地方同理都在某条 RPC 的处理器里，如插话 SteerChat（`bridge-handler.ts:173`）、重置会话 ResetSession（`bridge-handler.ts:180`）；

- `getOrCreateSession`——用户在输入框按发送：sendMessage 动作（chat.store.ts:163：`void bridge.streamChat(content, model, thinkingEffort, planMode, sessionId ?? undefined)`）→ RPC `StreamChat` → `chat.handler.ts:92-98`（streamChat 处理器第一步）：

  ```ts
  // chat.handler.ts:92-98
  let runtime: SessionRuntime;
  try {
    runtime = await ctx.getOrCreateSession(
      params.model,
      params.effort ?? (params.thinking === true ? "on" : "off"),
      params.sessionId,
    );
  ```

- `resumeSession`——用户在会话列表点开一条历史会话：SessionList.tsx:134：`const events = await bridge.loadSessionHistory(session.id);` → RPC `LoadKimiSessionHistory` → `session.handler.ts:130`：`const runtime = await ctx.resumeSession(params.kimiSessionId);`（ChatMessage.tsx:166 也调同一个包装方法——fork 出的新会话加载历史时）；

- `closeSession`——以"新会话"为例：用户点 New Conversation → `startNewConversation` 动作（chat.store.ts:334 起：先 :341 `await bridge.abortChat();` 停在途流，再 :344 `await bridge.resetSession();`）→ RPC `ResetSession` → resetSession 处理器（chat.handler.ts:179-185，`await ctx.closeSession();` 在 `bridge-handler.ts:182`）。其余调用：`session.handler.ts:132`/`bridge-handler.ts:144`（恢复历史会话失败时回滚）、`config.handler.ts:111`（SaveConfig 改完配置后，下次发消息强制重开会话）。

注意 `bridge-handler.ts:175` 那行的写法：`...(sessionId === undefined ? {} : { sessionId })`——可选参数用条件展开而不是传 `sessionId: undefined`，这是本仓库 CLAUDE.md 明文规定的风格（本篇照抄源码，读代码时别误当成多此一举）。

`resumeSession` 里 `bridge-handler.ts:187` 的 catch 值得停一秒：刚从 harness 恢复出来的会话发现目录不对，要**关掉再拒**（不然 SDK 会话泄漏在 harness 里）；但如果是本就活着的会话（`current !== undefined`），它可能还有别的视图在用，就**不能关**，只拒绝本视图。`baselineSession(runtime)`（`bridge-handler.ts:329-335`）把 SessionRuntime 裁成 BaselineManager 要的三字段形状（id/workDir/metadata）——FileManager 只需要这么多。

## 六、saveAllDirty：发消息前先落盘

```ts
// bridge-handler.ts:210-213
private async saveAllDirty(): Promise<void> {
  const dirty = vscode.workspace.textDocuments.filter((document) => document.isDirty && !document.isUntitled);
  await Promise.all(dirty.map((document) => document.save()));
}
```

**谁调用**：context 闭包（`bridge-handler.ts:205`：`saveAllDirty: () => this.saveAllDirty(),`）→ chat.handler.ts:83-90（用户开了 `kimi.autosave` 设置时，每次 streamChat 前先把编辑器里没保存的文件全存了，这样引擎读到的文件和用户看到的一致）：

```ts
// chat.handler.ts:83-90
if (VSCodeSettings.autosave) {
  try {
    await ctx.saveAllDirty();
  } catch (error) {
    emitCaughtError(ctx, error, "preflight");
    return { done: false };
  }
}
```

排除 untitled（还没路径的草稿页，保存会弹另存对话框）。

## 七、disposeView：一个 webview 关闭时清理什么

```ts
// bridge-handler.ts:215-219
async disposeView(webviewId: string): Promise<void> {
  await this.runtime.detachView(webviewId);       // 从会话上拆下来；最后一个视图时关会话
  this.customWorkDirs.delete(webviewId);          // 自定义目录跟着视图走，不跟会话走
  this.fileManager.disposeView(webviewId);        // 删掉该视图的全部 viewState
}
```

**谁调用**（3 处，全在 provider）：

```ts
// KimiWebviewProvider.ts:55-58（侧边栏视图关闭）
webviewView.onDidDispose(() => {
  void this.bridgeHandler.disposeView(webviewId);
  this.webviews.delete(webviewId);
});

// KimiWebviewProvider.ts:72-75（面板关闭，同形状）
panel.onDidDispose(() => {
  void this.bridgeHandler.disposeView(webviewId);
  this.webviews.delete(webviewId);
});

// KimiWebviewProvider.ts:137-142（resetAllWebviews——"Kimi: Reset" 命令把所有视图挨个拆掉再重载 HTML）
async resetAllWebviews(): Promise<void> {
  await Promise.all(
    [...this.webviews.keys()].map((webviewId) => this.bridgeHandler.disposeView(webviewId)),
  );
  this.reloadAllWebviews();
}
```

三行各自清理自己那张表——**本类不维护"webview 列表"**（那是 provider 的 `webviews` Map，`KimiWebviewProvider.ts:20`：`private webviews = new Map<string, vscode.Webview>();`），它维护的是"每个 webview 在我这三张子表里的痕迹"。

## 八、getEditorMention：Insert Current File 命令的幕后

```ts
// bridge-handler.ts:221-242（节选）
async getEditorMention(webviewId, documentUri, selection): Promise<string | null> {
  const workDirUri = this.getWorkDirUri(webviewId);
  if (workDirUri === null || documentUri.scheme !== workDirUri.scheme) return null;  // :232 虚拟文档不引用
  const filePath = relativeWorkspacePath(workDirUri, documentUri) ?? documentUri.fsPath; // :233 目录内相对、目录外绝对
  const mentionTarget = filePath.includes(" ") ? `"${filePath}"` : filePath;          // :236 带空格要引号
  if (selection.isEmpty) return `@${mentionTarget}`;
  return selection.start.line === selection.end.line                                // :239-241 行号格式三态
    ? `@${mentionTarget}:${selection.start.line + 1}`
    : `@${mentionTarget}:${selection.start.line + 1}-${selection.end.line + 1}`;
}
```

**谁调用**——provider KimiWebviewProvider.ts:88（insertEditorMention，即命令面板的 "Kimi: Insert File Mention"）：

```ts
// KimiWebviewProvider.ts:84-95
async insertEditorMention(documentUri: vscode.Uri, selection: vscode.Selection): Promise<boolean> {
  let inserted = false;
  await Promise.all(
    [...this.webviews.keys()].map(async (webviewId) => {
      const mention = await this.bridgeHandler.getEditorMention(webviewId, documentUri, selection);
      if (mention === null) return;
      inserted = true;
      this.broadcastInternal(Events.InsertMention, { mention }, webviewId);
    }),
  );
  return inserted;
}
```

返回的字符串由 provider 包成 `InsertMention` 事件推进输入框。三个细节都有注释背书（`bridge-handler.ts:227-235` 原注释）：scheme 不匹配直接放弃（`untitled:`、`git:` 这类虚拟文档没有可引用的路径）；目录外文件退绝对路径，由会话的工具层决定可读性（与 CLI/TUI 行为对齐）；路径含空格加引号防止被空白拆开。行号 +1 是因为 VS Code 选区 0 起、用户习惯 1 起。

## 九、captureFileBaseline：三道门＋交接＋后台刷新

这是保存基线快照的链条（引擎发 `tool.call.started` → SessionRuntime 过滤 Write/Edit → 本方法三道校验 → BaselineManager 落盘 → 面板刷新）的宿主侧中段；链条全文在 [01-webview与Bridge通信.md](01-webview与Bridge通信.md) 第 8.1 节，本篇讲方法本身。**谁调用**：构造器闭包 `bridge-handler.ts:46-48`——也就是第一节说的绕圈，SessionRuntime 在引擎发 `tool.call.started` 且工具为 Write/Edit 时调它，实参 `(会话三字段, 引擎给的文件路径, 当前订阅视图列表)`：

```ts
// session-runtime.ts:497-501（调用前的三关过滤）
private captureFileBaseline(event: Extract<Event, { type: "tool.call.started" }>): void {
  if (event.name !== "Write" && event.name !== "Edit") return;
  if (!isRecord(event.args)) return;
  const filePath = event.args["path"];
```

```ts
// bridge-handler.ts:244-290（节选）
captureFileBaseline(session, filePath, webviewIds): void {
  const workspaceRoot = this.workspaceRoot;
  const workspaceRootUri = this.workspaceRootUri;
  if (workspaceRoot === null || workspaceRootUri === null) return;          // :251 没工作区：静默放弃

  const workDirUri = workDirUriFromPath(workspaceRootUri, workspaceRoot, session.workDir);
  if (workDirUri === undefined || !isWorkspacePathContainedSync(workspaceRootUri, workDirUri)) {
    this.logRuntimeError("Unable to capture a file baseline",
      new Error("Session working directory is outside the workspace"));      // :258 会话目录出工作区：记错放弃
    return;
  }
  const resolved = resolveSessionFilePath(workDirUri, session.workDir, filePath);  // :265 相对/绝对路径归一
  if (resolved === undefined || !isWorkspacePathContainedSync(workDirUri, resolved.uri, { allowMissing: true })) {
    this.logRuntimeError("Unable to capture a file baseline",
      new Error("File is outside the session working directory"));           // :270 文件出会话目录：记错放弃
    return;
  }
  const capture = this.baselineManager.capture(session, resolved.uri.fsPath);  // :277 交接
  void capture                                                                 // :278 不等待完成
    .then(async () => {
      await Promise.all(
        webviewIds.map(async (webviewId) => {
          this.fileManager.trackFile(webviewId, resolved.uri.fsPath);          // :282 记入跟踪表
          await this.fileManager.refreshChanges(webviewId);                    // :283 面板刷新
        }),
      );
    })
    .catch((error) => {
      this.logRuntimeError("Unable to capture a file baseline", error);
    });
}
```

三道门（`bridge-handler.ts:251/:254-263/:266-275`）一道比一道细：工作区在不在 → 会话目录在工作区内吗 → 这个文件在会话目录内吗（`allowMissing: true` 因为 Write 要创建的新文件还不存在）。`void capture.then(...)` 的 `void` 是故意的：**本方法返回 void、同步返回控制权给引擎**，快照持久化和面板刷新在后台完成——引擎的工具调用一毫秒都不等它（真正"抢在写入前读到原内容"的时序由 BaselineManager.capture 里的同步读保证，见 [04-BaselineManager方法详解.md](04-BaselineManager方法详解.md) 第二节）。

`resolveSessionFilePath`（`bridge-handler.ts:345-357`，文件级函数）处理引擎给的路径两种形态：绝对路径（换算回会话目录内的相对路径，换算失败＝目录外，返回 undefined）与相对路径（`resolveWorkspacePath` 直接解析）。

## 十、dispose：插件停用

```ts
// bridge-handler.ts:292-295
async dispose(): Promise<void> {
  this.fileManager.dispose();
  await this.runtime.dispose();
}
```

**谁调用**——provider 的两个入口：

```ts
// KimiWebviewProvider.ts:39-45
dispose(): void {
  void this.bridgeHandler.dispose();      // VS Code subscriptions 协议调 provider.dispose 时
}
shutdown(): Promise<void> {
  return this.bridgeHandler.dispose();    // extension.ts:146：await provider?.shutdown();
}
```

顺序有意义：FileManager 先关（摘掉文件监听器，不再产生新的刷新请求），再关 runtime（每个活会话 cancel＋close，见 [03-KimiRuntime方法详解.md](03-KimiRuntime方法详解.md) 第五节）。`await` 保证 deactivate 返回时会话都已落停。

## 十一、getBaselineContent：diff 视图左栏的内容源

```ts
// bridge-handler.ts:297-302
async getBaselineContent(sessionId: string, filePath: string): Promise<string> {
  const active = this.runtime.getSession(sessionId)?.summary;
  const summary = active ?? (await this.runtime.harness.listSessions({ sessionId }))[0];
  if (summary === undefined) throw new Error("Session was not found.");
  return this.baselineManager.getContent(baselineSummary(summary), filePath);
}
```

**谁调用**——provider KimiWebviewProvider.ts:144-146：`getBaselineContent(sessionId: string, filePath: string): Promise<string> { return this.bridgeHandler.getBaselineContent(sessionId, filePath); }`，再往上extension.ts:40-52（`kimi-baseline:` 虚拟协议的 `TextDocumentContentProvider`，用户点开某个文件的 diff 视图时 VS Code 来要左栏内容，[01-webview与Bridge通信.md](01-webview与Bridge通信.md) 第 8.5 节有整条 UI 链）：

```ts
// extension.ts:40-52（节选）
vscode.workspace.registerTextDocumentContentProvider("kimi-baseline", {
  provideTextDocumentContent: async (uri) => {
    const sessionId = new URLSearchParams(uri.query).get("sessionId");
    if (!sessionId || !provider) return "";
    const relativePath = decodeURIComponent(uri.path.replace(/^\//, ""));
    try {
      return await provider.getBaselineContent(sessionId, relativePath);
    } catch (error) {
      logError("Unable to open baseline content", error);
      return "";
    }
  },
}),
```

两步查会话元信息：活着的会话直接拿 `summary`；没活着就 `listSessions` 从磁盘翻——**基线比会话活得久**，会话关了 diff 视图照样能开。`baselineSummary`（`bridge-handler.ts:337-343`）把 SDK 的 SessionSummary 裁成 BaselineManager 要的三字段。

## 十二、trace 与 logRuntimeError：观测双出口

```ts
// bridge-handler.ts:304-316
private trace(id: string, method: string, durationMs: number, ok: boolean): void {
  // Deliberately exclude params, prompt text, file paths, and credentials.
  const line = `[bridge] id=${id} method=${method} ok=${String(ok)} durationMs=${durationMs}`;
  console.debug(`[kimi-vscode] ${line}`);
  this.writeLog(line);
}
private logRuntimeError(message: string, error?: unknown): void {
  const detail = errorDetail(error);
  const line = `${message}${detail ? `: ${detail}` : ""}`;
  console.error(`[kimi-vscode] ${line}`);
  this.writeLog(line);
}
```

`trace` 是 [01-webview与Bridge通信.md](01-webview与Bridge通信.md) 第十节排错表的第一现场，**谁调用**：`handle` 的三个出口——`bridge-handler.ts:70`：`this.trace(validation.id, validation.method, Date.now() - startedAt, false);`、`bridge-handler.ts:78`：`this.trace(msg.id, msg.method, Date.now() - startedAt, true);`、`bridge-handler.ts:81`：`this.trace(msg.id, msg.method, Date.now() - startedAt, false);`。注释原话 "Deliberately exclude params, prompt text, file paths, and credentials"——日志里**故意**只有 id/method/ok/耗时四个字段，防的是用户把含代码内容的日志贴到 issue 里泄漏。

`logRuntimeError` 是全类错误的统一出口，8 处调用（grep 实数，全部列出）：

- `bridge-handler.ts:49`：`log: (message, error) => this.logRuntimeError(message, error),`（递给 KimiRuntime 的 log）；

- `bridge-handler.ts:71`：``this.logRuntimeError(`Bridge request rejected: ${validation.method}`, validation.error);``

- `bridge-handler.ts:82`：``this.logRuntimeError(`Bridge request failed: ${msg.method}`, error);``

- `bridge-handler.ts:165`：`logError: (message, error) => this.logRuntimeError(message, error),`（context 的 logError 字段）；

- `bridge-handler.ts:188`：`this.logRuntimeError("Unable to close a rejected session", error);`

- `bridge-handler.ts:258/:270/:288`：`this.logRuntimeError("Unable to capture a file baseline", ...)` 三处（captureFileBaseline 的三道门与后台失败）。

`errorDetail`（`bridge-handler.ts:319-327`）负责把 unknown 形态的错误压成一行字符串：Error 取 `name: message`，原始类型 String()，对象给 "Unknown error"。

## 十三、设计复盘

1. **构造注入＋闭包接线，让三个大类互相不认识。** KimiRuntime 不 import BaselineManager，FileManager 不 import KimiRuntime，它们的协作全靠构造函数递进来的函数引用（broadcast、captureBaseline、log）。反例：若 KimiRuntime 直接 import 并调用 BaselineManager，引擎包装层就背上插件 UI 层的依赖，脱离 VS Code 单测它（test/kimi-runtime.test.ts 29 个测试）得先 mock 整个 BaselineManager。

2. **每个 RPC 请求现拼 context，而不是共享一个可变 context。** `createContext` 在 `dispatch` 里每个 RPC 请求调一次，webviewId 被闭包捕获。反例：若 context 是构造时建好的共享对象、webviewId 是它的可变字段，两个并发 RPC 请求（A 视图的请求把 webviewId 改成 A 的同时 B 的 handler 正在读）会串会话——闭包捕获天然免疫这个竞态。

3. **查表分发，方法名不进本类。** 反例：写成 `switch (method) { case "streamChat": ... }`，47 个 case 挤在一个函数里，加方法改本类、协议表和实现两处漂移的风险都来了。

4. **"关"分四个粒度，语义不混。** `dispose`（插件没了，全关）、`disposeView`（视图没了，拆绑定＋清视图级表）、`closeSession` context 闭包（用户要新会话，只拆绑定不删数据）、`setCustomWorkDir` 尾部（换目录＝换会话）。反例：若只有 dispose 一个粒度，关一个面板就得关整个插件；若 closeSession 顺手删会话数据，"新会话"按钮会吃掉用户的历史记录。

5. **校验失败也回包、错误兜底在 handle 一层做完。** 反例：若 handler 的异常各自 try/catch 回包，47 个 handler 要写 47 遍相同样板；漏一处，webview 侧就挂一个 10 分钟才超时的 Promise。

## 下一步

- `runtime` 字段背后的类：[03-KimiRuntime方法详解.md](03-KimiRuntime方法详解.md)（双表多对多、openSession 三分支、审批标志三级恢复链）。

- `baselineManager` 字段背后的类：[04-BaselineManager方法详解.md](04-BaselineManager方法详解.md)（同步抢读时序、内容寻址存储、三态判定）。

- broadcast 这根线怎么从本类构造函数出发穿四层：同目录 [dive-chain-broadcast链条详解.md](dive-chain-broadcast链条详解.md)。

- 高层视图与完整 RPC 协议：[01-webview与Bridge通信.md](01-webview与Bridge通信.md) 第二、三节。
