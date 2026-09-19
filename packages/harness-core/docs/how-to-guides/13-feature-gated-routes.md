# 13. 按已注册 Feature 挂卸载路由

How-to：Http Feature 观察祖先提供的 `Features` 名单，用 `useChildren` 按 `featureName` 挂上或卸掉自己拥有的路由孩子。

## 选择边界

适用于「路由归 Http 所有，只按别的 Feature 在不在名单里开关」。`createHttpServer()` / `server.route()` / `server.close()` 由调用方提供，不是 kernel API。

路由其实属于那个 Feature 时，走下面的「对方贡献路由」：collection 沿祖先路径折叠，兄弟 slot 上的 `useContribute` 对 Http 不可见。

```text
App：useFeatureSlot → provide(Features) → 挂各 Feature slot
├── todo:app
└── http:app
    └── inject(Features)；名单有 todo 时挂 Route 孩子
```

## 实现

`TodoStatusRoute` 是预先定义、identity 稳定的配方。`Features` 是 `MaybeRefOrGetter<readonly FeatureSpec[]>`，在 source 里用 `toValue` 读。

```ts
const HttpRef = createToken<HttpServer>('http');

const TodoStatusRoute = createUnit('http.route.todo', () => {
  const http = inject(HttpRef);
  pushCleanup(useNode(), http.route('GET', '/todo', handleTodoStatus));
});

export const http = createFeature('http', {
  app() {
    const features = inject(Features);
    const server = createHttpServer();
    provide(HttpRef, server);

    useChildren(() => {
      const names = new Set(toValue(features).map((feature) => feature.featureName));
      return names.has('todo')
        ? [{ key: 'todo-status', recipe: TodoStatusRoute }]
        : [];
    });

    pushCleanup(useNode(), () => server.close());
  },
});
```

1. 同步 setup 里 `inject(Features)` 一次；`useFeatureSlot` 已把名单提供在产品节点上。
2. `useChildren` 只注册一次，用 getter 读名单；`installFeature` / `uninstallFeature` 改的就是这份 computed。
3. 路由登记写在孩子 setup，撤销压进孩子；关端口压进 Http 自己。
4. `watch` 回调里使用 setup 捕获的句柄（hooks 只在同步 setup 段有效）。

## 边界

- 名单有 `todo` 只表示 FeatureSpec 已登记，不保证它的 slot 已经 `useExpose`。同一轮产品节点 `useChildren` 里 Http 若排在 Todo 前面，孩子里 `inject(TodoRef)` 会抛 `no provider`。
- App slot 只看 App 的 `Features`（`props.features` + `installFeature`）。只在 `session.create({ features })` / `agent.create({ features })` 里加的 Feature，要在对应 tier 的 slot 里观察。
- [useContribute](../reference/use-contribute.md) 写在当前节点；兄弟折叠不到。要让 Http 收别人的路由，贡献到共同祖先，并把 withdraw 绑到贡献者。

## 对方贡献路由

当路由属于那个 Feature：Http 提供集合并 `useCollection` + `useChildren`；对方像 `useProvider` 那样贡献到 root（共同祖先），Http 这一层才折叠得到。

```ts
const Routes = createCollection<HttpRoute>('http.routes');

export function useHttpRoute(route: HttpRoute, priority = 0): void {
  const node = useNode();
  let root = node;
  while (root.parent !== null) root = root.parent;
  pushCleanup(node, root.contribute(Routes, route, priority));
}

export const http = createFeature('http', {
  app() {
    const server = createHttpServer();
    provide(HttpRef, server);
    const routes = useCollection(Routes);
    useChildren(() => routes.value.map((route) => ({
      key: route.id,
      recipe: RouteUnit,
      props: route,
    })));
    pushCleanup(useNode(), () => server.close());
  },
});
```

现有实例：`builtin/provider-catalog/feature.ts` 的 `useProvider` / `useCollection(Providers)`。

验收：`installFeature` 写入名单后，观察 `Features` 的孩子挂上；`uninstallFeature` 后孩子卸载且 cleanup 已跑。产品 HTTP 用 harness `createHttp`，它自带 `GET /features`：按 app / live session / agent 列出该层已挂 slot 的 Feature。

源码：见 [代码定位](../reference/source-map.md)，`feature/hooks.ts` 的 `useFeatureSlot`，`app/appUnit.ts` 的 `installFeature`，`kernel/hooks.ts` 的 `useChildren` / `useCollection`。
