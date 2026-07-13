/**
 * SEA e2e — auto-background on foreground Bash timeout (v2 engine, via klient).
 *
 * Drives the SEA-built kap-server (`kimi server run`, backend v2) over:
 *   - /api/v1 REST mirror: create session, submit prompt, read messages
 *   - /api/v2 typed service proxies (klient): IAgentTaskService assertions
 *
 * Flow: prompt the agent to run `sleep 5` with a 1s foreground Bash timeout.
 * The 1s deadline must move the command to the background (not kill it); the
 * task keeps running and settles as completed once `sleep 5` exits.
 *
 * Run:
 *   KIMI_CODE_EXPERIMENTAL_FLAG=1 KIMI_CODE_EXPERIMENTAL_MULTI_SERVER=1 \
 *     apps/kimi-code/dist-native/bin/darwin-arm64/kimi server run --foreground \
 *     --port 58628 --dangerous-bypass-auth
 *   pnpm -C packages/klient exec tsx examples/sea-e2e-auto-background.ts
 */

import assert from 'node:assert/strict';

import { Klient } from '@moonshot-ai/klient';
import { IAgentTaskService } from '@moonshot-ai/agent-core-v2/agent/task/task';

const BASE = process.env['KIMI_SERVER_URL'] ?? 'http://127.0.0.1:58628';
const client = new Klient({ url: BASE });

const SLEEP_SECONDS = 5;
const TIMEOUT_SECONDS = 1;

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
}

async function v1<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set('content-type', 'application/json');
  const res = await fetch(`${BASE}/api/v1${path}`, {
    ...init,
    headers,
  });
  const env = (await res.json()) as Envelope<T>;
  if (env.code !== 0) throw new Error(`${path} failed: ${JSON.stringify(env)}`);
  return env.data;
}

async function createSession(cwd: string): Promise<string> {
  const data = await v1<{ id: string }>('/sessions', {
    method: 'POST',
    body: JSON.stringify({ metadata: { cwd } }),
  });
  return data.id;
}

interface PromptHandleView {
  prompt_id: string;
  status: string;
}

const MODEL = process.env['KIMI_E2E_MODEL'] ?? 'free-tokens_kimi/coding-model-okapi-0711-vibe';

async function submitPrompt(sessionId: string, text: string): Promise<PromptHandleView> {
  const data = await v1<unknown>(`/sessions/${sessionId}/prompts`, {
    method: 'POST',
    body: JSON.stringify({
      content: [{ type: 'text', text }],
      permission_mode: 'yolo',
      model: MODEL,
    }),
  });
  console.log('  submit response:', JSON.stringify(data).slice(0, 200));
  return data as PromptHandleView;
}

async function pollPrompts(sessionId: string): Promise<readonly PromptHandleView[]> {
  const data = await v1<{
    active?: PromptHandleView | null;
    queued?: readonly PromptHandleView[];
  }>(`/sessions/${sessionId}/prompts`);
  return [...(data.active ? [data.active] : []), ...(data.queued ?? [])];
}

async function sessionStatus(sessionId: string): Promise<string> {
  const data = await v1<{ status: string }>(`/sessions/${sessionId}`);
  return data.status;
}

interface MessageItem {
  role: string;
  content: readonly { type: string; text?: string; output?: unknown }[];
}

async function listMessages(sessionId: string): Promise<readonly MessageItem[]> {
  const data = await v1<{ items: readonly MessageItem[] }>(
    `/sessions/${sessionId}/messages?page_size=100`,
  );
  return data.items;
}

async function waitFor<T>(
  label: string,
  fn: () => Promise<T | undefined>,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined) {
      console.log(`▶ ${label}`);
      return value;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function main(): Promise<void> {
  const taskService = (sessionId: string) =>
    client.session(sessionId).agent('main').service(IAgentTaskService);

  const sessionId = await createSession('/tmp/sea-e2e-auto-background');
  console.log(`▶ session ${sessionId} created (backend: v2, via SEA binary)`);

  try {
    const prompt = await submitPrompt(
      sessionId,
      [
        'Use the Bash tool exactly once with these arguments:',
        `- command: sleep ${String(SLEEP_SECONDS)}`,
        `- timeout: ${String(TIMEOUT_SECONDS)}`,
        'Do NOT set run_in_background. After the tool returns, quote its message field verbatim and stop.',
      ].join('\n'),
    );
    console.log(`▶ prompt ${prompt.prompt_id} submitted (status=${prompt.status})`);

    // 1) The 1s foreground deadline must auto-background the task, not kill it.
    const tasks = taskService(sessionId);
    const detached = await waitFor(
      'task auto-backgrounded (detached, still running)',
      async () => {
        const list = tasks.list(false);
        return list.find(
          (t) => t.kind === 'process' && t.detached === true && t.status === 'running',
        );
      },
      30_000,
    );
    console.log('  task:', JSON.stringify({
      taskId: detached.taskId,
      status: detached.status,
      detached: detached.detached,
      description: detached.description,
    }));
    assert.equal(detached.detached, true, 'task must be detached to the background');
    assert.equal(detached.status, 'running', 'task must still be running after the timeout');

    // 2) The tool result returned immediately with a running background task
    //    (the side-channel "timed out and moved to background" message is
    //    TUI-only; the wire carries the metadata + next_step).
    const toolText = await waitFor(
      'tool result returned a running background task',
      async () => {
        const messages = await listMessages(sessionId);
        const text = messages
          .filter((m) => m.role === 'tool')
          .flatMap((m) => m.content)
          .map((part) =>
            typeof part.output === 'string' ? part.output : (part.text ?? ''),
          )
          .join('\n');
        return text.includes('task_id: bash-') &&
          text.includes('status: running') &&
          text.includes('The task now runs in the background')
          ? text
          : undefined;
      },
      30_000,
    );
    assert.match(toolText, /task_id: bash-/);

    // 3) The backgrounded command keeps running and settles as completed.
    const terminal = await waitFor(
      'backgrounded task completed after sleep exited',
      async () => {
        const info = tasks.getTask(detached.taskId);
        return info?.status === 'completed' ? info : undefined;
      },
      30_000,
    );
    assert.equal(terminal.status, 'completed');
    assert.notEqual(terminal.status, 'timed_out');

    // 4) The agent turn itself finishes (no blocked turn).
    await waitFor(
      'session back to idle',
      async () => {
        const status = await sessionStatus(sessionId);
        const prompts = await pollPrompts(sessionId);
        return status === 'idle' && prompts.length === 0 ? status : undefined;
      },
      60_000,
    );

    console.log('✓ auto-background on foreground Bash timeout works end-to-end on v2 (SEA)');
  } catch (err) {
    // Diagnostics: dump whatever the session produced before giving up.
    try {
      const messages = await listMessages(sessionId);
      console.error('  messages at failure:', JSON.stringify(messages, null, 2).slice(0, 3000));
      const prompts = await pollPrompts(sessionId);
      console.error('  prompts at failure:', JSON.stringify(prompts));
    } catch {
      // ignore diagnostics failure
    }
    throw err;
  } finally {
    try {
      await v1(`/sessions/${sessionId}::archive`, { method: 'POST', body: '{}' });
      console.log(`▶ session ${sessionId} archived`);
    } catch {
      // best effort cleanup
    }
  }
}

main().catch((err) => {
  console.error('✗ e2e failed:', err);
  process.exit(1);
});
