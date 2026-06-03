# /reload 与 /reload-tui 实施计划

> **给执行该计划的 agent：** 必须按任务逐项执行。推荐使用 `superpowers:subagent-driven-development` 或 `superpowers:executing-plans`。所有步骤用 checkbox（`- [ ]`）跟踪完成状态。

**目标：** 新增两个 reload 命令：`/reload-tui` 只重载并应用 `tui.toml`；`/reload` 重载完整 runtime，内部通过 Core 的 `reloadSession({ sessionId })` 重建当前 session runtime 并 resume 同一个 session，同时应用 `tui.toml`。

**架构：** TUI-only reload 留在 TUI 层，不触碰 Core session。完整 runtime reload 由 Core 原子地关闭旧 session runtime、重新读取配置、重建同一个 session 并返回 `ResumeSessionResult`；SDK 保持同一个 `Session` wrapper，并更新 wrapper 内的 resume snapshot；TUI 则重置 UI runtime、刷新 skill commands、重新 hydrate transcript，并应用最新 `tui.toml`。

**技术栈：** TypeScript monorepo、`@moonshot-ai/agent-core`、`@moonshot-ai/kimi-code-sdk`、`apps/kimi-code` TUI、Vitest、oxlint。

---

## 已确定产品语义

### `/reload-tui`

- 只读取并应用 `tui.toml`。
- 不碰 Core。
- 不重建 session。
- 不清 transcript。
- 不影响 MCP / skills / plugins / cron / background。
- 建议 `availability: 'always'`，因为它只改 TUI 本地状态。
- 应用范围：
  - `theme`
  - `editor.command`
  - `notifications.enabled`
  - `notifications.notification_condition`
  - `upgrade.auto_install`

状态文案：

```text
TUI config reloaded: theme, editor, notifications
```

无变化：

```text
TUI config reloaded: no changes
```

### `/reload`

- 重载完整 runtime，并同时应用 `tui.toml`。
- 必须是 `idle-only`。
- 有 active session 时：
  - 先读取 `tui.toml`，失败则不动 runtime；
  - Core 执行 `reloadSession({ sessionId })`；
  - TUI 应用 `tui.toml`；
  - TUI 重置 runtime UI 状态；
  - TUI 刷新 skill slash commands；
  - TUI 重新 hydrate transcript；
  - TUI 重新订阅 session events。
- 没有 active session 时：
  - 重读 Core config；
  - 应用 `tui.toml`；
  - 刷新 TUI available models/providers；
  - 不执行 `reloadSession()`。
- 允许破坏 prompt cache。
- 不需要 skills 后续 reminder / injector。session 被重新 resume 后，新的 system prompt / skills / tools 列表通过正常构造路径进入上下文。
- 当前 model / permission / plan / thinking 不走手写 deferred 提示。它们由 resume replay 和 `refreshSessionRuntimeConfig()` 的现有行为决定。
- 如果当前 model alias 被删，允许现有 fallback 逻辑切到新的 `default_model`，并通过已有 resume warning / TUI 状态体现。
- reload 期间必须停止旧 cron scheduler，但 cron 任务不能丢。新 Agent 构造后会新建 CronManager，resume 时从磁盘重新加载 cron tasks。
- reload 不能按普通 exit 语义杀 background tasks。
- reload 不触发普通 `SessionEnd(exit)` hook。

状态文案：

```text
Runtime reloaded: session resumed with latest config.
```

无 active session：

```text
Runtime config reloaded; no active session.
```

---

## 配置生效模型

| 来源 | `/reload-tui` | `/reload` |
|---|---|---|
| `tui.toml` | 读取并应用 | 读取并应用 |
| `config.toml` providers/models | 不处理 | Core reload 后 resume 新 session runtime |
| `config.toml` default model / thinking / permission / plan | 不处理 | 由 resume replay + existing refresh fallback 决定 |
| `config.toml` skills 配置 | 不处理 | 新 Session 构造时重新 resolve skill roots |
| `mcp.json` | 不处理 | 新 Session 构造时重新 connect MCP |
| plugin state | 不处理 | Core reload 前 `plugins.reload()`，新 Session 构造时读取最新 plugin runtime |
| hooks / permission rules / loopControl / background | 不处理 | 新 Session 构造时用最新 config 注入 |
| services | 不处理 | Core 清空 `runtime` cache 后按最新 config 重建 |

