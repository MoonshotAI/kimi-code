# IBootstrapOptions（bootstrapOptions）

- v2: `packages/agent-core-v2/src/app/bootstrap/bootstrap.ts`（约 185 行，读 interface 与同文件 resolveBootstrapOptions 得出）
- 新架构: 无对应——进程级启动参数袋归属宿主层（CLI 等），两包内不设统一 options 服务

## 能力对照

- [ ] homeDir 解析（KIMI_CODE_HOME env → ~/.kimi-code）与 configPath 推导 — 归属宿主层，见 `apps/kimi-code/src/cli/telemetry.ts`（resolveKimiHome）与 `apps/kimi-code/src/constant/app.ts`（KIMI_CODE_HOME_ENV）；新栈各 feature 以 props 接收 homeDir/configPath（如 createOauth/createTomlConfigPersist）
- [ ] platform/arch/cwd/osHomeDir/env 只读快照 — 归属宿主层；新栈由 OsHost 环境（`packages/harness-core/src/features/os/host/index.ts` 的 environment：osKind/osArch/homeDir）与 process 直接读取分别承载，无集中 options 袋
- [ ] clientIdentity（KimiHostIdentity）与 HostArgs（agentFiles/skillDirs/requestHeaders/displayName/replyStyleGuide/nonInteractive/uiCapabilities）— 归属宿主层；新栈以各 feature 的 Create*Props 逐项注入（identity、explicitAgentFiles、extraAgentDirs 等），无统一 HostArgs 结构

## 结论

未对齐——该 options 袋被明确决策为宿主层职责，新栈两包内不存在等价物；各字段改由宿主解析后以 feature props 分别注入。
