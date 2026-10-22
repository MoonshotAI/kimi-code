# ICronDeleteTool（cronDeleteTool）

- v2: `packages/agent-core-v2/src/features/cron/tools/cron-delete/cron-delete.ts`（接口约 14 行；实现 `cronDeleteTool.ts` 约 60 行，读 interface 与实现得出）
- 新架构: `packages/harness-core/src/features/cron/tools/cron-delete.ts`

## 能力对照

- [x] 参数 schema（单个 cron 任务 id）与描述文档 → `packages/harness-core/src/features/cron/tools/cron-delete.ts` 与 `cron-delete.md`（仅 ULID→UUID 措辞差异）
- [x] 仅主 agent 可删（CRON_MAIN_AGENT_ONLY 文案一致）→ 同文件 `execute` 的主 agent 判定
- [x] id 格式校验（v2 ULID 正则 → 新栈 UUID 正则，报错文案同步改为 "must be a UUID"）→ 同文件 `ID_PATTERN`
- [x] 删除不存在时报 `No cron job with id …`、成功报 `Deleted cron job …`（文案逐字一致）→ 同文件

备注：v2 删除成功后的 `cron_deleted` 埋点未随迁，归属 telemetry 域记录在案未迁（不计入本工具对齐判定）。

## 结论

全部对齐：删除语义、门控与全部用户可见文案逐字迁移，id 格式随服务层改为 UUID。