---

## 文件结构

- 修改：`packages/agent-core/src/rpc/core-api.ts`
  - 新增 `ReloadSessionPayload` / `ReloadSessionResult`。
  - `CoreAPI` 新增 `reloadSession(payload)`。
- 修改：`packages/agent-core/src/rpc/core-impl.ts`
  - 实现 `KimiCore.reloadSession()`。
  - reload 前清空按 config 创建的 `this.runtime` cache。
  - reload 前刷新 plugin manager。
- 修改：`packages/agent-core/src/session/index.ts`
  - 新增 reload 专用关闭生命周期 `closeForReload()`。
  - 普通 `close()` 仍保留 exit 语义。
- 修改：`packages/node-sdk/src/types.ts`
  - 导出 `ReloadSessionPayload` / `ReloadSessionResult`。
- 修改：`packages/node-sdk/src/rpc.ts`
  - 新增 `reloadSession(input)`。
- 修改：`packages/node-sdk/src/kimi-harness.ts`
  - 新增 `reloadSession(input)`。
  - 无 active session 的 Core config 重读继续使用 `getConfig({ reload: true })`。
- 修改：`packages/node-sdk/src/session.ts`
  - 新增 `reloadSession()`。
  - reload 后更新当前 wrapper 的 summary / resume state。
  - 不关闭当前 wrapper。
- 新建：`apps/kimi-code/src/tui/commands/reload.ts`
  - `handleReloadCommand()`：实现 `/reload`。
  - `handleReloadTuiCommand()`：实现 `/reload-tui`。
  - `applyReloadedTuiConfig()`：可测试的 TUI config 应用 helper。
- 修改：`apps/kimi-code/src/tui/commands/dispatch.ts`
  - 接入 `/reload` 和 `/reload-tui`。
  - 不补 `invalid` 分支。
- 修改：`apps/kimi-code/src/tui/commands/registry.ts`
  - 注册 `/reload` 为 `idle-only`。
  - 注册 `/reload-tui` 为 `always`。
- 修改：`apps/kimi-code/src/tui/commands/index.ts`
  - 导出新的 reload handlers/helpers。
- 测试：
  - `packages/node-sdk/test/config.test.ts`
  - `packages/agent-core/test/session/cron-stop-on-close.test.ts`
  - `apps/kimi-code/test/tui/config.test.ts`
  - `apps/kimi-code/test/tui/commands/registry.test.ts`
  - `apps/kimi-code/test/tui/kimi-tui-message-flow.test.ts`
  - 必要时新增 `packages/agent-core/test/harness/reload-session.test.ts`

---

## Task 1：Core API 增加 `reloadSession`

- [ ] **Step 1：写失败测试，证明 SDK 期望存在 `session.reloadSession()`**

在 `packages/node-sdk/test/config.test.ts` 增加测试：创建 session，修改 `config.toml`，调用 `session.reloadSession()`，断言同一个 session id 仍可用且 `maxContextTokens` 来自新配置。

核心断言：

```ts
const summary = await session.reloadSession();

expect(summary.id).toBe(session.id);
await expect(session.getStatus()).resolves.toMatchObject({
  model: 'old-model',
  maxContextTokens: 8192,
});
await expect(harness.getConfig()).resolves.toMatchObject({
  defaultModel: 'new-model',
});
```

- [ ] **Step 2：运行测试，确认失败**

```bash
pnpm exec vitest run packages/node-sdk/test/config.test.ts
```

预期：失败，错误类似 `session.reloadSession is not a function`。

- [ ] **Step 3：修改 `packages/agent-core/src/rpc/core-api.ts`**

新增：

```ts
export interface ReloadSessionPayload {
  readonly sessionId: string;
}

export type ReloadSessionResult = ResumeSessionResult;
```

在 `CoreAPI` 增加：

```ts
reloadSession: (payload: ReloadSessionPayload) => ReloadSessionResult;
```

---

## Task 2：实现 `Session.closeForReload()`

