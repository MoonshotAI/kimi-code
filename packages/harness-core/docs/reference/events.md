# Events Reference

The node event surface: every event reachable through `app.on` / `app.wait`,
where it comes from, and what it carries. For the mechanics (bubbling,
`EventContext` enrichment, typed subscriptions) see
[Architecture](../explanation/architecture.md#events-fire-enrich-bubble).

## Subscribing

```ts
const off = app.on('turn.ended', (event) => { /* enriched RuntimeEvent */ });
app.on(todo, 'todo.updated', (event) => { /* narrowed to TodoUpdatedEvent */ });
app.on(todo, '*', (event) => { /* any event whose type starts with 'todo.' */ });
const event = await app.wait('task.settled', { match: (e) => e['sessionId'] === 's1' });
```

Every event bubbling from inside a session carries `sessionId`, and every
event from inside an agent also carries `agentId`, merged in from the
lineage's `EventContext` (an event's own fields win on conflict).

Loop-local events — `prompt.submitted`, `prompt.reminded`,
`llm.streaming.part`, `tool.delta`, `hook.added`, … — do **not** bubble to
the app; subscribe to `agent.loop.subscribe(...)` / `agent.loop.wait(...)`
for those. Only the recorded subset below is forwarded.

## Built-in App and Unit Events

| Type | Fired when | Key fields |
|---|---|---|
| `session.created` | a session is created (not on resume) | `sessionId`, `from?` (fork source) |
| `session.deleted` | `app.delete(sessionId)` completes | `sessionId` |
| `session.meta_updated` | `app.update(sessionId, patch)` writes title/metadata | `sessionId`, `meta` (the `SessionRecord`) |
| `agent.opened` | an agent unit mounts (open, reopen, fork) | `agentId` + enriched `sessionId`; `source?` (e.g. `'btw'`), `reopened` |
| `agent.closed` | an agent unit starts unmounting | enriched `agentId`, `sessionId` |
| `unit.error` | a unit reports an error up the tree | `unit`, `error` |

## Forwarded Log Commits

Each session/agent unit forwards the commits of its durable log (from the
version the object opened at) as unit events.

From the session roster log:

| Type | Meaning |
|---|---|
| `agent.registered` | an agent id was registered into the roster (carries `source?`, `forkedFrom?`) |

