# 运行一个 agent loop

这是一篇 how-to 文档：只使用 `src/loop/` + `src/llm/` 驱动一个带工具的 agent——有 turn/step 状态机和 hook，但没有 session、没有持久化。`example/loop.ts` 是用 fake requester 写的可离线运行版本（`pnpm example:loop`）。

## 步骤

1. 构造 requester，并把 agent 的 profile 叠上去：`profile.systemPrompt` 和 `profile.tools`（工具描述）。叠在这里的 profile 只是默认值——在 loop 上直接设置（见下文）会覆盖它。loop 每个 step 只读一次 requester getter，因此可以在 step 之间换掉返回的 requester。
2. 用 `defineTool`（`src/tool/define.ts`）定义工具。schema 同时产生模型看见的 `parameters` 和 `execute` 里的 `args` 类型。`onUpdate` 流式上报进度（以 `tool.delta` 出现）；调用 `detach(text)` 会把工具转入后台，并以 `text` 作为应答立即收尾该工具条目。
3. 用 `createToolExecutor()` 按名字分发，把它作为 `executor` 传给 `createLoop({ requester, executor, hooks })`。`register` 登记实现，`setTools` 或 requester 的 `profile.tools` 登记描述，两边互不推导。`invalidate(name, reason)` 让后续调用得到带内错误且不进入 handler，`restore(name)` 用同一个 handler 恢复。`createToolExecutor({ policy: { maxResultChars } })` 截断最终文本结果。`loop.executor` 就是传入的那个对象。只有一个 `execute`、不需要分发时，这个对象本身仍可以直接当作 executor。
4. loop 起步是 held 状态。`loop.runTurn(entry)` 跑一个 turn 并以该 turn 的 `TurnOutcome` resolve；也可以用 `submit` / `notify` 排队 prompt、用 `continue()` 放行。被 abort 的 turn 会把它的 prompt 退回 inbox 并 hold。`loop.close()` 会不留宽限期地 abort 正在运行的 turn，因此未完成的工具调用在 `turn.ended` 之前仍会得到一个 aborted 结果。
5. `loop.subscribe(listener)` 会收到每一个 `LoopEmitted` 事件：turn/step 边界、`llm.streaming.*`、`tool.*`、hook 生命周期和 hook 失败。`loop.wait(type, { match, timeoutMs, signal })` 以 Promise 等待单个匹配事件。
6. 护栏以 hook 形式注册——例如 `createMaxStepsHook(() => 8)` 在 8 个 step 后让 turn 以 `blocked` 收尾。`loop.hooks` 支持 pause/resume/remove 和按 hook 的 `onFailure` 策略。按生命周期顺序的 hook point：`turn.starting`（每个 turn 一次，可拦截整个 turn）；`message.appending`（每个排队条目一次，可改写条目或拦截它）；`step.starting`（每个 step 在 LLM 请求前一次——retry 不触发，resume 的 turn 的下一个 step 会经过——携带当前 messages 和 profile；可改写历史（在 hook 间链式传递，生效后以耐用的 `context.settled` 落定）或拦截该 step）；`tool.batch-starting`（每批工具调用在执行前一次；一旦拦截则应用到每个 call——每个 call 都有 started/ended 事件、共享同一个可选 result 的 blocked outcome，per-call hook 和 executor 都不运行）；`tool.starting`（每个 call 一次，可改写该 call 或带可选 result 拦截它）随后 `tool.permitting`（每个 call 一次，决策同构）——无论注册先后，所有 `tool.starting` hook 都排在任何 `tool.permitting` hook 之前运行，改写链式贯穿两段，安全/权限类 hook 恒裁决改写后的最终 call；`tool.ending`（每个 call 执行后一次，可改写 result 或终止 turn）；`step.stopping` / `step.continuing`（在 step 收尾时，可让已完成的 step 继续，或让将继续的 step 完成/拦截）。

