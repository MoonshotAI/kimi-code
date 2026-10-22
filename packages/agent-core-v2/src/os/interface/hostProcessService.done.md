# IHostProcessService（hostProcessService）

- v2: `packages/agent-core-v2/src/os/interface/hostProcess.ts`（约 85 行，读 interface 与错误域得出）
- 新架构: `packages/harness-core/src/features/os/host/types.ts`（OsProcessPort）

## 能力对照

- [x] 进程派生（spawn：command/args + cwd/env/shell/windowsHide/mergeStderr）→ `packages/harness-core/src/features/os/host/types.ts` 的 OsProcessPort.spawn（OsSpawnOptions 同名项，另增 windowsVerbatimArguments）
- [x] 进程句柄（pid/exitCode/stdin 写/stdout/stderr 读/wait/dispose）→ types.ts 的 OsProcess（流改为 AsyncIterable<Uint8Array>，另增 external 终端句柄标识）
- [x] 终止进程（kill）→ OsProcess.kill；信号面收窄为 SIGTERM/SIGKILL，产品面（shell 命令终止）无损失
- [x] 超时与分离运行（v2 的 timeout/detached 选项）→ 上移至调用层：`packages/harness-core/src/features/os/process-exec.ts` 用 AbortSignal/计时管控；detached 由 `packages/harness-core/src/features/os/host/node.ts` 实现内部按平台设定
- [x] 进程错误域（spawn_failed/kill_failed/git_bash_not_found）→ types.ts 的 OsProcessError（同三错误码）

## 结论

全部对齐：进程端口平移至 os feature 的 OsProcessPort；timeout/detached 从端口选项上移到 exec 层与 node 实现内部，属结构取代。
