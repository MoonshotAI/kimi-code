# 创建并操作一个 Harness 实例

`@moonshot-ai/harness-core` 的产品入口是 `mountHarness`（`src/harness.ts`）。它在 agent-core 的
`mountApp` 之上做两件事：把你给的 `SessionSpace` 与 `HarnessSessionBind`（requester + agent
模板）`provide` 到 App 根节点，并派生一个 `OpenSession` 一起挂进去。之后所有操作都围绕返回的
`AppHandle` 展开。

## 创建实例

```ts
import {
  createStaticCredentialProvider,
  openaiProvider,
  MAIN_AGENT_ID,
  type TurnRequest,
} from '@moonshot-ai/agent-core';
import { features, fsSessionSpace, mountHarness } from '@moonshot-ai/harness-core';

const request: TurnRequest = {
  config: { model },
  credentialProvider: createStaticCredentialProvider(model.apiKey),
  maxContextTokens: model.maxContextSize,
};

const app = mountHarness({
  space: fsSessionSpace('/path/to/data-root'),   // 必填
  requester: openaiProvider.createRequester('openai'), // 必填
  agent: { agentId: MAIN_AGENT_ID, request },    // 可选：每个 session 自动挂的 agent 模板
  features: [...features],                       // 可选：preset + 追加 create*()
});
await app.ready();
```

### `space`（必填）

会话的持久化与 catalog 端口，接口是 `SessionSpace`（`src/host/session-space.ts`）：
`list / get / create / open / update / delete / copy`。内置两种实现：

- `fsSessionSpace(root)` — 每个 session 一个目录，`meta.json` 存 catalog 记录（title /
  workspaceId / metadata），树与 blob 落在目录内
- `memorySessionSpace()` — 内存实现，适合测试

换 OSS / SQLite / PostgreSQL 时实现同一组接口即可，`mountHarness` 不关心底层。

### `requester`（必填）

`LlmRequester`，由 provider 工厂创建：

- agent-core：`openaiProvider.createRequester('openai' | 'openai_responses')`、
  `anthropicProvider.createRequester()`、`googleProvider.createRequester()`
- harness-core：`kimiProvider.createRequester(protocol?)`

### `agent`（可选）

`CreateAgentProps` 或 `(input: OpenSessionInput) => CreateAgentProps | undefined`。给定后，
`createOpenedSession` 每开一个 session 就自动 `session.create(agent)`。函数形式可以按
session 输入（比如 `workspaceId`）返回不同的 agent 配置。

### `features`（可选）

`features`（`src/preset.ts`）是默认产品 Feature 名单；追加能力用各 `create*()` 工厂，例如
`createMedia(...)`、`createToolSelect(...)`、`createCompaction(...)`、`createHttp(...)`。
参考 `example/app.ts` 的 `mountExample`，它装的就是一份完整配置。

## 操作实例

### 打开 / 创建 session：`createOpenedSession`

日常入口不是 `app.create`，而是 `createOpenedSession`（`src/host/session.ts`），语义是
「活的直接拿、catalog 里有就打开、没有就新建、`from` 则复制 fork」：

```ts
import {
  createOpenedSession,
  OpenSessionRef,
  SessionSpaceRef,
} from '@moonshot-ai/harness-core';

const space = app.node.resolve(SessionSpaceRef);
const openSession = app.node.resolve(OpenSessionRef);

const session = await createOpenedSession(app, space, openSession, {
  sessionId: 'my-session',          // 省略则生成 uuid
  title: 'demo',                    // 可选，写入 catalog 并广播 session.meta_updated
  // from: 'other-session-id',      // 可选，复制已有 session（fork）
});
```

catalog 层的元数据读写不需要挂树：直接 `space.list() / space.get(id)`；改元数据用
`updateSessionRecord(app, space, id, patch)`，它会同步给活 session 广播
`session.meta_updated`。

### App 命令面

`AppHandle extends AppCommands`：

- `app.list() / app.get(sessionId)` — 活 session 表（不含 catalog 里未打开的）
- `app.create(props) / app.close(sessionId)` — 底层创建 / 卸载
- `app.installFeature(spec) / app.uninstallFeature(spec | name)` — 运行时装卸 Feature
- `await app.disposeAsync()` — 整体关停（进程退出前调）

### Session → Agent

`SessionHandle`：

- `session.list() / session.get(agentId)` — 活 agent 表
- `session.create(props) / session.fork(sourceId, props) / session.close(agentId)`
- `session.stores` — `{ session, agent } 商店`，可直接 `dispatch` / 读快照

```ts
const agent = session.get(MAIN_AGENT_ID);
if (agent === undefined) throw new Error('agent not mounted');
```

### 发 prompt 与回合控制（`AgentCommands`）

```ts
import { createUserMessage } from '@moonshot-ai/agent-core';

agent.submit(createUserMessage('你好'), {
  origin: { kind: 'user' },
  tracked: true,
});
```

其余命令：`notify`（不追踪的通知）、`remind(key, message)`、`cancel(id)`、
`steer(ids)`、`abort(reason?)`、`pause() / continue()`、`snapshot`（可读快照 Ref）。

### 订阅事件

节点事件即已持久化事件，挂在 `session.node` 上：

```ts
const off = session.node.on('*', (event) => {
  // 'message.appended' / 'turn.ended' / 'interaction.requested' / ...
});
```

等一个回合结束：

```ts
await new Promise<void>((resolve, reject) => {
  const off = session.node.on('turn.ended', (event) => {
    off();
    const outcome = event['outcome'];
    if (outcome === 'done') resolve();
    else reject(new Error(String(event['errorMessage'] ?? outcome)));
  });
});
```

### Interaction（工具向用户提问）

```ts
import { InteractionRef } from '@moonshot-ai/harness-core';

const interactions = session.node.resolve(InteractionRef);
session.node.on('interaction.requested', (event) => {
  const requested = event as InteractionRequestedEvent;
  // 拿到 requested.interaction，向用户收集答案后：
  interactions.respond(requested.interaction.id, response);
});
// 回合结束后仍有未应答的，可 interactions.findAll({ resolved: false }) + interactions.wait(id)
```

### 走 HTTP 而不是进程内调用

把 `createHttp({ listen: { port, host } })` 加进 `features`，同一套能力暴露为 REST
（`/api/v1`）：sessions 的 create / list / get / PATCH / delete，`{id}:fork` /
`{id}:abort` / `{id}:pause` / `{id}:continue` 等动作路由，以及
`POST /sessions/:session_id/prompts` 提交 prompt。适合别的进程来操作这个 harness 实例。

## 可运行参照

- `example/app.ts`（`mountExample`）：完整装配 — 加载 kimi-code 的 model 配置、preset +
  media + tool-select + compaction，无 argv 时挂 HTTP
- `example/cli.ts`（`runCli`）：进程内操作的完整闭环 — `createOpenedSession` 开/续
  session、订阅 `*` 事件、`agent.submit` 发 prompt、`waitTurn` 等回合、Interaction 应答、
  `disposeAsync` 退出

命令行直接跑：

```sh
pnpm --filter @moonshot-ai/harness-core example            # HTTP 模式，默认 127.0.0.1:8787
pnpm --filter @moonshot-ai/harness-core example -- -p '你好' -c <session-id> --json
```
