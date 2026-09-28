/**
 * Terminal-level TUI e2e sandbox: the real CLI (run from source through tsx)
 * inside a detached tmux session, pointed at an in-process mock LLM.
 *
 * - A scratch HOME (with KIMI_CODE_HOME inside it) keeps the run away from
 *   the developer's real config, sessions, and legacy kimi-cli data.
 * - The mock serves OpenAI chat completions from a script of steps; requests
 *   without tools (title generation and similar auxiliary calls) get a canned
 *   reply and do not consume the script. Every main request is recorded so a
 *   test can assert what the model was actually sent.
 * - `KIMI_E2E_FRAMES_DIR`, when set, receives a plain-text capture of the
 *   screen at every `frame()` call, for eyeballing a run without a terminal.
 */

import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const APP_ROOT = resolve(import.meta.dirname, '../..');
const TSX = join(APP_ROOT, 'node_modules/.bin/tsx');

export type MockStep =
  | {
      readonly toolCalls: readonly { readonly name: string; readonly args: unknown }[];
      readonly delayMs?: number;
    }
  | { readonly text: string; readonly echoUser?: boolean; readonly delayMs?: number };

export interface RecordedRequest {
  readonly step: number;
  readonly lastUser: string;
  readonly toolResults: readonly string[];
}

interface ChatMessage {
  readonly role: string;
  readonly content?: string | readonly { readonly type: string; readonly text?: string }[] | null;
}

function textOf(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  return (content ?? []).map((part) => part.text ?? '').join('');
}

function lastUserText(messages: readonly ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') return textOf(messages[i]!.content);
  }
  return '';
}

function trailingToolResults(messages: readonly ChatMessage[]): string[] {
  const out: string[] = [];
  for (let i = messages.length - 1; i >= 0 && messages[i]!.role !== 'assistant'; i--) {
    if (messages[i]!.role === 'tool') out.unshift(textOf(messages[i]!.content));
  }
  return out;
}

