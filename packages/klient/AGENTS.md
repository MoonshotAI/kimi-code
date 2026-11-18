# klient Agent 指南

`packages/klient` 的包内规则。

## 架构

这个包是分层的；改代码时严格保持分层：

- **门面**（`src/core/facade/`、`src/core/klient.ts`）：唯一的公开 API，即聚合后的 `global.*` / `session(id).*` / `session(id).agent(id).*` 方法及其 `events.*` 事件中心。不出现引擎的服务 token，不出现 `onDid*`/`onWill*` 命名，**也没有通往原始服务的逃生口**：不要重新引入服务定位器（`core()`/`service()`/`makeProxy`）。
- **契约**（`src/contract/`）：每个 wire 方法的 zod 输入/输出 schema，加上事件载荷的 schema。这些 schema 是照着 agent-core-v2 的类型手工镜像的，并由 `test/contract-parity.ts` 里的编译期对齐断言固定住；引擎类型一变，tsc 会先在这里报错。`src/contract/helpers.ts` 里的 `maybe()`/`noResult()` 编码了 HTTP wire 上 `null` 与 `undefined` 的语义区别：每个 `X | undefined` / `void` 结果都要用它们。
- **传输方式**（`src/transports/{ipc,memory}`）：每种传输方式只实现 `KlientChannel` SPI（`src/core/channel.ts`），别的什么都不做。ipc 把同样的 dispatcher 流量按 NDJSON 分帧，经 unix socket 传输，并和 memory 共用进程内的 dispatcher；memory 让每个值都做一次 JSON 往返，所以两种传输方式返回的数据逐字节相同。

门面只覆盖在两种传输方式上行为完全一致的服务（进程内的 dispatcher 复刻了服务端的作用域解析，包括通过 `ensureMainAgent` 实例化 `main` agent）。onWill/hook 式的拦截无法通过 wire 暴露（引擎的 hook 是进程内的 `OrderedHookSlot`）；终端接口只有 v1 有，放在 legacy 测试套件里。文件上传确实在门面上（`global.files`）：字节以 base64 编码的形式穿过 wire，dispatcher 在两个方向上适配引擎的 `IFileService` 流。

## 测试

- 一套共享的一致性测试套件（`test/helpers/conformance.ts`）原样运行在每种传输方式上，`test/` 下每种传输方式各有一个测试文件。新的**全局**门面覆盖加到这套共享的一致性测试套件里，不要按传输方式分别加。
- `test/e2e/legacy/` + `test/e2e/harness/`：legacy 的 `/api/v1` 真实服务端测试套件（从 server-e2e 迁移过来）。除非 `KIMI_SERVER_URL` 指向一个正在运行的服务端，否则它们会跳过；它们**必须保持原样继续运行**。v1 接口没有内存内的等价实现，所以这些套件只连真实服务端运行，不要试图用进程内的传输方式跑它们。
- 已退役的 `scenarios/` 脚本已改写成测试套件：图片上传和终端（只有 v1 才有的接口）放在 `test/e2e/legacy/` 里。

## 可观测性（沿袭自 server-e2e）

- 可观测性放在每个 e2e 用例内部；每个真实服务端用例都通过 `test/e2e/legacy/log.ts` 里共享的日志工具，打印结构化的、限于本用例的细节（请求、envelope、WS 握手、终端帧、错误 envelope），而不是临时写 `console.log`。
- 通过的 Vitest 用例，日志也必须保持可见：写到 stdout。
- 新增或修改 e2e 用例时，同时更新它的可观测性；不要只为了打印某个现有用例本该暴露的数据而新增一个场景。

## 命令参考

- `pnpm --filter @moonshot-ai/klient test`：所有 Vitest 测试套件（单元 + 一致性 + e2e；缺少所需的环境变量时，真实服务端用例会跳过）。
- `KIMI_SERVER_URL=http://127.0.0.1:58627 pnpm --filter @moonshot-ai/klient test`：连上正在运行的服务端，把 legacy 的真实服务端用例也包括进来。
- `pnpm --filter @moonshot-ai/klient docker:e2e`：docker e2e；运行时根据当前工作区推导 runner 的名称/命名空间，避免不同工作区之间互相冲突。
- `pnpm --filter @moonshot-ai/klient typecheck` / `pnpm smoke`（基于 memory 传输方式的进程内冒烟测试；见 `examples/smoke.ts`）。
- `pnpm --filter @moonshot-ai/klient smoke:select-tools`：针对 kimi 类型 provider 的 select_tools（渐进式工具披露）探针：先用 stub 验证动态工具声明的 kimi 专有 wire 编码，再对每个真实的 kimi 模型实际跑一遍两步的 select→use 流程（见 `examples/kimi-select-tools.ts`）。
