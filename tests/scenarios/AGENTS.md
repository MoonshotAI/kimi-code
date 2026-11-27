# scenarios Agent 指南

本文件补充根目录的 `AGENTS.md`，只管 `tests/scenarios`。

这里是协议层的场景测试：在进程内启动真实的 kap-server 和引擎，只通过 KAP（REST + WebSocket）驱动，模型由 testkit 的假模型扮演。testkit 的用法见 `packages/testkit/README.md`。

- 只能从 `@moonshot-ai/kap-server` 的包入口、`@moonshot-ai/testkit/*`、`vitest`、`node:*` 和 `./support/*` 导入，不能碰引擎内部；`boundaries.test.ts` 检查这一点。
- 每个测试文件自己写 `const test = base.extend<ScenarioFixtures>(scenarioFixtures(...))`：仓库的 `vitest/no-standalone-expect` 规则只认同一个文件里由 vitest 的 `test` 派生的 `extend`。
- `support/setup.ts` 给每个测试装了网络守卫，访问回环地址以外的网络会让测试失败。
- `scenarioFixtures()` 默认 `yolo` 权限模式；要测审批就在 `prompt` 时传 `permissionMode: 'manual'`。
- 断言写在用户能看到的那一层：REST 和 WebSocket 返回的回合、条目、交互，以及模型收到的请求。
- `scenarioFixtures()` 打开了 testkit 的 `verifyInvariants`：每个场景通过后，都会检查会话回到空闲、没有残留的 `running` 回合和条目、REST 和 WebSocket 一致、待处理交互的帧顺序不自相矛盾。场景结束前要停掉自己启动的后台命令。检查项见 [KAP 场景指南](../../packages/testkit/docs/kap-scenarios.md#重启清理与失败诊断)。

需要全新进程时，使用 testkit 的 `KapProcess.start({ home })` 启动协议规定的 CLI web JSON 入口，它提供和 `kap` 相同的会话操作。close 等待经认证的正常关闭，crash 强制结束测试进程树。[子进程驱动](../../packages/testkit/src/kap/process.ts)[发布版样本](fixtures/released-2.6.3/README.md)只复制到临时 home 使用。验证已落盘回合的崩溃恢复时，先观察对应的 wire 结束记录；WebSocket 的 turn.ended 可能先到。[冷恢复验证](cold-recovery.test.ts)
