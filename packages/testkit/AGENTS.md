# testkit Agent 指南

本文件补充根目录的 `AGENTS.md`，只管 `packages/testkit`。写测试前先读 [README](README.md)，再按需查阅[假模型](docs/model.md)、[KAP 场景](docs/kap-scenarios.md)或[夹具](docs/fixtures.md)指南。

- 这个包不依赖任何 `@moonshot-ai/*` 包，所有包的测试都能用它；需要产品代码的地方（例如启动服务端的 `startServer`）由调用方传进来。`test/boundaries.test.ts` 检查这一点。
- `src/` 里只用 `#/` 导入，不用相对路径，同样由 `test/boundaries.test.ts` 检查。
- `verify()` 应报告采用 `fail` 策略的通道收到未编排的请求、未用掉的步骤、仍在等待的命名 hold、畸形消息序列和违反请求工具 schema 的调用。`side` 通道默认提供固定回复。放宽检查必须由调用方显式选择，并保留各通道的默认策略。
- 协议编码器先用官方 SDK 验证（`test/protocols.test.ts`），再经由真实引擎验证（`tests/scenarios/providers.test.ts`）。改编码器两边都要跑。
- 工具快捷写法的参数类型照抄引擎工具的 schema；`tests/scenarios/tool-builders.test.ts` 用真实引擎提供的 schema 检查每个参数。引擎改了工具参数，这个测试会失败，同步改 `src/model/tools.ts`。
- 改动代码时核对受影响的用法。公开接口、默认行为、时序、错误或清理方式有变化，就在同一次改动中更新 README 和相关指南里受影响的说明与示例，并用对应测试核对示例。
- `src/fixtures/network-preload.ts` 和它导入的模块会被子进程直接加载，可能没有 tsx，只靠 Node 原生的类型剥离，所以只能用可擦除的 TS 语法（不用参数属性、枚举、装饰器）。`test/fixtures.test.ts` 里的 `TestProcess` 用例不带 tsx 启动子进程，会发现这类问题。
