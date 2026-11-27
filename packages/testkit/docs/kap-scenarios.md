# 编写真实 KAP 会话测试

要验证用户取消、审批工具、读取历史等行为，可以在 `tests/scenarios` 编写测试。这个工作区在本机启动真实的 kap-server 和引擎，通过 REST 发起操作，通过 WebSocket 观察实时事件。测试只编排模型如何回答。引擎实际发出了什么请求、客户端收到了什么、服务端保存了什么，都可以分别断言。[场景夹具](../../../tests/scenarios/support/scenario.ts) · [KAP 接口速查](../README.md#the-kap-harness)

## 在模型准备回复时取消

下面是一个完整测试文件。将它保存为 `tests/scenarios/cancel-example.test.ts`，在仓库根目录运行 `pnpm exec vitest run --reporter=agent tests/scenarios/cancel-example.test.ts`。每个测试文件都从 Vitest 的 `test` 调用 `extend`，这样仓库的 lint 能识别测试体里的断言。

```ts
import { once } from 'node:events';

import { deferred } from '@moonshot-ai/testkit/fixtures';
import { say } from '@moonshot-ai/testkit/model';
import { expect, test as base } from 'vitest';

import { scenarioFixtures, type ScenarioFixtures } from './support/scenario';

const test = base.extend<ScenarioFixtures>(scenarioFixtures());

test('取消正在准备的回复后，同一会话仍能继续', async ({ kap, model }) => {
  const preparing = deferred<AbortSignal>();
  model.script(
    async (_request, { signal }) => {
      const disconnected = once(signal, 'abort');
      preparing.resolve(signal);
      await disconnected;
      return say('迟到的回复');
    },
    say('可以继续'),
  );

  const session = await kap.createSession();
  await kap.prompt(session.id, '开始');
  const signal = await preparing.promise;
  expect(await kap.cancel(session.id)).toEqual({ cancelled: true });

  const idle = await kap.waitIdle(session.id);
  expect(idle.last_turn_outcome).toBe('interrupted');
  await model.waitForRequest((request) => request.lane === 'main' && request.state === 'aborted');
  expect(signal.aborted).toBe(true);

  await kap.prompt(session.id, '继续');
  expect((await kap.waitIdle(session.id)).last_turn_outcome).toBe('completed');
  const [first, second] = await kap.turns(session.id);
  expect(first?.items.filter((item) => item.type === 'assistant_message')).toEqual([]);
  expect(second?.items.at(-1)).toMatchObject({ type: 'assistant_message', text: '可以继续' });
});
```

`kap.prompt()` 返回时，请求可能刚被接收或仍在排队。`preparing` 在脚本开始并订阅了这一条请求的 `abort` 事件后才放行，所以取消一定发生在回复生成期间。对第一个回合的断言确认迟到的文本没有进入会话历史。最后再发一个 prompt，可以发现取消意外影响后续回合的问题。脚本若要执行可取消的 I/O，需要把 `signal` 传给该操作。[异步取消与后续回合的回归测试](../../../tests/scenarios/conversation.test.ts#L121)

## 根据断言选择等待点

| 要证明的行为 | 等什么 | 检查什么 |
|---|---|---|
| 工具真实执行，结果回到模型 | 给同一通道排好工具调用和最终回答两个步骤，然后 `await kap.waitIdle(session.id)` | 下一次模型请求的 `view.messages` 里有对应调用 ID 和真实输出，持久化回合里有完成的工具条目 |
| 用户已看到第一块文本时插话 | 在第一块后挂起，等客户端收到含该文本的帧，再调用 `kap.steer()` | 原请求变为 `aborted`，余下文本未写入回合，后续回答完整 |
| 客户端显示的回合与重新读取的一致 | 发 prompt 前订阅，在会话空闲后再等该回合的 `turn.ended` | 比较 `socket.turns(session.id)` 与 `await kap.turns(session.id)` |

以流中插话为例，`held('after-first', say(['第一块', '第二块']), 1)` 让假模型发完第一块后暂停。`model.hold('after-first').reached()` 能确认模型停到了指定位置。还要在已经订阅的连接上等 `item.started`，核对条目类型和文本后再发插话，才能确定客户端已经看到第一块。[真实工具回传](../../../tests/scenarios/conversation.test.ts#L33) · [流中插话](../../../tests/scenarios/conversation.test.ts#L146)

同一条 WebSocket 连接会保留已收到的帧，`socket.waitFor()` 默认也会匹配历史帧。测试第二个回合时，先 `await socket.subscribe(session.id)`，在发 prompt 前记录 `const after = socket.mark()`，随后把 `{ after }` 传给 `socket.waitFor(predicate, { after })`。谓词里匹配事件类型和会话 ID，多 agent 场景还应匹配目标 agent。首次订阅默认等待 `main` 的初始快照，用 `{ agentIds: [...] }` 可订阅指定 agent。[实时回合与持久化回合对照](../../../tests/scenarios/conversation.test.ts#L12) · [订阅与等待实现](../src/kap/socket.ts)

## 录制协议帧给客户端回放

客户端（app-core、app-client，以后的 TUI）要用真实服务端的帧验证 reducer 时，先在场景测试里录制，再在客户端的包里回放。

- **录制**：`new KapRecorder(sessionId)` 之后，订阅前用 `recorder.watch(stream, socket, agentId)` 登记一路帧流，`agentId` 默认是 `main`。多个客户端或多个 agent 各登记一路，可以在回合中途再加入，例如中途订阅的第二个客户端。在每个用户可见的阶段调用 `recorder.checkpoint(name)`，例如订阅后、模型停在挂起点时、回合结束后，每路流都会记下自上一阶段以来这个会话、这个 agent 的对话帧。最后用 `recorder.recording({ serverVersion, kapVersion, pages })` 得到规范化后的录制，`pages` 给出每路流的起止 REST 页，再交给 `expectGolden` 入库。所有流共用一套编号：同一个 ID 在每路流里是同一个记号，时间换成固定值，字段类型不变。[首轮录制](../../../tests/scenarios/replay.test.ts)
- **回放**：消费方用 `readKapRecording(repoPath(...))` 读取，格式版本不对会直接失败。再用 `replayKapRecording(recording, stream, { start, apply })` 把一路流每个阶段的帧依次交给生产 reducer，得到每个阶段的视图。`apply` 要像生产的 socket 一样先过滤帧类型。消费方自己维护业务期望，不改录制文件。
- **变异回放**：`mutateKapRecording(recording, { stream, checkpoint }, change)` 只改一个阶段的帧，`change` 用 `dropFrames(match)`、`duplicateFrames(match)` 或 `insertUnknownFrame(index)`。它们匹配不到帧时报错，免得变异落空。用来证明 reducer 对重复帧幂等、忽略不认识的帧类型，以及断言在丢帧时确实会失败。[客户端回放](../../../packages/app-core/test/replay/first-turn.test.ts) · [录制工具](../src/kap/recording.ts)
- **更新录制**：只有在本地显式运行 `pnpm qa:refresh replay` 才会重写，随后评审数据差异；CI 只比较。

## 测试审批与拒绝

`scenarioFixtures()` 默认使用 `yolo` 权限模式。测试审批时，将 `{ permissionMode: 'manual' }` 传给 `kap.prompt()`，再按以下顺序操作。

1. 用 `kap.waitForInteraction(session.id)` 取得待处理交互，检查它的 `kind`、工具名称和调用 ID。
2. 调用 `kap.answer(session.id, interaction.interaction_id, response)`。例如，批准时传 `{ kind: 'approval', decision: 'approved' }` 作为 `response`。
3. 等 `kap.waitIdle(session.id)` 返回，检查工具结果是否已写入下一次发给模型的消息。测试拒绝路径时，可以传 `feedback`，检查反馈是否回到了模型。

`waitIdle` 会核对会话活动、prompt 队列和待答交互。如果仍有待答交互，默认会抛出带有交互类型和 ID 的错误。若一个用例可能连续触发多次审批，可调用 `kap.waitIdle(session.id, { onInteraction })`，在回调中逐个核对并答复。回合空闲后，还可以从 `last_turn_outcome` 区分成功、失败和中断。[批准与拒绝的完整用例](../../../tests/scenarios/conversation.test.ts#L55)

## 重启、清理与失败诊断

- **测试重启时**，`await kap.restart()` 会关闭当前 WebSocket 和服务，再用同一份 home 和 token 启动。重启后重新读取 `kap.turns(session.id)` 可以检验历史是否恢复。要继续观察实时事件，重新 `connect()` 并订阅。用例使用进程级 `HOME`，同一 worker 内的 KAP 场景应顺序运行。[重启后继续会话](../../../tests/scenarios/conversation.test.ts#L203)
- **需要全新进程时**，例如验证冷启动、崩溃恢复或旧版本数据，用 `await KapProcess.start({ home: testHome })` 以 `kimi web --port 0 --json` 启动 CLI 子进程。它从标准输出的就绪行读取地址和 token，只接受回环地址。返回的对象和 `kap` 一样提供 `prompt`、`waitIdle`、`turns`、`connect` 等会话操作。`close()` 通过认证的 `/api/v1/shutdown` 正常退出，要求退出码为 0；`crash()` 强杀整个进程树。两者都会检查子进程有没有访问回环以外的地址。进程内的 `kap.restart()` 复用同一个 Node 进程，模块级状态会保留，验证冷启动时用子进程。`await server.restart()` 正常退出后、`restart('crash')` 强杀后，用同一数据目录和同一端口起新进程，同一个对象继续使用；已打开的客户端按原地址重连。`--json` 模式的 token 只在单个进程内有效，重启后 `server.token` 会换成新值。见[重启后自动重连](../../app-core/test/reconnect/server-restart.test.ts)。[冷恢复与发布版数据](../../../tests/scenarios/cold-recovery.test.ts) · [子进程驱动](../src/kap/process.ts)
- **使用场景夹具时**，夹具在停止服务前验证脚本，因此能报告仍未放行的命名挂起点。随后关闭连接与服务、还原 `HOME`、删除自建的临时 home，并由模型夹具关闭模型。如果直接调用 `startKap()`，要自行验证并关闭传入的模型。调用方提供的 home 也由调用方清理。[驱动的资源管理](../src/kap/harness.ts) · [Vitest 夹具](../src/vitest/index.ts)
- **打开 `verifyInvariants` 时**，用例通过后夹具再调用 `verifyKapInvariants(kap)`，按客户端能看到的协议状态检查每个会话，之后再验证一次模型，会话落定期间发出的请求也会被检查。检查的会话包括用 `kap.createSession()`、`kap.fork()` 创建的，和任一 WebSocket 上出现过的。`tests/scenarios` 的每个场景都打开了这项检查。出现下面任一情况，用例失败，错误里逐条列出：
  - 到截止时间，会话还没回到空闲：`activity` 不是 `idle`、还有待回答的交互，或提示队列不空。截止时间是整次检查共用的 `TIMEOUTS.wait`，可用 `timeoutMs` 改。后台命令也算，场景结束前要等它结束，或用 `kap.cancel(id, { includeBackground: true })` 停掉。
  - 会话空闲后，还有回合或条目的 `status` 是 `running`。查的范围是主 agent、客户端订阅过的 agent，以及工具调用的 `agent_refs` 指向的子 agent。
  - 订阅了某个 agent 的客户端，把帧折叠出的回合和 REST 返回的不一样。agent 结束、帧流随之结束的也照样比较，客户端主动取消订阅的不比较。订阅快照分了页（`has_more`）时，这一页之前的回合不比较，但快照之后才开始的回合（例如撤销之后重发的）照样比较。
  - 客户端最后收到的 `session` 帧，在 `activity`、`pending_interaction`、`last_turn_outcome`、`archived` 上和 REST 不一致。帧里没有 `pending_interaction`（例如 `archived` 帧）时按 `none` 算。
  - 客户端收到某条交互的 `pending` 帧之后、结束帧之前，又收到同一会话说没有待处理交互的 `session` 帧。相信这一帧的客户端会把还开着的审批或提问清掉。客户端取消订阅这个会话、或收到它的 `archived`、`deleted` 帧之后，不再按之前的交互判断。

  REST 已经不认识的会话和 agent（HTTP 404 或 `404xx` 错误码），例如删掉的会话、关掉的 side agent，直接跳过。自己用 `startKap()` 时可以直接调用它。直接调用 `kap` 夹具函数的测试，要把测试上下文和模型一起传进去：`fixtures.kap({ ...context, model }, run)`。[协议不变量](../src/kap/invariants.ts) · [接线自测](../../../tests/scenarios/verification.test.ts)
- **定位失败时**，先看失败输出里的请求编号、通道、状态和步骤。若模型已响应但客户端卡住，再结合最近的 WebSocket 帧和服务日志判断停在哪个回合。夹具各保留最近 32 条帧与日志摘要，客户端连接后才有帧可看。`scenarioFixtures()` 默认采集服务日志，自定义 logger 或 logLevel 时，夹具会提示其诊断日志不可用。[失败诊断与快照错误示例](../../../tests/scenarios/verification.test.ts)
