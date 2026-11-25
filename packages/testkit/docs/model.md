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

## 检查 prompt 缓存前缀

服务端只能复用请求开头那段与之前请求完全相同的内容。假模型按服务端缓存的顺序把每个请求切成段（模型与思考参数、system、tools、messages），记在 `model.promptCache()` 里：每个请求复用了多少估算 token、复用自哪个请求、主通道和压缩请求比上一个主请求在哪一段变了。这项检查默认开启，没有声明过的断点会让 `verify()` 失败，`checkPromptCache: false` 可以关掉。创建模型时传 `reportCachedTokens: true`，没写 usage 的步骤会把复用的 token 作为缓存读数报给客户端。

```ts
import { say } from '@moonshot-ai/testkit/model';
import { modelFixtures, type ModelFixtures } from '@moonshot-ai/testkit/vitest';
import OpenAI from 'openai';
import { expect, test as base } from 'vitest';

const test = base.extend<ModelFixtures>(modelFixtures({ reportCachedTokens: true }));

test('reuses the first request as the cached prefix of the second', async ({ model }) => {
  model.script(say('first'), say('second'));
  const client = new OpenAI({ apiKey: 'test-key', baseURL: 'http://example.test/v1', fetch: model.fetch, maxRetries: 0 });
  const tools = [{ type: 'function' as const, function: { name: 'Read', parameters: { type: 'object' } } }];
  const history = [{ role: 'user' as const, content: 'Read notes.txt.' }];

  await client.chat.completions.create({ model: 'testkit-model', messages: history, tools, prompt_cache_key: 'session-1' });
  const second = await client.chat.completions.create({
    model: 'testkit-model',
    messages: [...history, { role: 'assistant', content: 'first' }, { role: 'user', content: 'And then?' }],
    tools,
    prompt_cache_key: 'session-1',
  });

  expect(model.promptCache()[1]).toMatchObject({ baseline: 0, reusedFrom: 0 });
  expect(second.usage?.prompt_tokens_details?.cached_tokens).toBe(model.promptCache()[1]?.reusedTokens);
});
```

第二个请求改了 tools、system 或者更早的消息时，夹具收尾的 `verify()` 会报出第一处不同，例如 `tools[1] Bash is missing`，并给出复用了多少 token。产品有意改写前缀时（撤销、清空上下文、媒体恢复），在测试里用 `model.expectCacheBreak('撤销改写了上一轮回答', { at: 'history' })` 写明原因；声明了却没发生的断点同样会失败。换模型不用声明，每个模型各有一份缓存；被服务端拒绝的请求也不参与比较。压缩请求生效后的第一个主请求可以换一段新历史，但模型参数、system 和 tools 仍不能变，这条只在 `kimi` provider 类型下自动识别。完整规则见 [README](../README.md#prompt-cache)。[规则用例](../test/prompt-cache.test.ts) · [经过真实引擎](../../../tests/scenarios/providers.test.ts)

## 检查客户端是否依赖整齐的分块

默认每个步骤按完整的 SSE 事件写出。真实 provider 和网络会把字节流切在任意位置，包括多字节字符和 JSON 的中间。创建模型时传 `chunking: { seed, maxBytes }`（例如 `createFakeModel({ chunking: { seed: 7, maxBytes: 3 } })`，KAP 场景用 `scenarioFixtures({ modelOptions: { chunking } })`），回复和 JSON 响应体会被切成 1 到 `maxBytes` 字节的小块逐块写出。挂起点仍落在原来的位置，流内错误仍整块写出。同一个种子每次切法相同，失败可以复现。

Google SDK 只把「单独一次读到的错误 JSON」识别为流中错误。进程内 `model.fetch` 每次写入都是单独一块，所以结果确定；经回环 HTTP 时，网络可能把错误和前面的数据合到一次读取里，SDK 就认不出这个错误。需要稳定断言 Google 流中错误时，走进程内 `fetch`（引擎进程内测试就是这样接入的），或者改用流开始前的 `httpError`。[官方 SDK 对照](../test/protocols.test.ts) · [经过真实引擎](../../../tests/scenarios/providers.test.ts)

## 在引擎进程内接入假模型

agent-core-v2 的集成测试不起服务端，用 harness 的 `testkitAgentFixtures()` 取得 `{ agent, model }`。它把 `model.fetch` 注入引擎真实的 provider 请求链：步骤、命名挂起点、通道、请求记录和 `verify()` 都与其他层相同，请求会经过真实的协议编码和解析。harness 默认的 provider 是 `kimi`，所以子 agent 和压缩请求会自动进入各自的通道。这时调用旧的 `agent.mockNextResponse()` 会直接报错，避免两套脚本混用。存量用例里的 `mockNextResponse` 也由 testkit 模型回答：harness 把每条旧剧本翻译成 testkit 步骤，用例结束时同样检查没写剧本的请求、没被请求的剧本和不合法的消息序列。[引擎用例](../../agent-core-v2/test/integration/conversation/testkit-model.test.ts) · [harness 夹具](../../agent-core-v2/test/harness/testkit.ts)

## 在桌面端接入假模型

按 [E2E 指南](../../../tests/e2e/AGENTS.md)编写场景。场景通过 `scenario()` 取得 `product`、`model` 和 `workspace`。场景夹具在启动前写入假模型配置，[Desktop 驱动](../../../tests/e2e/surfaces/desktop.ts)启动 Electron。场景结束后，夹具验证并关闭假模型。

例如测试用户取消流式回复时，用 `held()` 安排部分文本后挂起，用 `product.send()` 发消息，等模型到达挂起点和界面显示部分文本，再用 `product.stop()` 停止回合。可以检查模型请求是否中止，然后在同一会话发下一条消息并断言新回复。[取消的端到端场景](../../../tests/e2e/scenarios/turn/stop-mid-turn.spec.ts)
