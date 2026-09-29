/**
 * Terminal-level TUI e2e: the real CLI (from source through tsx) in a detached
 * tmux session, with a scratch HOME and a scripted mock LLM.
 *
 * `it(title, scenario(script, body))` does all setup and teardown. The script is a
 * list of model replies built with `bash` / `waitFor` / `say` / `echo` / … ;
 * requests without tools (title generation and similar) get a canned reply and
 * do not consume it. Set `KIMI_E2E_FRAMES_DIR` to keep a text capture of the
 * screen at every labelled `see`.
 */

import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const APP_ROOT = resolve(import.meta.dirname, '../..');

type Step =
  | { readonly calls: readonly { readonly name: string; readonly args: unknown }[]; readonly delayMs?: number }
  | { readonly text: string; readonly echo?: boolean; readonly delayMs?: number }
  | { readonly resolve: (conversation: string) => Reply };

type Reply = Exclude<Step, { readonly resolve: unknown }>;

const call = (name: string, args: unknown): Step => ({ calls: [{ name, args }] });
export const bash = (command: string, description = 'slow build'): Step =>
  call('Bash', { command, run_in_background: true, description });
export const waitFor = (timeout: number): Step => call('WaitFor', { timeout });
export const monitor = (command: string, description = 'ticker'): Step =>
  call('Monitor', { command, description });
export const foreground = (command: string): Step => call('Bash', { command, timeout: 60 });
/** TaskStop on the most recent monitor task id seen in the conversation so far. */
export const stopMonitor = (): Step => ({
  resolve: (conversation) =>
    ({ calls: [{ name: 'TaskStop', args: { task_id: [...conversation.matchAll(/task_id: (monitor-[0-9a-z]+)/g)].at(-1)?.[1] ?? 'none' } }] }),
});
export const completeGoal = (): Step => call('UpdateGoal', { status: 'complete' });
/** A foreground coder subagent; its own requests consume the following script steps. */
export const agent = (prompt: string): Step =>
  call('Agent', { prompt, description: 'helper task', subagent_type: 'coder' });
export const say = (text: string): Step => ({ text });
/** Replies with `prefix` followed by the latest user message. */
export const echo = (prefix: string): Step => ({ text: prefix, echo: true });
export const after = (delayMs: number, step: Step): Step => ({ ...step, delayMs });

interface Message {
  readonly role: string;
  readonly content?: string | readonly { readonly text?: string }[] | null;
}

const textOf = (content: Message['content']): string =>
  typeof content === 'string' ? content : (content ?? []).map((part) => part.text ?? '').join('');

/** What the model was sent on each scripted request. */
export class MockModel {
  readonly sent: { readonly userTexts: readonly string[]; readonly toolResult: string }[] = [];
  /** The latest user message in request `request`. */
  userText(request: number): string {
    return this.sent[request]?.userTexts.at(-1) ?? '';
  }
  /** Every user message sent after the model's previous reply. */
  userTexts(request: number): readonly string[] {
    return this.sent[request]?.userTexts ?? [];
  }
  toolResult(request: number): string {
    return this.sent[request]?.toolResult ?? '';
  }
}

async function startMockModel(script: readonly Step[]) {
  const model = new MockModel();
  const chunk = (payload: object): string =>
    `data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', created: 0, model: 'mock', ...payload })}\n\n`;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (data: Buffer) => (raw += data.toString('utf8')));
    req.on('end', () => {
      const body = (raw ? JSON.parse(raw) : {}) as { messages?: Message[]; tools?: unknown[] };
      const messages = body.messages ?? [];
      const lastUser = textOf(messages.findLast((m) => m.role === 'user')?.content);
      let step: Reply = { text: 'Mock session' };
      if ((body.tools ?? []).length > 0) {
        const sinceReply = messages.slice(messages.findLastIndex((m) => m.role === 'assistant') + 1);
        const texts = (role: string): string[] =>
          sinceReply.filter((m) => m.role === role).map((m) => textOf(m.content));
        const planned = script[model.sent.length] ?? { text: 'Done.' };
        step = 'resolve' in planned ? planned.resolve(messages.map((m) => textOf(m.content)).join('\n')) : planned;
        model.sent.push({ userTexts: texts('user'), toolResult: texts('tool').join('\n') });
      }
      const id = model.sent.length;
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const delta =
          'calls' in step
            ? {
                role: 'assistant',
                tool_calls: step.calls.map((c, index) => ({
                  index,
                  id: `call_${String(id)}_${String(index)}`,
                  type: 'function',
                  function: { name: c.name, arguments: JSON.stringify(c.args) },
                })),
              }
            : { role: 'assistant', content: step.echo === true ? step.text + lastUser : step.text };
        res.write(chunk({ choices: [{ index: 0, delta, finish_reason: null }] }));
        res.write(chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'calls' in step ? 'tool_calls' : 'stop' }] }));
        res.write(chunk({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
        res.end('data: [DONE]\n\n');
      }, step.delayMs ?? 0);
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    model,
    baseUrl: `http://127.0.0.1:${String(port)}/v1`,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

export class Tui {
  private frames = 0;

  constructor(
    private readonly session: string,
    private readonly framesDir: string | undefined,
  ) {}

  screen = async (): Promise<string> =>
    (await run('tmux', ['capture-pane', '-p', '-t', this.session])).stdout;

  press = async (key: string): Promise<void> => {
    await run('tmux', ['send-keys', '-t', this.session, key]);
  };

  /** Types `text` and submits it (a raw CR submits; tmux's `Enter` inserts a newline here). */
  async submit(text: string): Promise<void> {
    await run('tmux', ['send-keys', '-t', this.session, '-l', text]);
    await new Promise((done) => setTimeout(done, 200));
    await this.press('C-m');
  }

  /** Waits until the screen matches, then saves it as a frame when `label` is given. */
  async see(match: string | RegExp, label?: string, timeoutMs = 30_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const screen = await this.screen();
      if (typeof match === 'string' ? screen.includes(match) : match.test(screen)) {
        if (label !== undefined) this.save(label, screen);
        return screen;
      }
      if (Date.now() > deadline) throw new Error(`screen never showed ${String(match)}:\n${screen}`);
      await new Promise((done) => setTimeout(done, 200));
    }
  }

  /** Saves arbitrary text (e.g. what the model was sent) next to the frames. */
  save(label: string, text: string): void {
    if (this.framesDir === undefined) return;
    this.frames += 1;
    writeFileSync(join(this.framesDir, `${String(this.frames).padStart(2, '0')}-${label}.txt`), text);
  }

  /**
   * Cancels any active turn and quits through `/exit`, so the CLI shuts down
   * normally and stops the background tasks it started; killing the tmux
   * session is only the fallback (a dead terminal takes the emergency exit,
   * which leaves them).
   */
  async close(): Promise<void> {
    const alive = (): Promise<boolean> =>
      run('tmux', ['has-session', '-t', this.session]).then(
        () => true,
        () => false,
      );
    // `/exit` only runs when idle: cancel any turn still in flight first.
    await this.press('Escape').catch(() => {});
    await new Promise((done) => setTimeout(done, 500));
    await this.submit('/exit').catch(() => {});
    const deadline = Date.now() + 15_000;
    while ((await alive()) && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 200));
    }
    await run('tmux', ['kill-session', '-t', this.session]).catch(() => {});
  }

  async startGoal(objective: string): Promise<void> {
    await this.submit(`/goal ${objective}`);
    await this.see('Start a goal in');
    await this.press('C-m');
    await this.see('Goal set');
  }
}