function sse(delta: unknown, finish: string | null = null): string {
  const chunk = {
    id: 'mock',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'mock',
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

export class MockLlm {
  readonly requests: RecordedRequest[] = [];
  private cursor = 0;

  private constructor(
    private readonly server: Server,
    readonly baseUrl: string,
    private readonly script: readonly MockStep[],
  ) {}

  static async start(script: readonly MockStep[]): Promise<MockLlm> {
    let mock: MockLlm | undefined;
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => {
        raw += chunk.toString('utf8');
      });
      req.on('end', () => {
        mock?.handle(req.method ?? 'GET', raw, res);
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    mock = new MockLlm(server, `http://127.0.0.1:${String(port)}/v1`, script);
    return mock;
  }

  async close(): Promise<void> {
    await new Promise<void>((done) => this.server.close(() => done()));
  }

  private handle(method: string, raw: string, res: import('node:http').ServerResponse): void {
    if (method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock', object: 'model' }] }));
      return;
    }
    const body = (raw.length > 0 ? JSON.parse(raw) : {}) as {
      readonly messages?: readonly ChatMessage[];
      readonly tools?: readonly unknown[];
    };
    const messages = body.messages ?? [];
    if ((body.tools ?? []).length === 0) {
      this.stream(res, { text: 'Mock session' }, messages);
      return;
    }
    const step = this.script[this.cursor] ?? { text: 'Done.' };
    this.requests.push({
      step: this.cursor,
      lastUser: lastUserText(messages),
      toolResults: trailingToolResults(messages),
    });
    this.cursor += 1;
    this.stream(res, step, messages);
  }

  private stream(
    res: import('node:http').ServerResponse,
    step: MockStep,
    messages: readonly ChatMessage[],
  ): void {
    const callIndex = this.cursor;
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      if ('toolCalls' in step) {
        res.write(sse({ role: 'assistant', content: '' }));
        step.toolCalls.forEach((call, index) => {
          res.write(
            sse({
              tool_calls: [
                {
                  index,
                  id: `call_${String(callIndex)}_${String(index)}`,
                  type: 'function',
                  function: { name: call.name, arguments: JSON.stringify(call.args) },
                },
              ],
            }),
          );
        });
        res.write(sse({}, 'tool_calls'));
      } else {
        const text = step.echoUser === true ? `${step.text}${lastUserText(messages)}` : step.text;
        res.write(sse({ role: 'assistant', content: text }));
        res.write(sse({}, 'stop'));
      }
      res.write(
        `data: ${JSON.stringify({
          id: 'mock',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'mock',
          choices: [],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        })}\n\n`,
      );
      res.write('data: [DONE]\n\n');
      res.end();
    }, step.delayMs ?? 0);
  }
}

export async function hasTmux(): Promise<boolean> {
  try {
    await run('tmux', ['-V']);
    return true;
  } catch {
    return false;
  }
}

export interface TuiSandboxOptions {
  readonly name: string;
  readonly mock: MockLlm;
  readonly columns?: number;
  readonly rows?: number;
}

export class TuiSandbox {
  private frameCount = 0;

  private constructor(
    readonly name: string,
    private readonly session: string,
    readonly root: string,
    private readonly framesDir: string | undefined,
  ) {}

  static async launch(options: TuiSandboxOptions): Promise<TuiSandbox> {
    const root = mkdtempSync(join(tmpdir(), `kimi-tui-e2e-${options.name}-`));
    const home = join(root, 'home');
    const work = join(root, 'work');
    mkdirSync(home, { recursive: true });
    mkdirSync(work, { recursive: true });
    const session = `kimi-e2e-${options.name}-${String(process.pid)}`;
    const env = {
      HOME: home,
      KIMI_CODE_HOME: join(home, '.kimi-code'),
      KIMI_MODEL_NAME: 'mock',
      KIMI_MODEL_PROVIDER_TYPE: 'openai',
      KIMI_MODEL_BASE_URL: options.mock.baseUrl,
      KIMI_MODEL_API_KEY: 'test-key',
    };
    const command = [
      'env -u TMUX',
      ...Object.entries(env).map(([key, value]) => `${key}=${JSON.stringify(value)}`),
      JSON.stringify(TSX),
      '--tsconfig',
      JSON.stringify(join(APP_ROOT, 'tsconfig.dev.json')),
      '--import',
      JSON.stringify(join(APP_ROOT, '../../build/register-raw-text-loader.mjs')),
      JSON.stringify(join(APP_ROOT, 'src/main.ts')),
      '--yolo',
      `2>${JSON.stringify(join(root, 'cli.err'))}`,
    ].join(' ');
    await run('tmux', [
      'new-session',
      '-d',
      '-s',
      session,
      '-x',
      String(options.columns ?? 110),
      '-y',
      String(options.rows ?? 34),
      '-c',
      work,
      command,
    ]);
    const framesRoot = process.env['KIMI_E2E_FRAMES_DIR'];
    const framesDir = framesRoot === undefined ? undefined : join(framesRoot, options.name);
    if (framesDir !== undefined) mkdirSync(framesDir, { recursive: true });
    const sandbox = new TuiSandbox(options.name, session, root, framesDir);
    await sandbox.waitForScreen((screen) => screen.includes('Trust this folder?'), 60_000);
    await sandbox.press('C-m');
    await sandbox.waitForScreen((screen) => screen.includes('Model:     mock'), 30_000);
    return sandbox;
  }

  async screen(): Promise<string> {
    const { stdout } = await run('tmux', ['capture-pane', '-p', '-t', this.session]);
    return stdout;
  }

  async press(key: string): Promise<void> {
    await run('tmux', ['send-keys', '-t', this.session, key]);
  }

  /** Types `text` literally and submits it (tmux's `Enter` is not submit here; a raw CR is). */
  async submit(text: string): Promise<void> {
    await run('tmux', ['send-keys', '-t', this.session, '-l', text]);
    await new Promise((done) => setTimeout(done, 200));
    await this.press('C-m');
  }

  async waitForScreen(
    predicate: (screen: string) => boolean,
    timeoutMs = 20_000,
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let last = '';
    while (Date.now() < deadline) {
      last = await this.screen();
      if (predicate(last)) return last;
      await new Promise((done) => setTimeout(done, 200));
    }
    throw new Error(`screen never matched within ${String(timeoutMs)}ms; last screen:\n${last}`);
  }

  async frame(label: string): Promise<string> {
    const screen = await this.screen();
    if (this.framesDir !== undefined) {
      this.frameCount += 1;
      const file = `${String(this.frameCount).padStart(2, '0')}-${label}.txt`;
      writeFileSync(join(this.framesDir, file), screen);
    }
    return screen;
  }

  /** Saves arbitrary text (e.g. what the model was sent) next to the frames. */
  note(label: string, text: string): void {
    if (this.framesDir === undefined) return;
    this.frameCount += 1;
    writeFileSync(join(this.framesDir, `${String(this.frameCount).padStart(2, '0')}-${label}.note.txt`), text);
  }

  /** Starts a goal through `/goal`, accepting the default permission choice. */
  async startGoal(objective: string): Promise<void> {
    await this.submit(`/goal ${objective}`);
    await this.waitForScreen((screen) => screen.includes('Start a goal in'));
    await this.press('C-m');
    await this.waitForScreen((screen) => screen.includes('Goal set'));
  }

  async dispose(): Promise<void> {
    await run('tmux', ['kill-session', '-t', this.session]).catch(() => undefined);
    rmSync(this.root, { recursive: true, force: true });
  }
}
