# Service 设计原则

本 skill 的所有讨论从**业务和数据模型本质**出发，不读现有代码、不引用现有 Service 名字、不依赖现有目录结构。当前实现只是众多可能落点之一；设计的对象是概念，不是文件。

## 为什么从第一性原理开始

Service 不是函数集合，而是业务边界的显式表达。设计 Service 前先回答：

- 业务里的实体 / aggregate 是什么？
- 谁拥有这个 aggregate 的生命周期？
- 哪些操作改变状态，哪些只是读取？
- 哪些数据是持久化真相，哪些是派生索引，哪些是运行时投影？
- 哪些标识必须在 Service 层解析？

只有这些问题在概念层得到回答，接口才能稳定。

## 思考风格

- **结论先行。** 先说目标形态，再展开细节。
- **一个 aggregate 一个 owner。** 不把同一个 aggregate 的生命周期切给多个 Service。
- **命令 / 查询 / 运行时三类分开。** 一个 Service 不应同时承担三类职责。
- **统一查询。** 多个 scope 下的 list 是同一个查询的不同入参，不是多份实现。
- **标识解析在 Service 层。** 业务标识（如 workspace_id → workDir）由 Service 解析，transport 层只做参数映射。
- **真相、索引、运行时分开。** 持久化真相（repository）、查询读模型（index）、活状态（runtime projection）不能混合存储。
- **删除语义必须显式。** 区分 archive、restore、purge。
- **依赖向下。** Application Service → Repository / Index → Infrastructure。下层不依赖上层，应用层之间不循环依赖。
- **避免隐式级联。** 跨 aggregate 的删除或状态变更必须显式命名，不能藏在普通 delete 里。

## Command / Query / Runtime 分离

| 类型 | 关注 | 不应承担 |
|---|---|---|
| Command Service | create / update / archive / restore / purge / fork 等生命周期 | 复杂 list、search、count |
| Query Service | list / search / filter / count | 修改 aggregate 状态 |
| Runtime Service | status / active turn / approval 等活状态 | 持久化元数据查询 |
| Repository / Index | 持久化与读模型 | 业务编排 |

关键含义：

- 普通 list 不触发 resume agent、扫描全部 record、或读取每个 runtime 状态。
- 状态增强只对“当前页”或“用户明确打开的对象”生效。
- list 返回的是 Summary（轻量字段子集），不是 aggregate 全貌。

## 统一查询，而不是重复入口

一个业务既需要“全局 list”，也需要“某 scope 下 list”时，**只有一个 query**：

```ts
list({ scope: { kind: "global" } });
list({ scope: { kind: "parent"; id } });
list({ scope: { kind: "children"; parentId } });
```

便捷方法（listByX、listGlobal、listChildren）只能是 `list()` 的一行薄封装。过滤、排序、分页、归档可见性逻辑只能有一份实现。

## 标识解析放在 Service 层

业务标识由 Service 解析和校验，不让 transport（REST、WebSocket、CLI、TUI）承载业务规则：

```text
workspace_id  → workDir
repo_id       → workspace roots
parent_id     → children scope
```

这样所有调用方共享同一套业务规则。

## 删除语义

不要用同一个 `delete()` 隐藏多种语义。默认拆分为：

- `archive`：默认删除，可恢复，默认列表不可见。
- `restore`：取消归档。
- `purge`：硬删除，需要显式策略处理运行中对象、关联数据、回收资源。

跨 aggregate 的删除必须命名（如 `purgeWorkspace(id, { deleteSessions: true })`），不能藏在 `delete(id)` 里。

## 依赖方向

```text
Application Service
  ↓
Domain / Repository / Index
  ↓
Infrastructure
```

Application Service 之间不互相依赖业务编排能力。如果两个 Service 都需要同一份计数或索引，把它下沉到 Repository / Index，而不是让一个 Application Service 调用另一个。

## Red Flags

遇到以下情况停下来重做设计：

- 业务规则落在 route / transport 层。
- 两个 Service 实现了相同的 list 逻辑。
- 一个超大 Service 同时承担 CRUD、list / search / count、runtime status。
- list API 触发昂贵的运行时加载（resume agent、扫描全部 record）。
- delete 操作隐藏跨 aggregate 级联。
- 同一份过滤 / 排序 / 归档可见性逻辑在 API、Service、Store 层各写一遍。
- 两个 Application Service 互相调用对方的业务方法。
- aggregate 的真相字段（如 workDir）和派生字段（如 workspace_id）边界不清。