- [ ] **Step 1：写失败测试：reload close 会 stop cron，但不触发 exit hook**

在 `packages/agent-core/test/session/cron-stop-on-close.test.ts` 增加：

```ts
it('closeForReload stops cron without running SessionEnd exit hooks', async () => {
  const { session, main } = await createCronSessionForTest('session-cron-reload');
  const stopSpy = vi.spyOn(main.cron!, 'stop');
  const hookSpy = vi.spyOn(session.hookEngine, 'trigger');

  await session.closeForReload();

  expect(stopSpy).toHaveBeenCalledTimes(1);
  expect(hookSpy).not.toHaveBeenCalledWith(
    'SessionEnd',
    expect.objectContaining({ matcherValue: 'exit' }),
  );
});
```

如果该测试文件没有 `createCronSessionForTest()`，按现有 `cron-stop-on-close.test.ts` 的 session 构造方式内联创建 session，不要新增多余 test helper 文件。

- [ ] **Step 2：写失败测试：reload close 不按 exit 策略杀 background**

```ts
it('closeForReload does not stop background tasks through exit policy', async () => {
  const { session, main } = await createCronSessionForTest('session-reload-background');
  const stopAllSpy = vi.spyOn(main.background, 'stopAll');

  await session.closeForReload();

  expect(stopAllSpy).not.toHaveBeenCalledWith('Session closed');
});
```

- [ ] **Step 3：实现 `closeForReload()`**

在 `packages/agent-core/src/session/index.ts` 增加：

```ts
async closeForReload(): Promise<void> {
  try {
    await Promise.allSettled(
      Array.from(this.agents.values(), async (agent) => agent.cron?.stop()),
    );
    await this.flushMetadata();
  } finally {
    try {
      await this.mcp.shutdown();
    } finally {
      await this.logHandle?.close();
    }
  }
}
```

明确不要调用：

```ts
await this.stopBackgroundTasksOnExit();
await this.triggerSessionEnd('exit');
```

---

## Task 3：实现 `KimiCore.reloadSession()`

- [ ] **Step 1：写失败测试**

新增 `packages/agent-core/test/harness/reload-session.test.ts`，覆盖：

- `reloadSession` 返回同一个 session id；
- 新 session runtime 使用最新 `config.toml`；
- 当前 session wrapper 仍可通过 `getConfig({ agentId: 'main' })` 读取到新 model capabilities；
- plugin reload 失败时本次 reload 失败。

- [ ] **Step 2：实现 Core 方法**

在 `packages/agent-core/src/rpc/core-impl.ts` 增加：

```ts
async reloadSession({ sessionId }: ReloadSessionPayload): Promise<ReloadSessionResult> {
  const active = this.sessions.get(sessionId);
  if (active?.hasActiveTurn) {
    throw new KimiError(
      ErrorCodes.SESSION_NOT_IDLE,
      `Session "${sessionId}" cannot be reloaded while a turn is active.`,
      { details: { sessionId } },
    );
  }

  this.reloadProviderManager();
  this.runtime = undefined;

  try {
    await this.pluginsReady;
    await this.plugins.reload();
    this.pluginsLoadError = undefined;
  } catch (error) {
    this.pluginsLoadError = error instanceof Error ? error : new Error(String(error));
    throw new KimiError(
      ErrorCodes.PLUGIN_LOAD_FAILED,
      `Failed to reload plugins: ${this.pluginsLoadError.message}`,
      { cause: error, details: { kimiHomeDir: this.homeDir } },
    );
  }

  if (active !== undefined) {
    await active.closeForReload();
    this.sessions.delete(sessionId);
  }

  return this.resumeSession({ sessionId });
}
```

执行前用 `rg "SESSION_NOT_IDLE|SESSION_BUSY|ACTIVE_TURN" packages/agent-core/src/errors packages/agent-core/src` 确认错误码；如果没有合适错误码，使用现有最接近错误码，不要随意新增兼容错误码。

---

## Task 4：SDK 暴露 `reloadSession()`

- [ ] **Step 1：更新 `packages/node-sdk/src/types.ts`**

导出：

```ts
ReloadSessionPayload,
ReloadSessionResult,
```

