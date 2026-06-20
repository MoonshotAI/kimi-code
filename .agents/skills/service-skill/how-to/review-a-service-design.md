# 如何审视一份 Service 设计

本流程的对象是**设计稿**或**已归档定稿**，不是代码。如果你想 review 的是“当前代码里 Service 边界对不对”，请用 `module-review` skill；本 skill 不读代码。

## 1. 明确输入

确认手里有：

- 一份候选设计（pseudocode 接口 + 职责说明）或一份归档在 `reference/` 的旧定稿；
- 推动 review 的诱因：新增交互、出现冲突、归档已过时、与定稿冲突。

如果只有“感觉哪里不对”而没有可对照的设计文本，先回到 [`how-to/design-a-service.md`](design-a-service.md) 把设计写下来再 review。

## 2. 跑一遍 Red Flags 清单

对照 [`explanation/service-design-principles.md`](../explanation/service-design-principles.md) 的 Red Flags 逐条问：

- [ ] 一个 aggregate 是否只有一个 owner？
- [ ] Command / Query / Runtime 是否被混在同一个 Service 里？
- [ ] 多 scope 下的 list 是否被实现了多份？
- [ ] 业务规则（标识解析、scope 推导）是否漂到 transport 层？
- [ ] 删除语义是否显式拆为 archive / restore / purge？
- [ ] 是否存在隐式的跨 aggregate 级联？
- [ ] 列表是否依赖运行时（resume、scan、状态加载）？
- [ ] 依赖方向是否向下？应用层之间是否有循环？

每命中一条就记为一个 finding。

## 3. 跑一遍 Thinking Style 清单

对照同一篇 `service-design-principles.md` 的“思考风格”逐条问：

- [ ] 文档是否结论先行？
- [ ] 真相 / 索引 / 运行时三类数据是否清晰分开？
- [ ] 派生字段和真相字段是否明确？
- [ ] 是否存在“看起来一样、实际不同语义”的方法名（delete vs purge、list 与 search 等）？

## 4. 用交互验证

按 [`how-to/design-a-service.md`](design-a-service.md) 第 5 步：

- 把所有用户交互重新映射到方法；
- 找“没有方法承接”的交互 → 接口缺口；
- 找“没有交互对应”的方法 → 过度设计；
- 找“一个交互需要多个 Service 协作”的情形 → 检查是否本该收归同一 Service。

## 5. 给出结论

每份 review 必须给出明确结论：

- **保留**：设计仍然成立，记录“本次 review 未发现需要修改”。
- **修订**：需要小幅修改，列出 finding 与对应的修订点。
- **替代**：设计已经不适用，提出替代设计并补 DR 说明替换原因。

不允许的结论：

- “看起来还行” / “大致没问题”——没有对照清单跑过。
- “部分不对但先不改” / “以后再说”——不是 review 结论，是延后。

## 6. 处理与现有归档的冲突

如果本次 review 的结论和 `reference/` 里已归档的内容冲突：

- 不要保留两份互相矛盾的“定稿”；
- 要么更新原文件并补一条 DR 说明变更原因，要么显式标记旧文件为已被替代并在 SKILL.md 索引里指向新文件；
- 决策记录是定稿可信度的来源，不能省。

## 7. 不要做的事

- 不要在 review 过程中读现有代码以判断设计是否“能落地”——落地能力由实现阶段评估。
- 不要把“当前实现的便利性”作为反对一个概念上更正确拆分的理由——那是迁移问题，不是设计问题。
- 不要在 review 报告里塞迁移路径——迁移属于 `plan-lifecycle__*`。
