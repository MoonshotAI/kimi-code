# testkit Agent 指南

本文件补充根目录的 `AGENTS.md`，只管 `packages/testkit`。用法写在 `packages/testkit/README.md`，写测试之前先读它。

- 这个包不依赖任何 `@moonshot-ai/*` 包，所有包的测试都能用它；需要产品代码的地方（例如启动服务端的 `startServer`）由调用方传进来。`test/boundaries.test.ts` 检查这一点。
- `src/` 里只用 `#/` 导入，不用相对路径，同样由 `test/boundaries.test.ts` 检查。
- 默认严格：没写脚本的请求、没用掉的步骤、没放行的 hold、畸形的消息序列、和请求里工具 schema 对不上的工具调用，都要让 `verify()` 失败。放宽某项检查必须是调用方显式选择的选项，不能改默认值。
- 协议编码器先用官方 SDK 验证（`test/protocols.test.ts`），再经由真实引擎验证（`tests/scenarios/providers.test.ts`）。改编码器两边都要跑。
- 工具快捷写法的参数类型照抄引擎工具的 schema；`tests/scenarios/tool-builders.test.ts` 用真实引擎提供的 schema 检查每个参数。引擎改了工具参数，这个测试会失败，同步改 `src/model/tools.ts`。
