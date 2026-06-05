import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import {
  createProvider,
  type ChatProvider,
  type ContentPart,
  type Message,
  type StreamedMessagePart,
  type Tool,
  type ToolCall,
} from '../packages/kosong/src/index.ts';
import {
  createKimiDefaultHeaders,
  KIMI_CODE_FLOW_CONFIG,
  KIMI_CODE_PROVIDER_NAME,
  KimiOAuthToolkit,
  kimiCodeBaseUrl,
  resolveKimiCodeOAuthRef,
} from '../packages/oauth/src/index.ts';

const DEFAULT_WIRE =
  '/Users/moonshot/.kimi-code/sessions/wd_lug-2026-annual-audit_be08e3cd25e2/session_0069f26b-bd7c-498f-aa2a-340362199ef2/agents/agent-1440/wire.jsonl';
const DEFAULT_TARGET_STEP_UUID = 'eb9c6131-61a8-4012-97c5-f48a9c2e19e9';
const DEFAULT_MAX_COMPLETION_TOKENS = 32_000;

type JsonRecord = Record<string, any>;

interface ProjectedContext {
  systemPrompt: string;
  messages: Message[];
  config: {
    modelAlias?: string;
    thinkingLevel?: string;
    cwd?: string;
  };
  stoppedAtLine: number;
}

interface AssistantMessage extends Message {
  content: ContentPart[];
  toolCalls: ToolCall[];
}

function parseArgs(): {
  wirePath: string;
  targetStepUuid: string;
  dropEmptyAssistants: boolean;
  maxCompletionTokens: number;
} {
  const args = process.argv.slice(2);
  let wirePath = DEFAULT_WIRE;
  let targetStepUuid = DEFAULT_TARGET_STEP_UUID;
  let dropEmptyAssistants = false;
  let maxCompletionTokens = DEFAULT_MAX_COMPLETION_TOKENS;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--wire') {
      wirePath = requiredValue(args, ++i, '--wire');
    } else if (arg === '--target-step') {
      targetStepUuid = requiredValue(args, ++i, '--target-step');
    } else if (arg === '--drop-empty-assistants') {
      dropEmptyAssistants = true;
    } else if (arg === '--max-completion-tokens') {
      maxCompletionTokens = Number(requiredValue(args, ++i, '--max-completion-tokens'));
      if (!Number.isInteger(maxCompletionTokens) || maxCompletionTokens <= 0) {
        throw new Error('--max-completion-tokens must be a positive integer');
      }
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { wirePath, targetStepUuid, dropEmptyAssistants, maxCompletionTokens };
}

function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

async function projectWire(input: {
  wirePath: string;
  targetStepUuid: string;
  dropEmptyAssistants: boolean;
}): Promise<ProjectedContext> {
  const text = await readFile(input.wirePath, 'utf8');
  const records = text.split(/\r?\n/).filter(Boolean).map((line, index) => ({
    lineNo: index + 1,
    record: JSON.parse(line) as JsonRecord,
  }));

  const blobsDir = join(dirname(input.wirePath), 'blobs');
  const messages: Message[] = [];
  const openSteps = new Map<string, AssistantMessage>();
  const config: ProjectedContext['config'] = {};
  let systemPrompt = '';
  let stoppedAtLine = records.length;

  for (const { lineNo, record } of records) {
    if (
      record.type === 'context.append_loop_event' &&
      record.event?.type === 'step.begin' &&
      record.event.uuid === input.targetStepUuid
    ) {
      stoppedAtLine = lineNo;
      break;
    }

    if (record.type === 'config.update') {
      if (typeof record.systemPrompt === 'string') systemPrompt = record.systemPrompt;
      if (typeof record.modelAlias === 'string') config.modelAlias = record.modelAlias;
      if (typeof record.thinkingLevel === 'string') config.thinkingLevel = record.thinkingLevel;
      if (typeof record.cwd === 'string') config.cwd = record.cwd;
      continue;
    }

    if (record.type === 'context.append_message') {
      const message = cloneMessage(record.message);
      await rehydrateParts(message.content, blobsDir);
      messages.push(message);
      continue;
    }

    if (record.type !== 'context.append_loop_event') continue;
    const event = record.event;

    if (event.type === 'step.begin') {
      const message: AssistantMessage = {
        role: 'assistant',
        content: [],
        toolCalls: [],
      };
      messages.push(message);
      openSteps.set(event.uuid, message);
      continue;
    }

    if (event.type === 'content.part') {
      const message = openSteps.get(event.stepUuid);
      if (message !== undefined) {
        const part = structuredClone(event.part) as ContentPart;
        await rehydrateParts([part], blobsDir);
        message.content.push(part);
      }
      continue;
    }

    if (event.type === 'tool.call') {
      const message = openSteps.get(event.stepUuid);
      if (message !== undefined) {
        message.toolCalls.push({
          type: 'function',
          id: event.toolCallId,
          name: event.name,
          arguments: typeof event.args === 'string' ? event.args : JSON.stringify(event.args ?? {}),
        });
      }
      continue;
    }

    if (event.type === 'step.end') {
      openSteps.delete(event.uuid);
      continue;
    }

    if (event.type === 'tool.result') {
      const output = event.result?.output;
      const content: ContentPart[] =
        typeof output === 'string'
          ? [{ type: 'text', text: output }]
          : structuredClone(output as ContentPart[]);
      await rehydrateParts(content, blobsDir);
      messages.push({
        role: 'tool',
        content,
        toolCalls: [],
        toolCallId: event.toolCallId,
      });
    }
  }

  return {
    systemPrompt,
    messages: input.dropEmptyAssistants
      ? messages.filter((message) => {
          if (message.role !== 'assistant') return true;
          return message.content.length > 0 || message.toolCalls.length > 0;
        })
      : messages,
    config,
    stoppedAtLine,
  };
}

