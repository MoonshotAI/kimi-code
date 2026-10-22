# ICronCreateTool（cronCreateTool）

- v2: `packages/agent-core-v2/src/features/cron/tools/cron-create/cron-create.ts`（接口约 41 行；实现 `cronCreateTool.ts` 约 150 行，读 interface 与实现得出）
- 新架构: `packages/harness-core/src/features/cron/tools/cron-create.ts`

## 能力对照

- [x] 参数 schema（cron 5 字段表达式、prompt 1–8KiB、recurring 默认 true），描述文案逐字一致 → `packages/harness-core/src/features/cron/tools/cron-create.ts`（`CronCreateInputSchema` 及 JSON schema 描述）
- [x] 校验链：仅主 agent 可用、cron 未禁用（KIMI_DISABLE_CRON）、表达式可解析、5 年内有点火、每会话 50 任务上限、prompt 8KiB 上限、one-shot 不超过 350 天 → 同文件 `execute`（各项报错文案与 v2 逐字一致）
- [x] 输出格式（id/cron/humanSchedule/recurring/nextFireAt 五行）→ 同文件；任务 id 由 ULID 改为 `crypto.randomUUID()`（工具文档同步改写，见下）
- [x] 工具描述文档 → `packages/harness-core/src/features/cron/tools/cron-create.md`（与 v2 `cron-create.md` 仅 ULID→UUID 一处差异）

备注：v2 创建成功后的 `cron_scheduled` 埋点未随迁，归属 telemetry 域记录在案未迁（不计入本工具对齐判定）。

## 结论

全部对齐：校验规则、报错文案、输出格式与描述文档均逐字迁移，仅任务 id 格式由 ULID 换为 UUID。
