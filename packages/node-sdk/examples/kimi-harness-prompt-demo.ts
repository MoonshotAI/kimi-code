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

      if (event.type === 'turn.ended' && event.turnId === activeTurnId) {
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
    case 'turn.started':
      setActiveTurnId(event.turnId);
      process.stdout.write(`[turn ${String(event.turnId)}]\n`);
      break;
    case 'thinking.delta':
      if (activeTurnId === undefined || event.turnId === activeTurnId) {
        process.stderr.write(event.delta);
      }
      break;
    case 'assistant.delta':
      if (activeTurnId === undefined || event.turnId === activeTurnId) {
        process.stdout.write(event.delta);
      }
      break;
    case 'hook.result':
      if (activeTurnId === undefined || event.turnId === activeTurnId) {
        process.stdout.write(`${event.hookEvent} hook\n\n${event.content.trim() || '(empty)'}\n`);
      }
      break;
    case 'turn.ended':
      if (activeTurnId === undefined || event.turnId === activeTurnId) {
        process.stdout.write(`\n\nstatus: ${event.reason}\n`);
      }
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

try {
  await main();
} catch (error: unknown) {
  console.error(error);
  process.exitCode = 1;
}
