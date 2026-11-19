# scenarios Agent 指南

本文件补充根目录的 `AGENTS.md`，只管 `tests/scenarios`。

这里是协议层的场景测试：在进程内启动真实的 kap-server 和引擎，只通过 KAP（REST + WebSocket）驱动，模型由 testkit 的假模型扮演。testkit 的用法见 `packages/testkit/README.md`。

- 只能从 `@moonshot-ai/kap-server` 的包入口、`@moonshot-ai/testkit/*`、`vitest`、`node:*` 和 `./support/*` 导入，不能碰引擎内部；`boundaries.test.ts` 检查这一点。
- 每个测试文件自己写 `const test = base.extend<ScenarioFixtures>(scenarioFixtures(...))`：仓库的 `vitest/no-standalone-expect` 规则只认同一个文件里由 vitest 的 `test` 派生的 `extend`。
- `support/setup.ts` 给每个测试装了网络守卫，访问回环地址以外的网络会让测试失败。
- `scenarioFixtures()` 默认 `yolo` 权限模式；要测审批就在 `prompt` 时传 `permissionMode: 'manual'`。
- 断言写在用户能看到的那一层：REST 和 WebSocket 返回的回合、条目、交互，以及模型收到的请求。