async function launchTui(
  name: string,
  baseUrl: string,
  root: string,
  extraEnv: Readonly<Record<string, string>>,
): Promise<Tui> {
  const home = join(root, 'home');
  const work = join(root, 'work');
  mkdirSync(home);
  mkdirSync(work);
  const env = {
    HOME: home,
    KIMI_CODE_HOME: join(home, '.kimi-code'),
    KIMI_MODEL_NAME: 'mock',
    KIMI_MODEL_PROVIDER_TYPE: 'openai',
    KIMI_MODEL_BASE_URL: baseUrl,
    KIMI_MODEL_API_KEY: 'test-key',
    KIMI_DISABLE_TELEMETRY: '1',
    ...extraEnv,
  };
  const argv = [
    join(APP_ROOT, 'node_modules/.bin/tsx'),
    '--tsconfig',
    join(APP_ROOT, 'tsconfig.dev.json'),
    '--import',
    join(APP_ROOT, '../../build/register-raw-text-loader.mjs'),
    join(APP_ROOT, 'src/main.ts'),
    '--yolo',
  ];
  // Drop every inherited KIMI_* variable (e.g. KIMI_SHARE_DIR, which would point
  // legacy-migration detection back at the developer's real data) and TMUX.
  const unset = ['TMUX', ...Object.keys(process.env).filter((key) => key.startsWith('KIMI_'))];
  const command = [
    'env',
    ...unset.map((key) => `-u ${key}`),
    ...Object.entries(env).map(([key, value]) => `${key}=${JSON.stringify(value)}`),
    ...argv.map((arg) => JSON.stringify(arg)),
    `2>${JSON.stringify(join(root, 'cli.err'))}`,
  ].join(' ');
  const session = `kimi-e2e-${name}-${String(process.pid)}`;
  await run('tmux', ['new-session', '-d', '-s', session, '-x', '110', '-y', '34', '-c', work, command]);
  const framesRoot = process.env['KIMI_E2E_FRAMES_DIR'];
  const framesDir = framesRoot === undefined ? undefined : join(framesRoot, name);
  if (framesDir !== undefined) mkdirSync(framesDir, { recursive: true });
  const tui = new Tui(session, framesDir);
  try {
    await tui.see('Trust this folder?', undefined, 60_000);
    await tui.press('C-m');
    await tui.see('Model:     mock');
  } catch (error) {
    await tui.close();
    throw error;
  }
  return tui;
}

export async function hasTmux(): Promise<boolean> {
  return run('tmux', ['-V']).then(
    () => true,
    () => false,
  );
}

/** Body of one e2e test: mock model with `script`, TUI launched against it, torn down after `body`. */
export function scenario(
  script: readonly Step[],
  body: (ctx: { readonly tui: Tui; readonly model: MockModel }) => Promise<void>,
  options: { readonly env?: Readonly<Record<string, string>> } = {},
): (ctx: { readonly task: { readonly name: string } }) => Promise<void> {
  return async ({ task }) => {
    const name = task.name.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').slice(0, 48);
    const mock = await startMockModel(script);
    const root = mkdtempSync(join(tmpdir(), 'kimi-tui-e2e-'));
    try {
      const tui = await launchTui(name, mock.baseUrl, root, options.env ?? {});
      try {
        await body({ tui, model: mock.model });
      } finally {
        await tui.close();
      }
    } finally {
      await mock.close();
      rmSync(root, { recursive: true, force: true });
    }
  };
}

/**
 * A stand-in for a service on a remote host: `GET /status` answers with the
 * current status as plain text, or 503 while the service is down.
 */
export async function startFakeService(initial: string) {
  let status = initial;
  let up = true;
  const server = createServer((_req, res) => {
    if (!up) {
      res.writeHead(503).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' }).end(status);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${String(port)}/status`,
    set(next: string): void {
      status = next;
      up = true;
    },
    down(): void {
      up = false;
    },
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}
