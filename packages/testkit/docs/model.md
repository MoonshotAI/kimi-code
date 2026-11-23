# 用假模型测试 provider 客户端

要验证客户端发了什么，或它能否读懂某种模型响应，可以把 `model.fetch` 传给客户端。SDK 仍然负责生成协议请求和解析响应，假模型在同一个进程内接收请求并按脚本回答。只接受服务地址的客户端可以用 `await model.listen()` 启动同一套脚本。OpenAI 客户端使用返回的 `/v1` 地址，Google GenAI 客户端使用 `model.origin`。[回环 HTTP 用例](../test/model.test.ts#L649) · [Google 客户端用例](../test/protocols.test.ts#L182)

## 写第一个 SDK 用例

下面是可直接放进 `packages/testkit/test/` 的完整 Vitest 测试文件。在其他工作区使用时，给测试所在的包声明 `@moonshot-ai/testkit` 的 `workspace:^` 开发依赖，以及用例实际导入的 SDK。

```ts
import { say } from '@moonshot-ai/testkit/model';
import { modelFixtures, type ModelFixtures } from '@moonshot-ai/testkit/vitest';
import OpenAI from 'openai';
import { expect, test as base } from 'vitest';

const test = base.extend<ModelFixtures>(modelFixtures());

test('reads a reply from the side lane', async ({ model }) => {
  model.lane('side').script(say('hello'));
  const client = new OpenAI({
    apiKey: 'test-key',
    baseURL: 'http://example.test/v1',
    fetch: model.fetch,
    maxRetries: 0,
  });

  const reply = await client.chat.completions.create({
    model: 'testkit-model',
    messages: [{ role: 'user', content: 'hi' }],
  });

  expect(reply.choices[0]?.message.content).toBe('hello');
  expect(model.request(0)).toMatchObject({
    lane: 'side',
    protocol: 'openai',
    firstUserText: 'hi',
  });
});
```

这两条断言分别检查 SDK 读到的回复和假模型收到的请求。这个请求没有工具，也没有 Kimi 的客户端元数据，所以走 `side`。如果把 `say('hello')` 排进 `model.script()`，SDK 会收到 `side` 的默认回复 `OK`，主通道的步骤会被留在队列。夹具会在用例结束时调用 `verify()` 并关闭模型。[两个通道的对照用例](../test/model.test.ts#L154)

## 按模型请求安排脚本

每个通道（lane）都有自己的队列，按请求到达顺序取出一步。同一用户回合可能产生多次模型请求，步数取决于要观察的行为。

| 要验证的行为 | 在主通道安排的脚本 | 可观察的结果 |
|---|---|---|
| 客户端逐块显示文本 | `model.script(say(['A', 'B']))` | 一次流式请求收到两块文本 |
| 客户端记录服务端请求 ID | `model.script({ ...say('done'), headers: { 'x-request-id': 'example-request' } })` | 流式和非流式回复都带有指定的响应头 |
| 工具结果回到模型 | `model.script(bash('echo hi'), say('done'))` | 真实引擎先执行工具，第二次请求携带对应的工具结果，然后回合结束 |
| 引擎在服务暂时不可用时重试 | `model.script(httpError(503), say('recovered'))` | 主通道记录两次请求，同一回合的最终文本是 `recovered` |

每行是一个独立用例。所用步骤从 `@moonshot-ai/testkit/model` 导入。假模型只负责按顺序回应，工具由引擎执行，是否重试由被测客户端决定。单测需要直接观察第一次 HTTP 失败时，像上例一样关闭 SDK 自带的重试。[工具执行和重试的真实场景](../../../tests/scenarios/conversation.test.ts) · [步骤 API](../README.md#scripts-and-steps)

## 给并发请求分配脚本

有 Kimi 元数据时，压缩请求进入 `compaction`，其余非主 agent 的请求进入 `subagent`，其余带元数据的请求进入 `main`。缺少元数据时，带工具的请求进入 `main`，无工具请求进入 `side`。`model.script(...)` 给 `main` 入队。子 agent 的回复用 `model.lane('subagent').script(...)`。需要按内容分流时，`model.scriptFor('关键词', ...steps)` 匹配第一条用户文本，`model.route(name, matcher)` 可读取协议、路径、工具、元数据和消息。自定义路由先于内置路由，按注册顺序取第一个匹配项。[路由用例](../test/model.test.ts) · [主 agent 与子 agent 共用一个模型](../../../tests/scenarios/conversation.test.ts#L223)

全局请求序号随到达顺序分配。当主 agent 和子 agent 同时工作，先用 `model.waitForRequest(predicate)` 按通道、文本或元数据定位请求，再用 `model.callId(request.index, 0)` 取得该请求第一条工具调用的默认 ID。也可以在 `call(name, args, { id })` 中提供固定 ID。动态步骤 `(request, { lane, call, signal }) => step` 中的 `call` 是从零开始的通道内请求序号。异步步骤可以把 `signal` 交给自己的 I/O，以便客户端取消时一起停止。[动态脚本和并发路由](../test/model.test.ts#L344) · [取消正在生成的回复](../../../tests/scenarios/conversation.test.ts#L121)

## 决定在哪一层断言

- **多个 provider 的共同行为**可以断言 `request.view.messages`、`view.tools`、`firstUserText` 或 `userTextsSinceReply`。例如，工具调用的下一次请求应包含一条具有匹配 `callId` 的 `role: 'tool'` 消息。[四种 provider 的同一条验收场景](../../../tests/scenarios/providers.test.ts)
- **协议特有的字段和分块**可以断言 `request.body`、`rawBody` 或 SDK 解析出的事件。OpenAI 工具参数是字符串。Anthropic 流可携带分段参数文本，非流式的 `tool_use.input` 和 Google 的 `functionCall.args` 要求 JSON 对象。要构造畸形 SSE 或 JSON 文本，用 `rawResponse({ chunks: [...] })` 提供字符串块。[官方 SDK 的协议测试](../test/protocols.test.ts)
- **验证 OpenAI 的思考签名**时，用 `thinkSigned('分析', 'sig-1', say('回答'))` 安排回复。流式请求读取 `choices[0].delta.reasoning_details`，非流式请求读取 `choices[0].message.reasoning_details`。在数组中找到 `type: 'encrypted'` 的项，再核对它的 `encrypted` 是否等于传入的签名。
- **流的时序**可以用 `held('after-first', say(['A', 'B']), 1)` 把流停在第一块之后。发起流式请求后，等待 `model.hold('after-first').reached()`，确认模型已发出第一块。再从 SDK 流中读到文本 `A`，就能断言客户端也收到了它。调用 `release()` 后再读完余下的流，或用 `cut()` 测试服务端断流。客户端主动中止时请求记录为 `aborted`，脚本主动切断时记录为 `cut`。[命名挂起点用例](../test/model.test.ts#L177)

## 读懂严格校验的失败

在 Google 请求历史中，`functionCall` 和 `functionResponse` 可以省略 ID。两个同名调用都省略 ID 时，按它们出现的顺序配对无 ID 的结果。在 `request.view.messages` 中分别读取每条调用的 `id` 和结果的 `callId` 来断言配对关系。协议里显式给出的 ID 会原样保留，多出的结果或缺失的结果会被 `verify()` 报出。

三个协议都要求同时等待结果的工具调用各有自己的 ID。若 `verify()` 报 `repeats pending tool call ID`，检查出错消息里的调用列表和之前尚未配对的调用。等前一次调用收到匹配结果后，后续调用可以重新使用这个 ID。

`model.problems()` 返回处理请求时已记录的问题。`verify()` 还会检查所有通道的剩余步骤和仍在等待处置的命名挂起点。手动用 `createFakeModel()` 时，在断言后调用 `verify()`，并用 `finally` 执行 `await model.close()`。有意发送的 `httpError(503)` 可以和成功通过的 `verify()` 同时出现。用例仍需断言客户端如何处理了错误。[校验实现](../src/model/fake-model.ts) · [未放行挂起点的场景](../../../tests/scenarios/verification.test.ts)

| 看到的现象 | 接下来检查什么 |
|---|---|
| 回复是 `OK`，或结束时报告 `unused step(s)` | 看 `model.requests()` 的 `lane` 和 `tools`。确认实际通道、请求次数与脚本队列相符 |
| 返回 400 并报告 `had no scripted step` | 看错误指出的请求编号、通道、第一条用户文本。工具返回或一次重试都可能多发一个请求 |
| `verify()` 报消息为空或工具结果顺序错误 | 对照 `request.body` 的原始顺序和 `request.view.messages` 的工具调用 ID。Anthropic 空 `content` 数组、Google 空 `parts` 数组都能定位到具体用户消息 |
| `verify()` 报脚本调用了未知工具或参数不匹配 | 对照该次请求的 `view.tools`，检查顶层必填字段、类型和枚举。要故意模拟模型调用不存在的工具，可仅对该次 `call(..., { invalid: true })` 标明意图 |
| 等待请求或挂起点时收到 `FakeModelClosedError` | 检查模型的所有者何时调用了 `close()`。关闭会拒绝尚未满足的等待，稍后再接收这个拒绝也能拿到原错误 |

空用户消息如果插在两个工具结果之间，错误还会指出哪个工具调用仍在等待结果。[空消息与工具结果顺序回归](../test/protocols.test.ts#L57)

## 在桌面端接入假模型

在 Playwright 测试进程中用 `await startFakeModel({ apiKey })` 启动模型服务，Electron 内嵌的 KAP 会通过回环 HTTP 访问它。用 `writeKimiConfig` 把 provider 配置写入桌面夹具的 `KIMI_CODE_HOME`。现有 `app` 夹具已启动应用时，写入 `join(scratch, 'home')` 后调用 `await app.relaunch()` 让内嵌 KAP 读取配置。[桌面应用夹具](../../../apps/desktop/e2e/fixtures/app.ts)

桌面配置里的三个名字各有用途。用 `fakeModelConfig(model, { type: 'openai', providerAlias: 'e2e', alias: 'e2e/stub', modelName: 'stub', apiKey, maxContextSize: 128000 })`，设置页读到的 provider 是 `e2e`，默认模型是 `e2e/stub`，模型服务收到的请求里 `view.model` 是 `stub`。配置多个需要验证不同密钥的 provider 时，可以为每个 provider 启动独立的假模型。

| 要在桌面验证的行为 | 用例怎么写 |
|---|---|
| 流式输出与用户取消 | 用 `held('partial', say(['第一块', '第二块']), 1)` 安排回复。用 `app.submit()` 发送消息，等 `hold('partial').reached()` 和界面出现第一块，再点击 Interrupt。检查该请求的 `state` 变为 `aborted`，随后在同一会话发第二条消息并断言回复。旧夹具的 `app.startTurn()` 等待的是它自己的 stub。 |
| 工作区提示和消息历史 | OpenAI 请求用 `request.texts('system')` 按原顺序读取每条 system 或 developer 消息。跨协议读取整段提示用 `view.system`。插话或取消后的下一步可分别检查 `userTextsSinceReply` 和 `remindersSinceReply`。 |
| 后台请求、子 agent 与工具结果 | 桌面的 OpenAI 配置没有 Kimi 路由元数据。按 `model.lane('main').waitForRequest(n)` 等主通道，避免全局序号被无工具的 `side` 请求占用。自定义子 agent 路由可同时匹配 `request.tools.length > 0` 和 `firstUserText`。工具结果与实际请求中的调用 ID 配对。 |
| 需要让未编排回合保持运行 | 在对应通道显式设置 `unscripted('hang')`，模型发出第一块后挂起。用 `waitForHeldTurn()` 等请求就位；`releaseHeld()` 放行已经到达的挂起点。用例结束前调用 `verify()`，在 `finally` 中 `await model.close()`。 |

Electron 窗口、原生对话框、剪贴板、Browser MCP、重启后的用户数据和失败 trace 由桌面夹具管理。测 renderer 与 KAP 的重连时，在 Playwright 端切断 REST 或 WebSocket；测 provider 回复中断时，使用模型的 `hold.cut()`。这两种断连发生在不同的连接上。[桌面重连用例](../../../apps/desktop/e2e/turn-reconnect.spec.ts) · [KAP 场景指南](kap-scenarios.md)

从仓库根目录单独运行表中取消与后续回合的桌面用例。这个命令会构建桌面应用，并用 Playwright 启动 Electron。[完整用例](../../../apps/desktop/e2e/turn-stop-then-send.spec.ts)

```sh
pnpm --filter kimi-code-app run e2e:headless --project turns-transcript --no-deps --grep 'the desktop cancels its testkit provider stream'
```