```ts
import { createUserEntry } from '#/history/message';
import { kimiRequester } from '#/llm/builtin/provider/index';
import { createUserMessage } from '#/llm/message';
import { createLoop, createMaxStepsHook } from '#/loop/index';
import { endpointFromEnv, PROVIDER_ENV } from '#/node/env';
import { createToolExecutor, defineTool, zodSchema } from '#/tool/index';
import { z } from 'zod';

const weatherTool = defineTool({
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  schema: zodSchema(z.object({ city: z.string().describe('City name') })),
  async execute({ args, onUpdate }) {
    onUpdate?.({ key: 'query', text: `querying ${args.city}`, percent: 40 });
    const weather = await queryWeather(args.city);
    return { content: [{ type: 'text', text: weather }] };
  },
});

const tools = createToolExecutor();
tools.register(weatherTool);

const requester = kimiRequester
  .with({ endpoint: endpointFromEnv(PROVIDER_ENV.kimi) })
  .with({ model: { spec: { provider: 'kimi', name: 'kimi-k2' } } });

const loop = createLoop({
  requester: () =>
    requester.with({ profile: { systemPrompt: 'You are a helpful assistant.', tools: [weatherTool] } }),
  executor: tools,
  hooks: [createMaxStepsHook(() => 8)],
});

loop.subscribe((event) => {
  if (event.type === 'llm.streaming.part' && event.part.type === 'text') process.stdout.write(event.part.text);
});

const outcome = await loop.runTurn(
  createUserEntry(createUserMessage('北京天气怎么样？'), {
    promptId: 'demo-1',
    origin: { kind: 'user' },
  }),
);
console.log(outcome.type);
await loop.close();
```

## 设置 system prompt 和 tools

`loop.setSystemPrompt(text)` 和 `loop.setTools(descriptions)` 设置 loop 随每次 LLM 请求在历史之外附加的 profile；当前值读 `loop.state.profile`。每次调用以 `system_prompt.settled` / `tools.settled` 应答；除非 loop 处于 idle 或正在收尾一个 step，否则得到 `*.rejected`——与 `setContext` 一样，turn 中途的修改从下一个 step 生效。传 `undefined` / `[]` 即清除。

```ts
loop.setSystemPrompt('You are a helpful assistant.');
loop.setTools([weatherTool]);
```

settled 事件是耐用记录（`src/loop/record.ts`），因此在首个 turn 之前设置的 profile 会在按记录恢复时原样回来。又因为请求按 requester 优先的顺序合并维度，loop 的 profile 会覆盖叠在 requester 上的 `profile`——重开后持久化的 spec 永远赢。

## 下一步

- `loop.state` 是一个普通投影（已设置的 profile、status、held、inbox、messages、正在运行的 turn、含后台工具的工具列表）;`loop.requester` 是用于旁路请求的 requester facade——每次 `request`/`generate` 都会重新读取宿主的 requester getter 并把当前历史填充为 `content`，因此 `.with()` 的覆盖总是落在最新的配置与上下文上;`loop.waitForTasks` 等待后台工具，`loop.waitForIdle()` 等 loop 停稳。
- loop 本身不做持久化。`src/loop/record.ts` 定义了它的耐用契约（`LoopRecord` / `toLoopRecord` / `loopProjection`）；想要接好的持久化，用 `src/session/`——见「运行一个带 subagent 的 session」。
- 崩溃后恢复：用 `loopProjection` 回放记录，把 `{ profile, messages, nextTurnId, unfinished, inbox: { notify } }` 作为 `input` 传入。存在 `unfinished` turn 时 loop 以 `interrupted` 状态启动：`continue()` 在历史允许时续跑这个 turn(`turn.resumed`，同一个 turn id，进入下一个 step);其他触发——`abort`、`runTurn`、`submit`、`notify`、`steer`——都会先把它以 `aborted`(reason 为 `CRASHED`)收尾，并为没有结果的工具调用补上 aborted 结果。
