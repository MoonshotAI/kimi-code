# 如何归档定稿的 Service 设计

只有用户确认设计定稿或明确要求保存时，才归档到本 skill。草稿、候选、未决问题一律不进入 `reference/`。

## 1. 选择 Diátaxis 位置

| 内容 | 位置 |
|---|---|
| 单个 Service 的职责、接口、依赖、约束（属于某个具体 domain） | `reference/domains/<domain>/<service-name>.md` |
| 该 domain 共享的类型契约 | `reference/domains/<domain>/types.md` |
| 通用、可被多个 domain 复用的 Service 模式（Command / Query / Runtime / Repository / Index 等） | `reference/patterns/<pattern-name>.md` |
| 该 domain 的跨 Service 架构叙述、决策记录 | `explanation/domains/<domain>.md` |
| 通用设计原则、思考风格、Red Flags | `explanation/service-design-principles.md` |
| 如何完成某类设计 / 审视 / 归档任务 | `how-to/<task>.md` |
| 端到端、从业务需求推导到 Service 拆分的演练 | `tutorial/<example>.md` |

判定要点：

- 这是“一类模式”还是“一个领域的 Service”？模式进 `patterns/`，领域进 `domains/`。
- 不要在 `patterns/` 里出现某个具体 domain 的实体名。
- 不要在 `domains/<domain>/` 里复述通用原则——链回 `explanation/service-design-principles.md`。

## 2. 写每个 domain Service reference

每个 `reference/domains/<domain>/<service-name>.md` 至少包含：

```text
# <Service Name>

## 职责
## 拥有
## 不拥有
## 接口
## 依赖
## 关键约束
## 决策记录
```

要求：

- 接口用 TypeScript-like pseudocode。
- 该 Service 独有的输入 / 输出类型（如 `XxxCreate`、`XxxUpdate`）就近内联在接口下方；跨 Service 共享的类型（如 `XxxStatus`、`PageResponse`、`XxxListQuery`）放在 `types.md` 并链接。
- 决策记录是非显然选择的依据；如果没有任何非显然选择，写一句话说明“无非显然选择”。

## 3. 写 domain 叙述

`explanation/domains/<domain>.md` 顺序建议：

```text
## 结论
## 第一性原理
## Service 拆分概览（一句话职责 + 链到 reference）
## 跨 Service 模型（如统一查询模型）
## 关键场景
## 派生交互映射
## 依赖方向与边界
## 决策记录
```

不写：

- “当前事实与问题”——这是讨论时的临时上下文，不是定稿内容。
- “最小演进路径 / 迁移步骤”——迁移属于 `plan-lifecycle__*`，不是设计归档。
- 任何具体代码层 Service 的名字、文件路径、目录布局。

## 4. 写 pattern

`reference/patterns/<pattern-name>.md` 顺序建议：

```text
# <Pattern Name>

## 适用场景
## 拥有
## 不拥有
## 通用接口骨架（generic pseudocode）
## 决策点
```

pattern 不绑定 domain：不出现 Session、Workspace、Order 等具体业务实体名字，用 `Aggregate` / `Summary` / `Query` 等占位。

## 5. 更新 SKILL.md 索引

每次新增 / 删除 / 替代 reference 或 explanation 文件，同步更新 `SKILL.md` 的 `## Skill Map`。索引就是入口，链接断了等于该文件不存在。

## 6. 不归档草稿

不归档：

- 用户未确认的方案；
- 仍在比较的多个候选；
- 只有待办没有结论的内容；
- 与已有定稿冲突但没有 decision record 的内容；
- 代码视角的“当前状态”说明。

## 7. 替代旧定稿

如果新定稿替代旧定稿：

- 更新原文件而不是新建并行版本；
- 在被替代文件的 `## 决策记录` 末尾补一条 DR，说明何时被替代、被谁替代、为什么；
- 不保留两份互相冲突的“定稿”。
