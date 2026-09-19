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
| 实例方法 | 在已取得的对象上查找或操作，可以 miss | `useApp().get(id)`、`session.get(agentId)`、`handle.ready()` |

`useSession()` / `useAgent()` / `useApp()` 只 `inject` 当前节点命令面，缺 provider 时抛错，不要做成 `useSession(id)` 重载。

按 id 查活实例：

```ts
const session = useApp().get(sessionId);
if (session === undefined) return;
const agent = session.get(agentId);
```

已有 `useApp()` 时用 `app.get(id)`，不要再调一次 `useApp()`。

## 不要自造

- 不要用 `find*` / `ensure*` / `open*` 做内部 `inject` 的顶层函数。依赖当前实例就该叫 `use*`，或不要包一层、直接 `useX()` 再调方法。
- 不要用 `use*Host`、`useLive*` 区分「当前」和「按 id」。按 id 是实例方法，不是另一种 hook。
- 已挂载 Unit 的外部句柄叫 `*Handle`，对齐 [UnitHandle](node-handle.md)；不要叫 `*Host`。包装函数是 `appHandle` / `sessionHandle` / `agentHandle`。
- `use*` 返回命令面（`*Commands`）。`mount*` / `get` 返回 `*Handle`（`UnitHandle` + 命令面）。Feature 用命令面；卸载、`ready`、`state` 走 Handle。
- ensure-open、打开持久化容器挂在已有端口方法上（`SessionSpace`、`useCreateSession`、`openStore`），不新造顶层 hook。

HTTP handler 由 `asUnit` 恢复上下文，await 前完成所有 `use*`；之后用捕获的 `app` / `session` / `agent`。见 [setup 调用边界](setup-context.md)。

源码：见 [代码定位](source-map.md)，`kernel/hooks.ts` 的 `use*` / `inject`；v3 `app/{app,session,agent}Unit.ts` 与 `feature/contribution-hooks.ts`。