From each agent's loop log (the `LoopRecord` set — see
[Persistence](../explanation/persistence.md#the-loop-log-agentsagentid)):

| Type | Meaning |
|---|---|
| `turn.started` / `turn.resumed` / `turn.ended` | turn lifecycle (`turnId`, `trigger`; `outcome` on ended) |
| `step.started` / `step.ended` | step (one LLM request) lifecycle (`outcome` on ended) |
| `message.appended` | a history entry was appended (`turnId`, `step`, `source`, `entry`) |
| `context.settled` | the history was replaced (`messages`, `reason?`) |
| `system_prompt.settled` | the system prompt profile value was settled |
| `tools.settled` | the tool-description profile value was settled |
| `tool.started` | a tool call began (`turnId`, `step`, `toolCall`) |
| `tool.async_ended` | a detached tool completed later (`outcome`, `entry`) |
| `hook.failed` | a loop hook threw (`point`, `hookId?`, `paused`) |
| `llm.retrying` / `llm.notice` | LLM policy retry / informational notice |

## Feature Events

Each feature declares its contract with `createFeature<E>(...)`; the typed
`app.on(feature, type, handler)` form narrows to exactly these unions.
Events marked *(store)* are turn-stamped journal events re-fired by
`useFeatureStore.dispatch` — they also satisfy the declared union unless
noted otherwise.

| Feature | Event | Semantics |
|---|---|---|
| todo | `todo.updated` *(store)* | the TodoList tool wrote a new list (`todos`, `turnId`) |
| interaction | `interaction.requested` | an approval/question/user-tool request awaits a response (`interaction`) |
| interaction | `interaction.resolved` | a request resolved (`id`, `response`, `interaction`) |
| permission | `permission.approval.requested` | a tool call needs an approval decision |
| permission | `permission.approval.resolved` | the approval was decided |
| permission | `permission.set_mode`, `permission.rules.add`, `permission.record_approval_result` *(store)* | durable permission state changes |
| plan | `plan_mode.enter` / `plan_mode.cancel` / `plan_mode.exit` *(store)* | plan mode transitions (`id`) |
| plan | `plan.revision` *(store)* | a plan file revision was recorded (`id`, `version`, `sha256`) |
| goal | `goal.updated` | the goal snapshot changed (`snapshot`, `change?`) |
| goal | `goal.create` / `goal.update` / `goal.clear` *(store)* | the durable goal journal |
| cron | `cron.fired` | a scheduled task fired (`origin`, `prompt`) |
| cron | `cron.add`, `cron.delete`, `cron.cursor` *(store)* | the durable cron journal |
| task | `task.started` / `task.settled` | a background task began / settled (`record`) |
| compaction | `compaction.started` / `compaction.completed` | a context compaction ran (`reason`, `stats`, `durationMs`) |
| compaction | `compaction.blocked` / `compaction.cancelled` | compaction could not start / was cancelled |
| mcp | `mcp.server.state` | an MCP server's connection state changed (`server`, `state`, `error?`) |
| mcp | `mcp.oauth.authorization_url` | an MCP OAuth flow needs the user to open a URL |
| skill | `skill.activated` | a skill was activated in an agent (`agentId`, `skillName`, `trigger`) |
| skill | `skill.changed` | the skill catalog changed (`sourceId`) |
| plugin | `plugin.changed` / `plugin.mutated` | the plugin set reloaded / one plugin mutated (`summary`) |
| tower | `tower.spawned` / `tower.completed` / `tower.failed` / `tower.cancelled` | a tower run's lifecycle |
| tower | `tower_mode.enter` / `tower_mode.exit` *(store)* | tower mode journal |
| notify | `notify.shown` | the NotifyUser tool surfaced a message (`message`) |
| shellCommand | `shell.started` / `shell.output` / `shell.completed` | a host `!` shell command's lifecycle (`commandId`) |
| undo | `context.undone` | turns were rewound (`agentId`, `turns`, `fromTurnId?`) |
| btw | `btw.created` | a by-the-way side agent was created (`agentId`, `sourceId`) |
| provider-catalog | `model.bound` *(store)* | an agent's model binding changed (`alias`, `thinking`, `turnId`) |
| provider-catalog | `session.model_defaults` *(store)* | the session's default model/thinking changed |
| workspaces | `workspace.created` / `workspace.updated` / `workspace.deleted` / `workspace.trust.changed` | workspace registry and trust changes |
| capabilities | `capability.changed` | a capability install progressed (`id`, `install`) |
| config | `config.changed` | a config value changed (`section`, `value`, `previousValue`, `source`) |
| fileHistory | `file_history.tracked` / `file_history.checkpoint` *(store; no typed union declared)* | file snapshots recorded per turn |

Features not listed here (`usage`, `timing`, `tokenCounting`, `wait-for`,
`edit`, `os`, `media`, `spawn`, `swarm`, `tool-select`, `toolDedupe`,
`sessionInit`, `sessionIndex`, `sessionExport`, `files`, `profiles`,
`models-dev`, `agentsMdReminder`, `dateChange`, `externalHooks`, `ptc`,
`telemetry`, `kimi`) declare no unit events — their state is read through
their facades (see [Facades](facades.md)).

## Gone in the New World

The old harness emitted `agent.switched` (the "current agent" pointer moved)
and `session.feature_missing` (a UI-facing notice that a feature was
absent). Neither exists now:

- there is no ambient "current agent" — address agents explicitly through
  `session.agents` and match events by their enriched `agentId`;
- a missing feature is visible as an **absent facade** — `useInject(Token)`
  is `undefined`, and `sessionFacade` / `agentFacade` return `undefined` —
  not as an event.
