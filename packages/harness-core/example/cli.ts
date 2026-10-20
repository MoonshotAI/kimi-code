import { join } from 'node:path';
import { createInterface, type Interface } from 'node:readline/promises';

import { createUserEntry } from '@moonshot-ai/agent-core/history/index';
import {
  createUserMessage,
  type AssistantMessage,
  type MediaSource,
} from '@moonshot-ai/agent-core/llm/message';
import type { LoopEmitted, TurnOutcome } from '@moonshot-ai/agent-core/loop/index';
import { MAIN_AGENT_ID } from '@moonshot-ai/agent-core/session/index';

import { interaction, type Interaction } from '#/features/interaction/index';
import { matchCatalogBinding } from '#/features/provider-catalog/index';

import { mountExample, type ExampleProbe } from './app';

export interface CliArgs {
  readonly prompt: string;
  readonly sessionId?: string;
  readonly json: boolean;
}

interface QuestionOption {
  readonly label: string;
  readonly description?: string;
}

interface QuestionItem {
  readonly question: string;
  readonly header?: string;
  readonly options: readonly QuestionOption[];
  readonly multi_select?: boolean;
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
  const { harness, key, dataRoot, probe } = mountExample({ http: false });
  const onSignal = (): void => {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    void harness.close().then(() => process.exit(130));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    await probe.root.ready();
    await waitModelBound(probe, key);
    if (args.sessionId !== undefined && (await harness.app.space.get(args.sessionId)) === undefined) {
      throw new Error(`session ${args.sessionId} does not exist`);
    }
    const session = await harness.app.create(
      args.sessionId === undefined ? {} : { sessionId: args.sessionId },
    );
    const agent = await harness.ensureAgent(session, MAIN_AGENT_ID);
    writeSession({ sessionId: session.id, model: key, store: join(dataRoot, session.id) }, args.json);
    const interactions = probe.interactions(session.id);
    if (interactions === undefined) {
      throw new Error('interaction feature is not installed');
    }
    const promptOut = args.json ? process.stderr : process.stdout;
    const offQuestion = harness.app.on(interaction, 'interaction.requested', (event) => {
      if (event['sessionId'] !== session.id) return;
      const rl = createInterface({ input: process.stdin, output: promptOut });
      void answerInteraction(rl, event.interaction, promptOut)
        .then((response) => {
          interactions.respond(event.interaction.id, response);
        })
        .finally(() => {
          rl.close();
        });
    });
    const offEvents = agent.loop.subscribe((event) => {
      writeDomain(event, args.json);
    });
    const ended = agent.loop.wait('turn.ended');
    agent.loop.submit(
      createUserEntry(createUserMessage(args.prompt), {
        source: 'input',
        origin: { kind: 'user' },
        tracked: true,
      }),
    );
    try {
      const event = await ended;
      if (event.outcome.type !== 'done') {
        if (event.outcome.type === 'aborted') {
          throw new Error('aborted');
        }
        throw new Error(outcomeText(event.outcome));
      }
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
    await harness.close();
  }
}

async function waitModelBound(probe: ExampleProbe, key: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (matchCatalogBinding(key, probe.models()) !== undefined) return;
    if (Date.now() >= deadline) {
      throw new Error(`model '${key}' is not available in the provider catalog`);
    }
    await new Promise((resolvePromise) => {
      setTimeout(resolvePromise, 25);
    });
  }
}

function outcomeText(outcome: TurnOutcome): string {
  if (outcome.type === 'failed') {
    return outcome.error instanceof Error ? outcome.error.message : 'turn failed';
  }
  if (outcome.type === 'blocked') {
    return `blocked at ${outcome.at}`;
  }
  return 'turn failed';
}

async function answerInteraction(
  rl: Interface,
  item: Interaction,
  out: NodeJS.WritableStream,
): Promise<unknown> {
  if (item.kind !== 'question') {
    return { answers: {} };
  }
  const payload = item.payload as { questions?: readonly QuestionItem[] };
  const questions = payload.questions ?? [];
  const answers: Record<string, string> = {};
  for (const question of questions) {
    answers[question.question] = await readAnswer(rl, question, out);
  }
  return { answers };
}

async function readAnswer(
  rl: Interface,
  item: QuestionItem,
  out: NodeJS.WritableStream,
): Promise<string> {
  if (item.header !== undefined && item.header.length > 0) {
    out.write(`${item.header}\n`);
  }
  out.write(`${item.question}\n`);
  item.options.forEach((option, index) => {
    out.write(`${index + 1}. ${option.label}`);
    if (option.description !== undefined && option.description.length > 0) {
      out.write(`  ${option.description}`);
    }
    out.write('\n');
  });
  const line = (await rl.question('> ')).trim();
  if (line.length === 0) {
    return item.options[0]?.label ?? '';
  }
  if (item.multi_select === true) {
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

function writeDomain(event: LoopEmitted, json: boolean): void {
  if (json) {
    writeJson(jsonValue(event));
    return;
  }
  process.stdout.write(`${event.type}\n`);
  if (event.type !== 'message.appended') {
    return;
  }
  const message = event.entry.message;
  if (message.role === 'assistant') {
    writeAssistant(message);
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
    process.stdout.write(`${mediaSourceText(part.source)}\n`);
  }
  for (const call of message.toolCalls) {
    process.stdout.write(`${call.name} ${call.arguments ?? ''}\n`);
  }
  process.stdout.write('\n');
}

function mediaSourceText(source: MediaSource): string {
  switch (source.kind) {
    case 'url':
      return source.url;
    case 'store':
      return `store:${source.ref}`;
    case 'inline':
      return `data:${source.mimeType};base64,${source.data}`;
    case 'file':
      return `file:${source.id}`;
  }
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
