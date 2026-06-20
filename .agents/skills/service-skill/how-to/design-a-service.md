# 如何设计一个业务 Service

本流程**不读现有代码**，输入是业务语义。

## 1. 建立业务事实

写下与代码无关的事实：

- **实体**：业务里出现的名词（Workspace、Session、User、Order 等）。
- **用户交互**：用户在产品中实际做什么（创建、列出、归档、查看状态、搜索、关联）。
- **一致性边界**：哪些字段必须同时修改才能保持业务有效？这些字段构成一个 aggregate。
- **可见性与归档语义**：删除是“看不到”还是“真的没有”？是否要恢复？
- **持久化 vs 派生 vs 运行时**：哪些信息必须保存？哪些可以由保存内容推导？哪些只在进程内活着？
- **外部约束**：并发要求、数据量级、查询模式（按谁过滤、按谁排序、是否跨 scope）。

不要：

- 不要参考“现在有什么 Service”。
- 不要参考“现在 route 里写了什么”。
- 不要参考“现在 DI 怎么布的”。

## 2. 找 aggregate

把实体拆成 aggregate。每个 aggregate 只回答一个问题：**它自己的一致性边界是什么？**

提示：

- 如果两个实体的字段从不同时修改，它们多半是不同 aggregate。
- 如果一个字段是另一字段的派生（如 `workspace_id` 由 `workDir` 派生），它是派生字段，不是独立 aggregate。
- 运行时投影（如 status、active turn）通常不是 aggregate 的持久化部分。

## 3. 拆 Command / Query / Runtime

为每类能力找归属：

| 能力 | 归属 | 模板 |
|---|---|---|
| create / update / archive / fork | Command Service | [`reference/patterns/command-service.md`](../reference/patterns/command-service.md) |
| list / search / count / children | Query Service | [`reference/patterns/query-service.md`](../reference/patterns/query-service.md) |
| status / active turn / approval | Runtime Service | [`reference/patterns/runtime-service.md`](../reference/patterns/runtime-service.md) |
| 单条持久化读写 / 列表读模型 | Repository / Index | [`reference/patterns/repository-and-index.md`](../reference/patterns/repository-and-index.md) |

判定规则：

- 改不改 aggregate 状态？改 → Command。
- 读 aggregate 之外的派生 / 列表 / 计数？→ Query。
- 是进程内 / 事件流推导的活状态？→ Runtime。

## 4. 定义接口

每个 Service 至少写清：

```ts
interface IXxxService {
  // 一句话职责通过方法体现
  command(input: XxxCommand): Promise<Xxx>;
  query(query: XxxQuery): Promise<PageResponse<XxxSummary>>;
}
```

接口旁说明：

- **拥有**：哪些字段 / 操作 / 不变量归它。
- **不拥有**：哪些容易误归它的能力**不**归它。
- **依赖**：依赖哪些更下层的 Service / Repository / Index。
- **关键约束**：业务规则、命名规约、不允许的行为。

## 5. 用交互验证

把第 1 步列出的“用户交互”逐条映射到方法：

```text
从 scope A 创建 → CommandService.create({ scopeA })
全局列表       → QueryService.list({ scope: global })
scope 下列表    → QueryService.list({ scope: ... })
查看运行状态    → RuntimeService.getStatus(id)
```

诊断：

- 某个交互找不到对应方法 → 接口缺口，回到第 3 步补。
- 某个方法对应不上任何交互 → 过度设计，回到第 4 步删。

## 6. 写决策记录

对非显然的选择各写一条 DR：

- 删除语义（archive vs purge）。
- 派生字段 vs 真相字段。
- 跨 aggregate 是否级联，如何级联。
- 查询 scope 的设计。
- runtime 与列表的分离边界。

这些 DR 是日后审视设计是否仍然适用的依据。

## 7. 决定是否归档

只有用户确认设计定稿、或明确要求保存时，才进入 [`how-to/archive-service-design.md`](archive-service-design.md)。草稿、未完成的比较方案、未决问题不进入 reference。