function cloneMessage(raw: any): Message {
  return {
    role: raw.role,
    name: raw.name,
    content: structuredClone(raw.content ?? []) as ContentPart[],
    toolCalls: structuredClone(raw.toolCalls ?? []) as ToolCall[],
    toolCallId: raw.toolCallId,
    partial: raw.partial,
  };
}

async function rehydrateParts(parts: ContentPart[], blobsDir: string): Promise<void> {
  for (const part of parts) {
    for (const key of ['imageUrl', 'audioUrl', 'videoUrl'] as const) {
      const media = (part as any)[key];
      if (typeof media?.url !== 'string') continue;
      const url = media.url as string;
      if (!url.startsWith('blobref:')) continue;
      media.url = await blobRefToDataUrl(url, blobsDir);
    }
  }
}

async function blobRefToDataUrl(url: string, blobsDir: string): Promise<string> {
  const rest = url.slice('blobref:'.length);
  const semi = rest.indexOf(';');
  if (semi === -1) return url;
  const mimeType = rest.slice(0, semi);
  const hash = rest.slice(semi + 1);
  if (!/^[0-9a-f]{64}$/i.test(hash)) return url;
  const bytes = await readFile(join(blobsDir, hash));
  return `data:${mimeType};base64,${bytes.toString('base64')}`;
}

function summarizeContext(context: ProjectedContext): Record<string, unknown> {
  let textChars = 0;
  let thinkChars = 0;
  let imageParts = 0;
  let toolCalls = 0;
  const roles: Record<string, number> = {};

  for (const message of context.messages) {
    roles[message.role] = (roles[message.role] ?? 0) + 1;
    toolCalls += message.toolCalls.length;
    for (const part of message.content) {
      if (part.type === 'text') textChars += part.text.length;
      if (part.type === 'think') thinkChars += part.think.length;
      if (part.type === 'image_url') imageParts += 1;
    }
  }

  return {
    stoppedAtLine: context.stoppedAtLine,
    config: context.config,
    messageCount: context.messages.length,
    roles,
    textChars,
    thinkChars,
    imageParts,
    toolCalls,
    systemPromptChars: context.systemPrompt.length,
  };
}

