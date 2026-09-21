# 命名：use 与实例方法

Reference：kernel 与产品面的公开函数按 Vue 惯例命名，不自造 prefix。

## 使用场景

- 新增或重命名依赖当前 Unit 的 API、按 id 查找活实例、工厂与句柄包装。
- 对照 Vue：`useRouter()` 取当前上下文，`router.getRoutes()` 在实例上查找。

## 分层

| 形态 | 含义 | 例子 |
|---|---|---|
| `use*` | composable：取**当前**上下文，必须在同步 setup 或 `asUnit` 里调用 | `useNode`、`useApp`、`useSession`、`useAgent` |
| `inject` / `provide` | Vue 同名原语，不是 composable | `inject(AppUnitRef)` |
| `create*` / `mount*` | 工厂；不依赖当前 Unit | `createUnit`、`mountRoot`、`mountApp` |
| 实例方法 | 在已取得的对象上查找或操作 | `useApp().get(id)`、`session.get(agentId)`、`handle.resolve(token)`、`handle.ready()` |

`useSession()` / `useAgent()` / `useApp()` 只 `inject` 当前节点命令面，缺 provider 时抛错；按 id 查找归实例方法 `get`（见下），hook 保持零参数。

按 id 查活实例：

```ts
const session = useApp().get(sessionId);
if (session === undefined) return;
const agent = session.get(agentId);
```

已有 `app` 时直接 `app.get(id)`：实例已在手，查找不需要再进一次 hook 上下文。

## 每个位置一个名字

- 依赖当前实例的顶层函数一律叫 `use*`；更薄的情况直接 `useX()` 再调方法，不再包一层 `find*` / `ensure*` / `open*`——名字一多，调用方就要猜每一层的语义。
- 「当前」归 `use*` hook，「按 id」归实例方法 `get`：两个维度各有一个名字，不需要 `use*Host` / `useLive*` 这类第三种。
- 已挂载 Unit 的外部句柄叫 `*Handle`，对齐 [UnitHandle](node-handle.md)；包装函数是 `appHandle` / `sessionHandle` / `agentHandle`。
- `use*` 返回命令面（`*Commands`）。`mount*` / `get` 返回 `*Handle`（`UnitHandle` + 命令面）。Feature 用命令面；卸载、`ready`、`state`、`resolve` 走 Handle。绑 generate 用命令面上的 `setConfig` / `setCredentialProvider` / `setRequester`。
- 宿主取 Feature facade 用 `handle.resolve(token)`，与 `inject` 同语义（缺失抛错）。`get(id)` 只表示孩子，可以 miss。
- 宿主订 Feature 事件用 `handle.on(feature, type, handler)`，事件联合是 `createFeature<E>` 的幽灵泛型：订阅点挂在句柄上，配方保持纯数据。
- ensure-open、打开持久化容器挂在已有端口方法上（`SessionSpace`、`app.open`、`openStore`）。

HTTP handler 由 `asUnit` 恢复上下文，await 前完成所有 `use*`；之后用捕获的 `app` / `session` / `agent`。见 [setup 调用边界](setup-context.md)。

源码：见 [代码定位](source-map.md)，`kernel/hooks.ts` 的 `use*` / `inject`；`packages/agent-core/src/app/{app,session,agent}Unit.ts` 与 `feature/contribution-hooks.ts`。
