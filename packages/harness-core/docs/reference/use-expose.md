# useExpose

Reference：子节点要把契约挂到父节点上供宿主 `resolve` 和兄弟 `useInject` 时使用 `useExpose`。向下提供给后代仍用 [provide](provide.md)。

## 使用场景

- Feature slot 把 face 发布到 App/Session/Agent 产品节点。
- 任何需要「孩子拥有状态、共同祖先持有 token」的向外发布。
- 不适合父节点在挂孩子之前向下提供服务；那种情况用 `provide`。

## 调用契约

```ts
useExpose<T>(token: FacadeToken<T>, value: T): void
```

- 必须在同步 setup 中调用。
- 只接受 `createFacadeToken` 创建的 facade token；传入 certain token 抛错。
- 有父节点时登记在父节点，并把撤销绑到当前节点清理栈；当前节点卸载后父节点不再持有该条目。
- 没有父节点时等价于 [provide](provide.md)（登记在自身）。
- `useInject`、`handle.resolve` 与 `node.resolve` 的查找规则不变：自身再祖先，不看兄弟和后代。

## 边界

- 不改变 `provide`：父给子仍登记在当前节点。
- 撤销只去掉提供条目，不关闭 `value` 本身。
- `useInject` 的 facade ref 会随后的 expose / 撤销自动更新——这正是 facade 到场 / 缺席的语义；certain token 的解析快照不重新绑定，可变状态放在提供值内部。

源码：见 [代码定位](source-map.md)，`packages/agent-core/src/kernel/hooks.ts` 的 `useExpose`。