- [ ] **Step 2：更新 `packages/node-sdk/src/rpc.ts`**

新增：

```ts
async reloadSession(input: SessionIdRpcInput): Promise<ResumedSessionSummary> {
  const rpc = await this.getRpc();
  return rpc.reloadSession({ sessionId: input.sessionId });
}
```

- [ ] **Step 3：更新 `packages/node-sdk/src/kimi-harness.ts`**

新增：

```ts
async reloadSession(input: ResumeSessionInput): Promise<Session> {
  const id = normalizeSessionId(input.id);
  const session = this.activeSessions.get(id);
  if (session === undefined) {
    return this.resumeSession({ id });
  }
  await session.reloadSession();
  this.trackSessionEvent(session.id, 'session_reload');
  return session;
}
```

- [ ] **Step 4：更新 `packages/node-sdk/src/session.ts`**

把 `summary` / `resumeState` 改成可更新字段：

```ts
summary?: SessionSummary | undefined;
private resumeState: ResumedSessionState | undefined;
```

新增：

```ts
async reloadSession(): Promise<ResumedSessionSummary> {
  this.ensureOpen();
  const summary = await this.rpc.reloadSession({ sessionId: this.id });
  this.summary = summary;
  this.resumeState = resumeStateFromSummary(summary);
  return summary;
}
```

注意：不要 close 当前 SDK wrapper。

---

## Task 5：TUI 实现 `/reload-tui` 和 `/reload`

- [ ] **Step 1：新建 `apps/kimi-code/src/tui/commands/reload.ts`**

导出：

```ts
export async function handleReloadTuiCommand(host: SlashCommandHost): Promise<void>;
export async function handleReloadCommand(host: SlashCommandHost): Promise<void>;
export function applyReloadedTuiConfig(...): TuiReloadResult;
```

- [ ] **Step 2：实现 `/reload-tui`**

行为：

```ts
export async function handleReloadTuiCommand(host: SlashCommandHost): Promise<void> {
  try {
    const tuiConfig = await loadTuiConfig();
    const result = applyReloadedTuiConfig(host, tuiConfig);
    host.showStatus(formatTuiReloadStatus(result));
  } catch (error) {
    host.showError(`Failed to reload TUI config: ${formatErrorMessage(error)}`);
  }
}
```

`/reload-tui` 不创建 spinner也可以；如果保持一致，也可以使用短 spinner。关键是不要触碰 `host.session` 和 `host.harness.getConfig()`。

- [ ] **Step 3：新增 TUI host 方法**

在 `SlashCommandHost` 中新增：

```ts
reloadCurrentSessionView(session: Session): Promise<void>;
```

在 `KimiTUI` 实现：

```ts
async reloadCurrentSessionView(session: Session): Promise<void> {
  this.resetSessionRuntime();
  await this.syncRuntimeState(session);
  this.refreshSessionTitle();
  try {
    await this.refreshSkillCommands(session);
  } catch {
    /* keep the reloaded session usable even if dynamic skills fail */
  }
  this.clearTranscriptAndRedraw();
  try {
    await this.sessionReplay.hydrateFromReplay(session);
  } finally {
    this.sessionEventHandler.startSubscription();
  }
}
```

- [ ] **Step 4：实现 `/reload`**

有 active session：

```ts
export async function handleReloadCommand(host: SlashCommandHost): Promise<void> {
  const spinner = host.showProgressSpinner('Reloading runtime');
  try {
    const tuiConfig = await loadTuiConfig();
    const session = host.session;

    if (session !== undefined) {
      await session.reloadSession();
      await host.reloadCurrentSessionView(session);
      const tui = applyReloadedTuiConfig(host, tuiConfig);
      spinner.stop({ ok: true, label: 'Runtime reloaded' });
      host.showStatus(formatSessionReloadStatus(tui));
      return;
    }

    const config = await host.harness.getConfig({ reload: true });
    host.setAppState({
      availableModels: config.models ?? {},
      availableProviders: config.providers,
    });
    const tui = applyReloadedTuiConfig(host, tuiConfig);
    spinner.stop({ ok: true, label: 'Runtime config reloaded' });
    host.showStatus(formatNoSessionReloadStatus(config, tui));
  } catch (error) {
    spinner.stop({ ok: false, label: 'Reload failed' });
    host.showError(`Failed to reload runtime: ${formatErrorMessage(error)}`);
  }
}
```

