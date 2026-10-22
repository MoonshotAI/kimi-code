# IHostEnvironment（hostEnvironment）

- v2: `packages/agent-core-v2/src/os/interface/hostEnvironment.ts`（约 26 行，读 interface 得出）
- 新架构: `packages/harness-core/src/features/os/host/types.ts`（OsEnvironmentPort）

## 能力对照

- [x] 操作系统信息（osKind / osArch / osVersion）→ `packages/harness-core/src/features/os/host/types.ts` 的 OsEnvironmentPort 同名字段
- [x] shell 信息（shellName / shellPath / pathClass）→ 同上，类型复用 execEnv/environmentProbe 的 ShellName/PathClass
- [x] homeDir 与就绪等待（homeDir / ready）→ 同上同字段
- [x] Node 实现与宿主注入 → `packages/harness-core/src/features/os/host/node.ts` 的 createNodeOsHost（组装 process/fs/environment 三端口），经 `packages/harness-core/src/features/os/feature.ts` 的 props.host 注入（缺省 createNodeOsHost()）

## 结论

全部对齐：环境探测端口逐字段平移至 os feature 的 OsEnvironmentPort，DI 服务改为宿主注入的 OsHost 三分口之一。
