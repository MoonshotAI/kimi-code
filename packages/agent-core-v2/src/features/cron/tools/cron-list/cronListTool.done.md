# ICronListTool（cronListTool）

- v2: `packages/agent-core-v2/src/features/cron/tools/cron-list/cron-list.ts`（接口约 10 行；实现 `cronListTool.ts` 约 100 行，读 interface 与实现得出）
- 新架构: `packages/harness-core/src/features/cron/tools/cron-list.ts`

## 能力对照

- [x] 空参数列表，仅主 agent 可用（门控文案一致）→ `packages/harness-core/src/features/cron/tools/cron-list.ts`
- [x] 列表输出：`cron_jobs: N` 头 + 逐任务记录（id/cron/humanSchedule/prompt/nextFireAt/recurring/ageDays/stale），空列表报 `No cron jobs scheduled.` → 同文件 `renderRecord`（字段、顺序与格式逐字一致）
- [x] prompt 预览 200 字节截断（UTF-8 边界安全）→ 同文件 `previewPrompt`（算法逐字迁移）
- [x] humanSchedule/nextFireAt 解析失败时回退原表达式与 `null` → 同文件 try/catch 分支
- [x] 工具描述文档 → `packages/harness-core/src/features/cron/tools/cron-list.md`（与 v2 仅 ULID→UUID 一处差异）

## 结论

全部对齐：列表渲染逻辑与输出格式逐字迁移，无任何用户可见差异（id 措辞随服务层改为 UUID）。