文案：

```text
Runtime reloaded: session resumed with latest config.
Runtime config reloaded; no active session.
```

- [ ] **Step 5：注册命令**

`apps/kimi-code/src/tui/commands/registry.ts`：

```ts
{
  name: 'reload',
  aliases: [],
  description: 'Reload runtime config and resume the current session',
  priority: 60,
  availability: 'idle-only',
},
{
  name: 'reload-tui',
  aliases: [],
  description: 'Reload tui.toml without restarting the session',
  priority: 60,
  availability: 'always',
},
```

不要新增旧的 config reload 命令。

- [ ] **Step 6：接入 dispatch**

`apps/kimi-code/src/tui/commands/dispatch.ts`：

```ts
case 'reload':
  await handleReloadCommand(host);
  return;
case 'reload-tui':
  await handleReloadTuiCommand(host);
  return;
```

不要补 `invalid` 分支。

---

## Task 6：测试 TUI 命令行为

- [ ] **Step 1：测试 `/reload-tui` 注册为 always**

`apps/kimi-code/test/tui/commands/registry.test.ts`：

```ts
it('registers reload-tui as always available and reload as idle-only', () => {
  const reload = findBuiltInSlashCommand('reload');
  const reloadTui = findBuiltInSlashCommand('reload-tui');

  expect(resolveSlashCommandAvailability(reload!, '')).toBe('idle-only');
  expect(resolveSlashCommandAvailability(reloadTui!, '')).toBe('always');
});
```

- [ ] **Step 2：测试 `/reload-tui` 只应用 TUI config**

`apps/kimi-code/test/tui/config.test.ts` 保留 `applyReloadedTuiConfig()` 测试，并新增 command-level mock 测试：

```ts
it('reload-tui applies tui.toml without reloading the session', async () => {
  const host = makeReloadCommandHost();
  await handleReloadTuiCommand(host);

  expect(host.session?.reloadSession).not.toHaveBeenCalled();
  expect(host.harness.getConfig).not.toHaveBeenCalled();
  expect(host.showStatus).toHaveBeenCalledWith(expect.stringContaining('TUI config reloaded'));
});
```

- [ ] **Step 3：测试 `/reload` reload session 并 hydrate**

`apps/kimi-code/test/tui/kimi-tui-message-flow.test.ts`：

```ts
it('runs /reload by reloading the active session and hydrating replay', async () => {
  const session = makeSessionMock();
  session.reloadSession = vi.fn(async () => resumedSummaryFixture);
  const host = makeTuiHost({ session });

  dispatchInput(host, '/reload');
  await flushPromises();

  expect(session.reloadSession).toHaveBeenCalledTimes(1);
  expect(host.reloadCurrentSessionView).toHaveBeenCalledWith(session);
  expect(host.showStatus).toHaveBeenCalledWith(
    expect.stringContaining('Runtime reloaded'),
  );
});
```

---

## Task 7：清理旧命名

- [ ] **Step 1：全仓搜索旧命令名**

```bash
rg -n "config-reload|/config-reload|reload-session|/reload-session" packages apps docs
```

预期：没有旧命令名。

- [ ] **Step 2：全仓搜索旧自定义 reload API**

```bash
rg -n "reloadKimiConfig|reloadConfig\\(|ReloadKimiConfig|ConfigReloadApplied|ConfigReloadDeferredItem" packages apps
```

预期：没有旧自定义 reload API；`getConfig({ reload: true })` 可以保留。

---

## Task 8：验证

- [ ] **Step 1：聚焦测试**

```bash
pnpm exec vitest run packages/node-sdk/test/config.test.ts packages/agent-core/test/harness/reload-session.test.ts packages/agent-core/test/session/cron-stop-on-close.test.ts apps/kimi-code/test/tui/config.test.ts apps/kimi-code/test/tui/commands/registry.test.ts apps/kimi-code/test/tui/kimi-tui-message-flow.test.ts apps/kimi-code/test/tui/commands/resolve.test.ts
```

