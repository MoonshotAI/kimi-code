import type { KimiHostIdentity } from '@moonshot-ai/kimi-code-oauth';
import { type KimiHarness, type Session, type Event } from '@moonshot-ai/kimi-code-sdk';

export function smokeIdentityFromEnv(): KimiHostIdentity {
  const version = process.env['KIMI_CODE_SMOKE_VERSION'];
  if (version === undefined || version.trim().length === 0) {
    throw new Error('KIMI_CODE_SMOKE_VERSION is required for Kimi SDK smoke examples.');
  }
  return {
    userAgentProduct: 'kimi-code-cli',
    version,
  };
}

export async function createConfiguredSession(harness: KimiHarness): Promise<Session> {
  const config = await harness.getConfig();
  const model = config.defaultModel;
  if (model === undefined) {
    throw new Error('No model configured. Set default_model in config.toml.');
  }
  return harness.createSession({
    workDir: process.cwd(),
    model,
  });
}

export async function runPromptToEnd(session: Session, prompt: string): Promise<Event> {
  const stream = await startPromptStream(session, prompt, { waitForDelta: false });
  return stream.ended;
}

export interface StartedPromptStream {
  readonly turnId: number;
  readonly ended: Promise<Event>;
}

export async function startPromptAndWaitForDelta(
  session: Session,
  prompt: string,
): Promise<StartedPromptStream> {
  return startPromptStream(session, prompt, { waitForDelta: true });
}

async function startPromptStream(
  session: Session,
  prompt: string,
  options: { readonly waitForDelta: boolean },
): Promise<StartedPromptStream> {
  const watcher = watchPromptStream(session, options.waitForDelta);

  try {
    await session.prompt(prompt);
    const turnId = await watcher.started;
    if (watcher.firstDelta !== undefined) {
      await watcher.firstDelta;
    }
    return { turnId, ended: watcher.ended };
  } catch (error) {
    watcher.dispose();
    throw error;
  }
}

export function waitForSDKEvent(
  session: Session,
  predicate: (event: Event) => boolean,
  timeoutMs = 30_000,
): Promise<Event> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error('Timed out waiting for session event'));
    }, timeoutMs);
    const unsubscribe = session.onEvent((event) => {
      logEvent(event);
      if (event.type === 'error') {
        clearTimeout(timeout);
        unsubscribe();
        reject(new Error(`${event.code}: ${event.message}`));
        return;
      }
      if (!predicate(event)) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(event);
    });
  });
}

interface PromptStreamWatcher {
  readonly started: Promise<number>;
  readonly firstDelta?: Promise<Event> | undefined;
  readonly ended: Promise<Event>;
  dispose(): void;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function watchPromptStream(session: Session, waitForDelta: boolean): PromptStreamWatcher {
  const started = createDeferred<number>();
  const firstDelta = waitForDelta ? createDeferred<Event>() : undefined;
  const ended = createDeferred<Event>();
  let turnId: number | undefined;
  let sawDelta = false;
  let settled = false;
  let unsubscribe: (() => void) | undefined;

  const timeout = setTimeout(() => {
    const error = new Error('Timed out waiting for prompt stream events');
    rejectAll(error);
  }, 120_000);

  const dispose = (): void => {
    clearTimeout(timeout);
    unsubscribe?.();
    unsubscribe = undefined;
  };

  const rejectAll = (error: Error): void => {
    if (settled) return;
    settled = true;
    dispose();
    started.reject(error);
    firstDelta?.reject(error);
    ended.reject(error);
  };

  unsubscribe = session.onEvent((event) => {
    logEvent(event);

    if (event.type === 'error') {
      rejectAll(new Error(`${event.code}: ${event.message}`));
      return;
    }

    if (event.type === 'turn.started' && turnId === undefined) {
      turnId = event.turnId;
      started.resolve(event.turnId);
      return;
    }

    if (turnId === undefined || !hasTurnId(event) || event.turnId !== turnId) {
      return;
    }

    if ((event.type === 'assistant.delta' || event.type === 'thinking.delta') && !sawDelta) {
      sawDelta = true;
      firstDelta?.resolve(event);
      return;
    }

    if (event.type === 'turn.ended') {
      if (firstDelta !== undefined && !sawDelta) {
        firstDelta.reject(new Error('Turn ended before any streaming delta was emitted'));
      }
      ended.resolve(event);
      settled = true;
      dispose();
    }
  });

  return {
    started: started.promise,
    firstDelta: firstDelta?.promise,
    ended: ended.promise,
    dispose,
  };
}

function createDeferred<T>(): Deferred<T> {
  let resolveValue: ((value: T) => void) | undefined;
  let rejectValue: ((error: Error) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolveValue = resolve;
    rejectValue = reject;
  });

  return {
    promise,
    resolve(value: T): void {
      resolveValue?.(value);
    },
    reject(error: Error): void {
      rejectValue?.(error);
    },
  };
}

function hasTurnId(event: Event): event is Event & { readonly turnId: number } {
  return 'turnId' in event;
}

function logEvent(event: Event): void {
  switch (event.type) {
    case 'turn.started':
      process.stdout.write(`[turn ${String(event.turnId)} started]\n`);
      break;
    case 'assistant.delta':
      process.stdout.write(event.delta);
      break;
    case 'hook.result':
      process.stdout.write(`${event.hookEvent} hook\n\n${event.content.trim() || '(empty)'}\n`);
      break;
    case 'thinking.delta':
      process.stderr.write(event.delta);
      break;
    case 'turn.ended':
      process.stdout.write(`\n[turn ${String(event.turnId)} ended: ${event.reason}]\n`);
      break;
    case 'error':
      process.stderr.write(`\nerror: ${event.code}: ${event.message}\n`);
      break;
    case 'agent.status.updated':
    case 'session.meta.updated':
    case 'skill.activated':
    case 'turn.step.started':
    case 'turn.step.completed':
    case 'turn.step.retrying':
    case 'turn.step.interrupted':
    case 'tool.call.delta':
    case 'tool.call.started':
    case 'tool.progress':
    case 'tool.result':
    case 'tool.list.updated':
    case 'mcp.server.status':
    case 'subagent.spawned':
    case 'subagent.completed':
    case 'subagent.failed':
    case 'compaction.started':
    case 'compaction.blocked':
    case 'compaction.cancelled':
    case 'compaction.completed':
    case 'background.task.started':
    case 'background.task.terminated':
      break;
  }
}
