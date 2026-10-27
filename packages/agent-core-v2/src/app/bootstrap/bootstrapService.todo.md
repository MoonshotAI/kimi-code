# IBootstrapService（bootstrapService）

- v2: `packages/agent-core-v2/src/app/bootstrap/bootstrap.ts`（约 185 行，读 interface 与同文件 bootstrap/storageSeed 得出）
- 新架构: 无对应——集中式启动目录/环境服务归属宿主层，两包内各域自持路径 props

## 能力对照

- [ ] 统一持久化目录布局（homeDir 下 sessions/blobs/store/logs/cache/credentials 与 `scope(name)` 取径）— 归属宿主层；新栈中会话/存储根目录由宿主交给 `packages/harness-core/src/host/session-space.ts`（fsSessionSpace(root)），凭证目录由 oauth feature 以 homeDir 拼 `credentials`（`packages/harness-core/src/features/kimi/oauth/tokens.ts`），无集中目录服务
- [ ] getEnv(name) 统一环境读取（供 config env 绑定等）— 新栈 config feature 以 `env` deps 注入（`packages/harness-core/src/features/config/feature.ts` 的 createConfig({ env })），其余处直接读 process.env，归属宿主层
- [ ] configKey / clientIdentity / args 透传 — 归属宿主层；无等价集中服务
- [ ] 启动期种子装配（bootstrap() 组 App scope、注册 FileStorageService/FileSkillDiscovery 种子）— 结构取消：新栈为 createApp + 宿主自择 feature 挂载（`packages/harness-core/src/app/app.ts`、`packages/harness-core/src/preset.ts`），文件持久由 host/session-space 与 config persist 承担

## 结论

未对齐——目录布局、环境读取与启动装配均归属宿主层未迁；两包内仅以 props/host 端口形式存在分散承载。
