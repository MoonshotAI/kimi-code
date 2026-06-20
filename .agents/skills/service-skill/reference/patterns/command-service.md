# Command Service Pattern

## 适用场景

某个业务 aggregate 的**生命周期**和**状态变更**需要一个稳定的 owner。Command Service 是该 aggregate 的唯一写入入口。

## 拥有

- aggregate 的 create / get / update。
- 显式的删除语义：archive / restore / purge。
- 派生构造操作：fork / clone / createChild 等。
- 执行命令所需的业务标识解析（例如把外部 id 解析为内部真相字段）。
- 命令发出的领域事件。

## 不拥有

- list / search / count / filter（→ Query Service）。
- 运行时活状态（→ Runtime Service）。
- 单条持久化读写细节（→ Repository）。
- transport 层的参数映射、序列化、错误码翻译。

## 通用接口骨架

```ts
interface ICommandService<Aggregate, Create, Update, Fork = unknown, Child = unknown> {
  create(input: Create): Promise<Aggregate>;
  get(id: string): Promise<Aggregate>;
  update(id: string, input: Update): Promise<Aggregate>;

  archive(id: string): Promise<{ archived: true }>;
  restore(id: string): Promise<Aggregate>;
  purge(id: string): Promise<{ deleted: true }>;

  // 派生构造（按 domain 选择性提供）
  fork?(id: string, input: Fork): Promise<Aggregate>;
  createChild?(id: string, input: Child): Promise<Aggregate>;

  // 最近打开 / lastOpenedAt 等浅状态
  touch?(id: string): Promise<void>;
}
```

## 决策点

- **create 输入是否多形态？** 例如同时接受“通过 scope id 创建”和“通过原始路径创建”——用 union 类型表达，校验同时传入时的一致性。
- **删除是单操作还是拆分？** 默认拆 archive / restore / purge。如果业务上确实无可恢复语义，至少把 purge 命名清楚，不要叫 delete。
- **是否有派生构造？** fork、clone、createChild 等命名应反映业务语义，而不是统一叫 create。
- **跨 aggregate 的级联存在吗？** 存在则必须命名为高阶命令（如 `purgeWorkspace(id, { deleteSessions: true })`），不能藏在 archive / purge 里。
- **命令产生事件吗？** 列出生命周期事件，作为 Query Service / Runtime Service / 外部订阅者更新读模型和投影的触发点。
