# ISessionExportService（sessionExportService）

- v2: `packages/agent-core-v2/src/app/sessionExport/sessionExport.ts`（约 64 行 interface）
- 新架构: `packages/harness-core/src/features/sessionExport/`

## 能力对照

- [x] export（session 日志 + manifest + global/desktop/web 日志打 zip，含 abort 信号与默认文件名）→ `packages/harness-core/src/features/sessionExport/service.ts` 的 exportSessionJournal + zip.ts + `packages/harness-core/src/feature-http/route-features/sessionExport.ts` 的 sessions.export 路由
- [x] manifest 全字段（kimiCodeVersion/wireProtocolVersion/os/nodejsVersion/首尾活动/title/workspaceDir/shellEnv/installSource/desktopVersion）→ `packages/harness-core/src/features/sessionExport/manifest.ts` 的 buildExportManifest（ExportSessionManifest 同构）
- [x] 导出前冲刷活动会话（v2 flush metadata/session log/agent wire）→ `packages/harness-core/src/features/sessionExport/feature.ts` 约 45 行导出前 agent.flush()

## 结论

全部对齐——会话导出 zip 与 manifest 由 sessionExport feature 承载，live flush 由导出前的 agent.flush 覆盖。
