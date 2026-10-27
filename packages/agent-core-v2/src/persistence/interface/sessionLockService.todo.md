# ISessionLockService（sessionLockService）

- v2: `packages/agent-core-v2/src/persistence/interface/sessionLock.ts`（约 136 行，读 interface 与 SessionLockHolds 得出）
- 新架构: `packages/agent-core/src/store/backend/node.ts`（journal writer.lock）

## 能力对照

- [x] 跨进程单写者占用（v2 publish/unpublish 锁文件防双开）→ `packages/agent-core/src/store/backend/node.ts` 的 acquireLock：writer.lock pid 文件 + 活进程探测，冲突抛 JournalLockedError(dir, pid)；复制会话时由 `packages/harness-core/src/host/session-space.ts` 清除锁文件
- [x] 进程内重复打开防护 → 结构取代：`packages/agent-core/src/session/session.ts` 的 liveAgents 映射使 live agent 的 open 幂等，无需显式 hold
- [ ] 持有者元信息（SessionLockHolder：version/token/pid/hostname/startedAt/clientIdentity）与 SESSION_OCCUPIED 用户态文案（sessionOccupiedError）— 新栈 JournalLockedError 仅携带 dir 与 pid，元信息与用户文案在两个包内无承载，降级
- [ ] 租约语义与事件（lease 引用计数释放、onDidHold、held 查询）— 无对应机制，未迁

## 结论

未对齐 2 项：会话级跨进程互斥已由 journal writer.lock 承载；锁持有者元信息/用户态占用文案与租约事件机制未迁（harness 侧尚无 occupied 错误面）。