function makeTools(): Tool[] {
  return [
    tool('Bash', 'Run a shell command in the current working directory.', {
      command: { type: 'string' },
      description: { type: 'string' },
    }, ['command']),
    tool('Read', 'Read a UTF-8 text file.', { path: { type: 'string' } }, ['path']),
    tool('ReadMediaFile', 'Read an image or video file and return multimodal content.', {
      path: { type: 'string' },
    }, ['path']),
    tool('Glob', 'Find files by glob pattern.', { pattern: { type: 'string' } }, ['pattern']),
    tool('Grep', 'Search file contents.', {
      pattern: { type: 'string' },
      path: { type: 'string' },
    }, ['pattern']),
    tool('Write', 'Create or overwrite a file.', {
      path: { type: 'string' },
      content: { type: 'string' },
    }, ['path', 'content']),
    tool('Edit', 'Edit a file by replacing text.', {
      path: { type: 'string' },
      old_string: { type: 'string' },
      new_string: { type: 'string' },
    }, ['path', 'old_string', 'new_string']),
    tool('WebSearch', 'Search the web.', { query: { type: 'string' } }, ['query']),
    tool('FetchURL', 'Fetch a URL.', { url: { type: 'string' } }, ['url']),
  ];
}

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): Tool {
  return {
    name,
    description,
    parameters: {
      type: 'object',
      properties,
      required,
      additionalProperties: true,
    },
  };
}

async function createKimiProvider(maxCompletionTokens: number): Promise<{
  provider: ChatProvider;
  auth: { apiKey?: string; headers?: Record<string, string> };
}> {
  const homeDir = join(homedir(), '.kimi-code');
  const baseUrl = kimiCodeBaseUrl();
  const oauthRef = resolveKimiCodeOAuthRef({
    oauthHost: KIMI_CODE_FLOW_CONFIG.oauthHost,
    baseUrl,
  });
  const identity = {
    userAgentProduct: 'kimi-code-cli',
    version: '0.9.0',
  };
  const toolkit = new KimiOAuthToolkit({ homeDir, identity });
  const apiKey = await toolkit.ensureFresh(KIMI_CODE_PROVIDER_NAME, { oauthRef });
  let provider = createProvider({
    type: 'kimi',
    model: 'kimi-for-coding',
    baseUrl,
    defaultHeaders: createKimiDefaultHeaders({
      homeDir,
      ...identity,
    }),
  }).withThinking('high');
  provider = provider.withMaxCompletionTokens?.(maxCompletionTokens) ?? provider;
  return { provider, auth: { apiKey } };
}

async function collect(
  provider: ChatProvider,
  context: ProjectedContext,
  tools: Tool[],
  auth: { apiKey?: string; headers?: Record<string, string> },
): Promise<void> {
  const stream = await provider.generate(context.systemPrompt, tools, context.messages, { auth });
  let textChars = 0;
  let thinkChars = 0;
  let toolCalls = 0;
  const samples: string[] = [];
  const partCounts: Record<string, number> = {};

  for await (const part of stream) {
    partCounts[part.type] = (partCounts[part.type] ?? 0) + 1;
    if (part.type === 'text') {
      textChars += part.text.length;
      if (samples.length < 3) samples.push(`text:${part.text.slice(0, 240)}`);
    } else if (part.type === 'think') {
      thinkChars += part.think.length;
      if (samples.length < 3) samples.push(`think:${part.think.slice(0, 240)}`);
    } else if (part.type === 'function') {
      toolCalls += 1;
      if (samples.length < 3) samples.push(`tool:${part.name}(${part.id})`);
    } else {
      if (samples.length < 3) samples.push(`${part.type}:${JSON.stringify(part).slice(0, 240)}`);
    }
  }

  const outcome =
    thinkChars > 0 && textChars === 0 && toolCalls === 0
      ? 'think-only'
      : textChars > 0 || toolCalls > 0
        ? 'normal-output'
        : 'empty';

  console.log(JSON.stringify({
    outcome,
    streamId: stream.id,
    finishReason: stream.finishReason,
    rawFinishReason: stream.rawFinishReason,
    usage: stream.usage,
    partCounts,
    textChars,
    thinkChars,
    toolCalls,
    samples,
  }, null, 2));
}

async function main(): Promise<void> {
  const args = parseArgs();
  const context = await projectWire(args);
  console.log(JSON.stringify({
    script: basename(import.meta.url),
    context: summarizeContext(context),
    options: {
      targetStepUuid: args.targetStepUuid,
      dropEmptyAssistants: args.dropEmptyAssistants,
      maxCompletionTokens: args.maxCompletionTokens,
    },
  }, null, 2));

  const { provider, auth } = await createKimiProvider(args.maxCompletionTokens);
  await collect(provider, context, makeTools(), auth);
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({
    errorName: error instanceof Error ? error.name : undefined,
    errorMessage: error instanceof Error ? error.message : String(error),
    errorStack: error instanceof Error ? error.stack?.split('\n').slice(0, 8) : undefined,
  }, null, 2));
  process.exitCode = 1;
});
