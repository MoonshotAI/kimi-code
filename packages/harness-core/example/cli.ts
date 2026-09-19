import { join } from 'node:path';
import { createInterface, type Interface } from 'node:readline/promises';

import {
  createUserMessage,
  MAIN_AGENT_ID,
  type AssistantMessage,
} from '@moonshot-ai/agent-core';
import type { NodeRef, RuntimeEvent } from '@moonshot-ai/agent-core/kernel/index';

import {
  createOpenedSession,
  InteractionRef,
  OpenSessionRef,
  SessionSpaceRef,
  type Interaction,
  type InteractionRequestedEvent,
  type QuestionItem,
} from '@moonshot-ai/harness-core';

import { mountExample } from './app';

export interface CliArgs {
  readonly prompt: string;
  readonly sessionId?: string;
  readonly json: boolean;
}

export function parseCliArgs(argv: readonly string[]): CliArgs | undefined {
  if (argv.length === 0) {
    return undefined;
  }
  let prompt: string | undefined;
  let sessionId: string | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      continue;
    }
    if (arg === '-p' || arg === '--prompt') {
      prompt = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '-c' || arg === '--session') {
      sessionId = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '-j' || arg === '--json') {
      json = true;
      continue;
    }
    throw new Error(usage());
  }
  if (prompt === undefined || prompt.length === 0) {
    throw new Error(usage());
  }
  if (sessionId !== undefined && sessionId.length === 0) {
    throw new Error(usage());
  }
  return sessionId === undefined ? { prompt, json } : { prompt, sessionId, json };
}

export async function runCli(args: CliArgs): Promise<void> {
  const { app, key, dataRoot } = mountExample({ http: false });
  const onSignal = (): void => {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    void app.disposeAsync().then(() => process.exit(130));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    await app.ready();
    const space = app.node.resolve(SessionSpaceRef);
    if (args.sessionId !== undefined && (await space.get(args.sessionId)) === undefined) {
      throw new Error(`session ${args.sessionId} does not exist`);
    }
    const session = await createOpenedSession(
      app,
      space,
      app.node.resolve(OpenSessionRef),
      args.sessionId === undefined ? {} : { sessionId: args.sessionId },
    );
    const agent = session.get(MAIN_AGENT_ID);
    if (agent === undefined) {
      throw new Error(`agent ${MAIN_AGENT_ID} does not exist`);
    }
    const store = join(dataRoot, session.sessionId);
    writeSession({ sessionId: session.sessionId, model: key, store }, args.json);
    const interactions = session.node.resolve(InteractionRef);
    const promptOut = args.json ? process.stderr : process.stdout;
    const offQuestion = session.node.on('interaction.requested', (event) => {
      const requested = event as InteractionRequestedEvent;
      const rl = createInterface({ input: process.stdin, output: promptOut });
      void answerInteraction(rl, requested.interaction, promptOut)
        .then((response) => {
          interactions.respond(requested.interaction.id, response);
        })
        .finally(() => {
          rl.close();
        });
    });
    const offEvents = session.node.on('*', (event) => {
      writeDomain(event, args.json);
    });
    const finished = waitTurn(session.node);
    agent.submit(createUserMessage(args.prompt), {
      origin: { kind: 'user' },
      tracked: true,
    });
    try {
      await finished;
      await Promise.all(
        interactions.findAll({ resolved: false }).map((item) => interactions.wait(item.id)),
      );
    } finally {
      offQuestion();
      offEvents();
    }
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await app.disposeAsync();
  }
}

async function answerInteraction(
  rl: Interface,
  interaction: Interaction,
  out: NodeJS.WritableStream,
): Promise<unknown> {
  if (interaction.kind !== 'question') {
    return { answers: {} };
  }
  const payload = interaction.payload as { questions?: readonly QuestionItem[] };
  const questions = payload.questions ?? [];
  const answers: Record<string, string> = {};
  for (const item of questions) {
    answers[item.question] = await readAnswer(rl, item, out);
  }
  return { answers };
}

