# Repository and Index Pattern

## 适用场景

某个 aggregate 同时需要：

- 单条按 id 的真相读写；
- 多 scope 下的列表 / 搜索 / 计数。

Repository 是真相；Index 是读模型。两者分开，避免每次 list 扫描真相、避免 list 路径承担排序 / 过滤 / 分页的复杂度。

## Repository 拥有

- 单条 aggregate 的 create / get / update。
- archive / restore / hard delete 的持久化原子操作。
- aggregate 的真相字段约束（例如哪些字段一旦写入不可变）。

## Repository 不拥有

- 列表查询、计数、搜索。
- 业务编排（→ Command Service）。
- 跨 aggregate 的事务。

## Index 拥有

- 列表读模型（Summary）的 upsert / remove。
- list / count / scoped list / search。
- 排序、分页、过滤、归档可见性。

## Index 不拥有

- aggregate 真相写入。
- 运行时活状态。
- 业务标识解析（→ Command Service / Query Service）。

## 通用接口骨架

```ts
interface IRepository<Stored, Create, Update> {
  create(input: Create): Promise<Stored>;
  get(id: string): Promise<Stored | null>;
  update(id: string, input: Update): Promise<Stored>;
  archive(id: string): Promise<void>;
  restore(id: string): Promise<void>;
  delete(id: string): Promise<void>;
}

interface IIndex<Summary, Query> {
  upsert(stored: Stored): Promise<void>;
  remove(id: string): Promise<void>;

  list(query: Query): Promise<PageResponse<Summary>>;
  count(query: Query): Promise<number>;
}
```

## 决策点

- **Summary 字段集。** Index 存 Summary 子集，不存完整 aggregate；显式列出字段，包括为 scope 查询冗余存储的派生字段（如 `workspaceId`、`parentSessionId`）。
- **写入唯一来源。** Repository 写入后由谁触发 `Index.upsert`？通常是 Command Service。不允许 transport 层直接写 Index。
- **一致性模型。** Repository 和 Index 是强一致还是最终一致？写清楚，避免 Command 完成后 list 看不到的歧义。
- **归档语义在哪一层。** archive 改 Repository 的字段，由 Command Service 触发 `Index.upsert` 把 `archived: true` 同步过去；Index 通过 query 字段控制可见性，不删除条目。
- **purge 的处理。** purge 同时清 Repository 和 Index；如果存在运行时关联资源，purge 之前必须由 Command Service 显式处理。
