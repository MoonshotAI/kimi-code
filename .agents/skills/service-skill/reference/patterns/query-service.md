# Query Service Pattern

## 适用场景

同一个 aggregate 需要在多个 scope 下被列出 / 搜索 / 计数（全局、按父对象、按子集、按搜索词），且希望保持**一份查询实现**。

## 拥有

- list / search / count。
- 过滤、排序、分页、归档可见性。
- scope 维度的便捷方法（listByX / listGlobal / listChildren），作为 `list()` 的薄封装。
- 业务标识解析（如把外部 scope id 解析为内部查询参数）。

## 不拥有

- aggregate 的写入与状态变更（→ Command Service）。
- 运行时活状态（→ Runtime Service）。
- 持久化真相（→ Repository）。
- 直接驱动 transport 层的展示逻辑。

## 通用接口骨架

```ts
type QueryScope =
  | { kind: "global" }
  | { kind: "parent"; parentId: string }
  | { kind: "children"; parentId: string }
  /* 按 domain 扩展更多 scope kind */;

interface BaseQuery extends CursorQuery {
  scope?: QueryScope;
  search?: string;
  archived?: "exclude" | "include" | "only";
  orderBy?: string;
  orderDir?: "asc" | "desc";
}

interface IQueryService<Summary, Query extends BaseQuery> {
  list(query: Query): Promise<PageResponse<Summary>>;
  count(query: Query): Promise<number>;

  // 便捷方法：一行薄封装
  listGlobal(query?: Omit<Query, "scope">): Promise<PageResponse<Summary>>;
  listByParent(parentId: string, query?: Omit<Query, "scope">): Promise<PageResponse<Summary>>;
  listChildren(parentId: string, query?: Omit<Query, "scope">): Promise<PageResponse<Summary>>;
}
```

## 决策点

- **统一 query 模型。** 多 scope list 必须共享同一个 `Query` 类型，scope 只是其中一个字段。
- **archived 默认行为。** 默认 `"exclude"`；明确写出来。
- **orderBy 默认。** 默认 `"updatedAt" desc`；其他选项明确列举。
- **Summary 字段集。** list 返回 Summary，不是完整 aggregate；显式定义 Summary 包含哪些字段，剩下的留给 Command Service 的 `get(id)`。
- **不依赖运行时。** 不在 list 路径上 resume 任何长生命周期对象、不扫描运行时状态。状态增强（如显示当前 status）由 Runtime Service 在用户明确请求时按 id 提供，不进入默认 list。
- **search 的语义。** 是前缀匹配、全文匹配，还是 tag 过滤？写清楚，避免与 filter 字段重叠定义。