async function readAnswer(
  rl: Interface,
  item: QuestionItem,
  out: NodeJS.WritableStream,
): Promise<string> {
  if (item.header.length > 0) {
    out.write(`${item.header}\n`);
  }
  out.write(`${item.question}\n`);
  item.options.forEach((option, index) => {
    out.write(`${index + 1}. ${option.label}`);
    if (option.description.length > 0) {
      out.write(`  ${option.description}`);
    }
    out.write('\n');
  });
  const line = (await rl.question('> ')).trim();
  if (line.length === 0) {
    return item.options[0]?.label ?? '';
  }
  if (item.multi_select) {
    return line
      .split(',')
      .map((part) => resolveChoice(part.trim(), item) ?? part.trim())
      .filter((part) => part.length > 0)
      .join(', ');
  }
  return resolveChoice(line, item) ?? line;
}

function resolveChoice(line: string, item: QuestionItem): string | undefined {
  const index = Number(line);
  if (Number.isInteger(index) && index >= 1 && index <= item.options.length) {
    return item.options[index - 1]?.label;
  }
  return item.options.find((option) => option.label === line)?.label;
}

function writeSession(
  info: { sessionId: string; model: string; store: string },
  json: boolean,
): void {
  if (json) {
    writeJson({ type: 'session', ...info });
    return;
  }
  process.stdout.write(`session ${info.sessionId}\n`);
  process.stdout.write(`${info.model}\n`);
  process.stdout.write(`${info.store}\n`);
}

function writeDomain(event: RuntimeEvent, json: boolean): void {
  if (json) {
    writeJson(jsonValue(event));
    return;
  }
  process.stdout.write(`${event.type}\n`);
  if (event.type !== 'message.appended') {
    return;
  }
  const entry = event['message'] as { message?: AssistantMessage } | undefined;
  if (entry?.message?.role === 'assistant') {
    writeAssistant(entry.message);
  }
}

function writeAssistant(message: AssistantMessage): void {
  process.stdout.write('assistant\n');
  for (const part of message.content) {
    if (part.type === 'think') {
      process.stdout.write(part.think.endsWith('\n') ? part.think : `${part.think}\n`);
      continue;
    }
    if (part.type === 'text') {
      process.stdout.write(part.text.endsWith('\n') ? part.text : `${part.text}\n`);
      continue;
    }
    if (part.type === 'image_url') {
      process.stdout.write(`${part.imageUrl.url}\n`);
      continue;
    }
    if (part.type === 'audio_url') {
      process.stdout.write(`${part.audioUrl.url}\n`);
      continue;
    }
    process.stdout.write(`${part.videoUrl.url}\n`);
  }
  for (const call of message.toolCalls) {
    process.stdout.write(`${call.name} ${call.arguments ?? ''}\n`);
  }
  process.stdout.write('\n');
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function jsonValue(value: unknown): unknown {
  try {
    return JSON.parse(
      JSON.stringify(value, (_key, item) => {
        if (item instanceof Error) {
          return { name: item.name, message: item.message };
        }
        if (typeof item === 'bigint') {
          return item.toString();
        }
        return item;
      }),
    );
  } catch {
    return { type: typeof value };
  }
}

function usage(): string {
  return 'usage: example -p <prompt> [-c <session-id>] [--json]';
}

function waitTurn(node: NodeRef): Promise<void> {
  return new Promise((resolve, reject) => {
    const off = node.on('turn.ended', (event) => {
      off();
      const outcome = event['outcome'];
      if (outcome === 'done') {
        resolve();
        return;
      }
      if (outcome === 'aborted') {
        reject(new Error('aborted'));
        return;
      }
      reject(new Error(typeof event['errorMessage'] === 'string' ? event['errorMessage'] : 'turn failed'));
    });
  });
}
