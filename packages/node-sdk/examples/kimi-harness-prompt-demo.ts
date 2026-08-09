import { createKimiHarness, type Event, type Session } from '@moonshot-ai/kimi-code-sdk';

import { smokeIdentityFromEnv } from './runtime-smoke-helpers';

const PROMPT =
  process.env['KIMI_SDK_PROMPT'] ??
  'Introduce yourself in two concise sentences and mention the current working directory.';

async function main(): Promise<void> {
  const workDir = process.cwd();
  const harness = createKimiHarness({ identity: smokeIdentityFromEnv() });

  try {
    const config = await harness.getConfig();
    const model = config.defaultModel;
    if (model === undefined) {
      throw new Error('No model configured. Set default_model in config.toml.');
    }

    const session = await harness.createSession({ workDir, model });

    process.stdout.write(`session: ${session.id}\n`);
    process.stdout.write(`workDir: ${session.workDir}\n`);
    process.stdout.write(`config: ${harness.configPath}\n`);
    process.stdout.write(`model: ${model}\n\n`);
    await runPrompt(session, PROMPT);
  } finally {
    await harness.close();
  }
}

async function runPrompt(session: Session, prompt: string): Promise<void> {
  let activeTurnId: number | undefined;
  let unsubscribe: (() => void) | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const done = new Promise<void>((resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error('Timed out waiting for turn_ended'));
    }, 120_000);

    unsubscribe = session.onEvent((event) => {
      handleEvent(event, activeTurnId, (turnId) => {
        activeTurnId = turnId;
      });

      if (event.type === 'session.turn.ended' && event.turn_id === activeTurnId) {
        resolve();
        return;
      }

      if (event.type === 'error') {
        reject(new Error(`${event.code}: ${event.message}`));
      }
    });
  });

  try {
    await Promise.all([session.prompt(prompt), done]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    unsubscribe?.();
  }
}

function handleEvent(
  event: Event,
  activeTurnId: number | undefined,
  setActiveTurnId: (turnId: number) => void,
): void {
  switch (event.type) {
    case 'session.turn.started':
      setActiveTurnId(event.turn_id);
      process.stdout.write(`[turn ${String(event.turn_id)}]\n`);
      break;
    case 'llm.delta':
      if (event.part.type === 'think') {
        if (event.part.think) process.stderr.write(event.part.think);
      } else if (event.part.type === 'text' && event.part.text) {
        process.stdout.write(event.part.text);
      }
      break;
    case 'session.hook.result':
      process.stdout.write(`${event.hook_event} hook\n\n${event.content.trim() || '(empty)'}\n`);
      break;
    case 'session.turn.ended':
      process.stdout.write(`\n\nstatus: ${event.stop_reason}\n`);
      break;
    case 'error':
      process.stderr.write(`\nerror: ${event.code}: ${event.message}\n`);
      break;
    case 'agent.status.updated':
    case 'session.tool.started':
    case 'session.tool.settled':
    case 'session.goal.updated':
    case 'session.task.started':
    case 'session.task.terminated':
    case 'session.usage.updated':
    case 'session.compaction.started':
    case 'session.shell.output':
    case 'llm.step.begin':
    case 'llm.step.end':
    case 'session.meta.updated':
    case 'config.update':
    case 'permission.set_mode':
    case 'turn.steer':
    case 'session.closed':
    case 'warning':
      break;
  }
}

try {
  await main();
} catch (error: unknown) {
  console.error(error);
  process.exitCode = 1;
}