- [ ] **Step 2：typecheck**

```bash
pnpm --filter @moonshot-ai/agent-core run typecheck
pnpm --filter @moonshot-ai/kimi-code-sdk run typecheck
pnpm --filter @moonshot-ai/kimi-code run typecheck
```

- [ ] **Step 3：touched-file lint**

```bash
pnpm exec oxlint --type-aware packages/agent-core/src/rpc/core-api.ts packages/agent-core/src/rpc/core-impl.ts packages/agent-core/src/session/index.ts packages/node-sdk/src/types.ts packages/node-sdk/src/rpc.ts packages/node-sdk/src/kimi-harness.ts packages/node-sdk/src/session.ts apps/kimi-code/src/tui/commands/reload.ts apps/kimi-code/src/tui/commands/dispatch.ts apps/kimi-code/src/tui/commands/registry.ts apps/kimi-code/src/tui/commands/index.ts
```

预期：0 errors。`dispatch.ts` 上既有的 `invalid` exhaustive warning 不在本任务修复范围；如果只剩该 warning，记录但不改。

- [ ] **Step 4：diff check**

```bash
git diff --check
```

---

## 手测方案

1. 修改 `tui.toml` 的 `theme`，执行 `/reload-tui`，确认主题立即变化且 transcript 不清空。
2. 修改 `tui.toml` 的 `editor.command`，执行 `/reload-tui`，再用 Ctrl-G 确认新 editor 生效。
3. 修改 `config.toml` 中当前 model alias 的 `max_context_size`，执行 `/reload`，确认 context 上限变化。
4. 修改 provider `base_url` / `api_key`，执行 `/reload`，下一轮请求应使用新 provider config。
5. 新增一个 skill，执行 `/reload`，确认 slash skill commands 刷新。
6. 删除一个 skill，执行 `/reload`，确认 slash skill commands 移除。
7. 修改 `mcp.json`，执行 `/reload`，确认 MCP 重新连接。
8. 创建 cron job，执行 `/reload`，再让模型调用 `CronList`，确认任务仍存在。
9. streaming 中执行 `/reload`，确认被 idle-only 阻止。
10. streaming 中执行 `/reload-tui`，确认可以应用 TUI config。
11. 故意写坏 plugin state，执行 `/reload`，确认 reload 失败并保留旧 UI session 可见状态。

---

## 风险与处理

- **`/reload-tui` 误触发 session reload。**
  - 处理：`handleReloadTuiCommand()` 不访问 `host.session.reloadSession()`，不访问 `host.harness.getConfig()`。
- **SDK wrapper reload 后仍持旧 resume state。**
  - 处理：`Session.reloadSession()` 必须更新 wrapper 内的 `summary` 和 `resumeState`。
- **旧 wrapper close 误关新 Core session。**
  - 处理：TUI `/reload` 不调用 `setSession()`，不 close wrapper，只在同一 wrapper 上 reload。
- **background task 被 reload 当成 exit 杀掉。**
  - 处理：reload 使用 `closeForReload()`，不调用 `stopBackgroundTasksOnExit()`。
- **cron 停掉后不能恢复。**
  - 处理：cron task 已持久化，旧 CronManager stop 后，新 Agent 构造新 CronManager 并 `loadFromDisk()`。
- **services 仍用旧配置。**
  - 处理：`KimiCore.reloadSession()` 必须 `this.runtime = undefined`。
- **plugin state 没刷新。**
  - 处理：`reloadSession()` 在 resume 前调用 `plugins.reload()`；失败则本次 reload 失败。
- **reload 失败后 session 被删。**
  - 处理：优先 reload config/plugins 这类会失败的步骤，再 close old session；close 后失败时给出明确错误并允许普通 resume 恢复。

---

## 推荐实现顺序

1. Core API 类型。
2. `Session.closeForReload()`。
3. `KimiCore.reloadSession()`。
4. SDK `reloadSession()`。
5. TUI `/reload-tui`。
6. TUI `/reload`。
7. 旧命名清理。
8. 聚焦测试、typecheck、lint。
9. 手测。

---

## 建议 Commit Message

```text
feat(tui): add runtime and tui reload commands
```
