import type { ComputedRef } from '@moonshot-ai/agent-core/kernel/index';
import type { ContentPart, ToolCall } from '@moonshot-ai/agent-core/llm/message';
import type { ToolDefinition, ToolResult } from '@moonshot-ai/agent-core/tool/index';

import type { AgentRuntime } from '#/runtime/index';

import { createStdoutCapture, runPtcProgram, safeStringify, truncate } from './bridge';
import { renderCatalog } from './catalog';
import { createPtcContext, type PtcContextDeps, type PtcContextLevel } from './context';
import type { PtcToolGuard } from './guards';
import DESCRIPTION from './code.md?raw';

export const CODE_TOOL_NAME = 'Code';

export interface PtcLimits {
  readonly maxToolCalls: number;
  readonly maxOutputBytes: number;
  readonly timeoutMs: number;
}

export const DEFAULT_PTC_LIMITS: PtcLimits = {
  maxToolCalls: 50,
  maxOutputBytes: 32768,
  timeoutMs: 120_000,
};

export interface CreateCodeToolProps {
  readonly runtime: AgentRuntime;
  readonly guards: ComputedRef<readonly PtcToolGuard[]>;
  readonly dir: string;
  readonly agentId: string;
  readonly exclude: ReadonlySet<string>;
  readonly limits: PtcLimits;
  readonly contextLevel: PtcContextLevel;
  readonly contextDeps?: PtcContextDeps;
}

export function createCodeTool(props: CreateCodeToolProps): ToolDefinition {
  let execCounter = 0;
  return {
    name: CODE_TOOL_NAME,
    get description() {
      const catalog = [...props.runtime.tools.values()].filter((tool) => tool.name !== CODE_TOOL_NAME);
      return `${DESCRIPTION.trim()}\n\n${contextSection(props.contextLevel)}\n\n${renderCatalog(catalog, props.exclude)}`;
    },
    parameters: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description:
            'JavaScript code forming the body of an async function. Use await tools.<name>(args) to call tools, console.log(...) to produce output, and return for a final value.',
        },
      },
      required: ['code'],
    },
    async execute(input) {
      const args = JSON.parse(input.toolCall.arguments ?? '{}') as { code?: unknown };
      if (typeof args.code !== 'string' || args.code.trim() === '') {
        return {
          content: [{ type: 'text', text: 'error: parameter `code` must be a non-empty string' }],
          isError: true,
        };
      }
      execCounter += 1;
      const execId = `run-${execCounter}`;
      const controller = new AbortController();
      const onOuterAbort = () => controller.abort(input.signal.reason);
      if (input.signal.aborted) controller.abort(input.signal.reason);
      else input.signal.addEventListener('abort', onOuterAbort, { once: true });
      const timer = setTimeout(
        () => controller.abort(new Error(`Code execution timed out after ${props.limits.timeoutMs}ms`)),
        props.limits.timeoutMs,
      );
      const capture = createStdoutCapture(props.limits.maxOutputBytes);
      let calls = 0;
      const tools: Record<string, (toolArgs: unknown) => Promise<string>> = new Proxy(
        {},
        {
          get: (_target, name) => {
            if (typeof name !== 'string') return undefined;
            return (toolArgs: unknown) =>
              callTool(props, controller.signal, name, toolArgs, {
                next: () => {
                  calls += 1;
                  return calls;
                },
                max: props.limits.maxToolCalls,
                execId,
              });
          },
        },
      );
      try {
        const context = createPtcContext(props.contextLevel, props.contextDeps);
        const outcome = await runPtcProgram({
          dir: props.dir,
          execId: `${props.agentId}-${execId}`,
          code: args.code,
          bridge: {
            tools,
            console: capture.console,
            detach: (text) => input.detach?.(text),
            context,
          },
          signal: controller.signal,
        });
        return { content: [{ type: 'text', text: formatSuccess(capture.read(), outcome.value, props.limits) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const stdout = capture.read();
        const text = stdout === '' ? `error: ${message}` : `error: ${message}\nstdout:\n${stdout}`;
        return { content: [{ type: 'text', text }], isError: true };
      } finally {
        clearTimeout(timer);
        input.signal.removeEventListener('abort', onOuterAbort);
      }
    },
  };
}

async function callTool(
  props: CreateCodeToolProps,
  signal: AbortSignal,
  name: string,
  args: unknown,
  budget: { next(): number; max: number; execId: string },
): Promise<string> {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('aborted');
  const ordinal = budget.next();
  if (ordinal > budget.max) {
    throw new Error(`Code execution exceeded the tool call budget of ${budget.max}`);
  }
  if (props.exclude.has(name) || name === CODE_TOOL_NAME) {
    throw new Error(`tool '${name}' is not callable from ${CODE_TOOL_NAME}`);
  }
  let toolCall: ToolCall = {
    type: 'function',
    id: `ptc-${budget.execId}-${ordinal}`,
    name,
    arguments: JSON.stringify(args ?? {}),
  };
  let result: ToolResult | undefined;
  for (const guard of props.guards.value) {
    const decision = await guard({ toolCall }, signal);
    if (decision === undefined) continue;
    if ('toolCall' in decision) {
      toolCall = decision.toolCall;
      continue;
    }
    result = decision.result ?? {
      content: [{ type: 'text', text: decision.blocked.message ?? decision.blocked.reason }],
      isError: true,
    };
    break;
  }
  if (result === undefined) {
    result = await props.runtime.executor.execute({ toolCall, signal });
    if (isUnknownTool(result, toolCall.name)) throw new Error(`unknown tool: ${toolCall.name}`);
  }
  return textify(result.content);
}

function isUnknownTool(result: ToolResult, name: string): boolean {
  if (result.isError !== true) return false;
  const [part, ...rest] = result.content;
  return rest.length === 0 && part?.type === 'text' && part.text === `unknown tool: ${name}`;
}

function contextSection(level: PtcContextLevel): string {
  if (level === 'none') return '';
  const write =
    level === 'full'
      ? ' You also have write access: useAgentStore().dispatch(events) appends durable feature events, useBlobs().put({ bytes }) stores binary payloads, and useAgent().loop.remind/notify/submit issue agent commands.'
      : '';
  return `Context access: useAgent(), useAgentStore(), useBlobs(), and useSession() return this agent's live facades. await useAgentStore().getState() reads the current agent state (including messages), useBlobs() reads blob payloads, and useAgent().subscribe(listener) subscribes to loop events (subscriptions are removed when your code finishes).${write}`;
}

function textify(content: readonly ContentPart[]): string {
  const lines: string[] = [];
  const text = content
    .filter((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('');
  if (text.length > 0) lines.push(text);
  if (content.some((part) => part.type === 'image_url')) {
    lines.push('(image omitted: tool result converted to plain text)');
  }
  if (content.some((part) => part.type === 'audio_url')) {
    lines.push('(audio omitted: tool result converted to plain text)');
  }
  if (content.some((part) => part.type === 'video_url')) {
    lines.push('(video omitted: tool result converted to plain text)');
  }
  return lines.join('\n');
}

function formatSuccess(stdout: string, value: unknown, limits: PtcLimits): string {
  const sections: string[] = [];
  if (stdout !== '') sections.push(`stdout:\n${truncate(stdout, limits.maxOutputBytes)}`);
  if (value !== undefined) {
    sections.push(`return:\n${truncate(safeStringify(value), limits.maxOutputBytes)}`);
  }
  return sections.length === 0 ? '(no output)' : sections.join('\n\n');
}
