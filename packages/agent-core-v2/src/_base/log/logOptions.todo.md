# ILogOptions（logOptions）

- v2: `packages/agent-core-v2/src/_base/log/logConfig.ts`（约 72 行，读 interface 与 resolveLoggingConfig 得出）
- 新架构: 无对应

## 能力对照

- [ ] 日志配置注入（level / 全局与会话日志路径 / 滚动大小与份数）— agent-core 与 harness-core 内无日志域，配置无承载，能力缺失
- [ ] 环境变量解析（KIMI_LOG_LEVEL、KIMI_LOG_GLOBAL_MAX_BYTES 等，resolveLoggingConfig）— 无对应；新栈约定「配置解析与环境变量留在宿主」
- [ ] 全局/会话双日志文件路径约定（resolveGlobalLogPath / resolveSessionLogPath）— 无对应
- [ ] 启动期 DI 播种（logSeed 产出 ScopeSeed 注入 App 作用域）— 随 DI 体系废弃，无对应；新栈宿主组装阶段自行持有此类进程级配置

## 结论

未对齐 1 类：随日志域整体不迁，记录在案属宿主层职责；新栈引擎与产品层均不持有日志配置，KIMI_LOG_* 环境变量在两个包内无解析方。
