# ITelemetryService（agentTelemetryService）

- v2: `packages/agent-core-v2/src/app/telemetry/telemetry.ts`（约 71 行 interface）
- 新架构: `packages/harness-core/src/features/telemetry/`

## 能力对照

- [x] track（事件上报）→ `packages/harness-core/src/features/telemetry/feature.ts` 的 TelemetryFace.track
- [x] withContext/setContext/getContext（分级上下文继承）→ feature.ts 的 app/session/agent 三级 bindTelemetryView + telemetry.ts 的 applyTelemetryPatch
- [x] addAppender/removeAppender（appender 注册）→ feature.ts 的 TelemetryAppenders collection + useTelemetryAppender
- [x] setEnabled/flush/shutdown → TelemetryFace 同名方法 + telemetry 配置 section 与 KIMI_DISABLE_TELEMETRY env 绑定
- [x] track2 类型化事件（事件名-载荷契约）→ `packages/harness-core/src/features/telemetry/events.ts` 的 TelemetryEvents collection + events() 列举
- [ ] 云端上报（cloudAppender/cloudTransport 批量传输 + privacy 属性清洗）— 未迁：新栈 telemetry 不出进程，无云 appender 与传输层
- [ ] 各域遥测事件埋点（v2 events.ts 的全域事件目录与各域调用点）— 记录在案未迁：新栈仅有机器派生事件（derive.ts 的 machineTelemetryEvents）

## 结论

未对齐 2 项——总线/上下文/appender 机制已对齐；云端传输与各域埋点未迁。
