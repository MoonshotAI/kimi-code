/**
 * Workflow runtime: executes a compiled workflow script against an injected
 * subagent host, enforcing concurrency/call/duration limits and cooperative
 * cancellation.
 *
 * SECURITY NOTE: the `node:vm` context is a CONTROL boundary (restricted API,
 * no I/O), not a security sandbox against malicious scripts — scripts pass
 * through explicit user approval before running.
 */
import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';

import { compileWorkflowScript, type ScriptApi } from './script';
import type {
  WorkflowDefinition,
  WorkflowHost,
  WorkflowLimits,
} from './types';
import { WorkflowValidationError } from './validate';

export class WorkflowLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowLimitError';
  }
}

export interface WorkflowRunEvents {
  onPhase?(title: string): void;
  onLog?(message: string): void;
  onAgentCall?(info: {
    index: number;
    label?: string;
    phase?: string;
    state: 'started' | 'ok' | 'refused' | 'error';
  }): void;
}

export interface RunWorkflowOptions {
  args: string;
  host: WorkflowHost;
  limits: WorkflowLimits;
  signal: AbortSignal;
  events?: WorkflowRunEvents;
  filename?: string;
}

export type WorkflowRunResult =
  | { status: 'completed'; result: unknown; agentCalls: number; phase?: string }
  | { status: 'failed'; error: string; agentCalls: number; phase?: string }
  | { status: 'cancelled'; agentCalls: number; phase?: string };

const LOG_MESSAGE_MAX_LENGTH = 2000;

export async function runWorkflowScript(
  definition: WorkflowDefinition,
  options: RunWorkflowOptions,
): Promise<WorkflowRunResult> {
  const { host, limits, events } = options;

  let compiled;
  try {
    compiled = compileWorkflowScript(definition.script, {
      filename: options.filename ?? (definition.path !== '' ? definition.path : `${definition.meta.name}.js`),
      maxScriptBytes: limits.maxScriptBytes,
    });
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      agentCalls: 0,
    };
  }

  // Internal controller: fires on external cancellation, duration ceiling, or
  // a hard limit breach. Host calls all receive this signal.
  const internal = new AbortController();
  let limitFailure: string | undefined;
  let timedOut = false;

  const onExternalAbort = (): void => {
    internal.abort(options.signal.reason);
  };
  if (options.signal.aborted) onExternalAbort();
  else options.signal.addEventListener('abort', onExternalAbort, { once: true });

  const durationTimer = setTimeout(() => {
    timedOut = true;
    internal.abort(new Error('workflow exceeded max duration'));
  }, limits.maxDurationMs);

  let agentCalls = 0;
  let currentPhase: string | undefined;
  let inFlight = 0;
  const waiters: Array<() => void> = [];

  const acquire = async (): Promise<void> => {
    if (inFlight < limits.maxConcurrency) {
      inFlight += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      waiters.push(resolve);
    });
    inFlight += 1;
  };
  const release = (): void => {
    inFlight -= 1;
    const next = waiters.shift();
    if (next !== undefined) next();
  };

  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);

  const api: ScriptApi = {
    args: options.args,
    defineMeta(): void {
      // Runtime mode: the meta assignment is a no-op (already validated at
      // discovery/compile time); execution continues into the body.
    },
    phase(title: unknown): void {
      if (typeof title !== 'string' || title.length === 0) {
        throw new WorkflowValidationError('phase(title) requires a non-empty string');
      }
      currentPhase = title;
      events?.onPhase?.(title);
    },
    log(message: unknown): void {
      const text = String(message).slice(0, LOG_MESSAGE_MAX_LENGTH);
      events?.onLog?.(text);
    },
    async agent(prompt: unknown, rawOpts?: unknown): Promise<unknown> {
      if (typeof prompt !== 'string' || prompt.length === 0) {
        throw new WorkflowValidationError('agent(prompt) requires a non-empty string prompt');
      }
      const opts = parseAgentOptions(rawOpts);
      let validate: ValidateFunction | undefined;
      if (opts.schema !== undefined) {
        try {
          validate = ajv.compile(opts.schema);
        } catch (error) {
          throw new WorkflowValidationError(
            `agent() received an invalid JSON schema: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      agentCalls += 1;
      const index = agentCalls;
      if (agentCalls > limits.maxAgentCalls) {
        // Hard limit: abort the whole run so a script-level try/catch cannot
        // silently swallow the breach.
        limitFailure = `agent call limit exceeded (max ${limits.maxAgentCalls})`;
        internal.abort(new WorkflowLimitError(limitFailure));
        throw new WorkflowLimitError(limitFailure);
      }

      const phase = opts.phase ?? currentPhase;
      const callInfo = { index, label: opts.label, phase };
      events?.onAgentCall?.({ ...callInfo, state: 'started' });

      await acquire();
      try {
        if (internal.signal.aborted) {
          throw abortError(internal.signal);
        }
        const outcome = await host.runAgent(
          {
            prompt,
            label: opts.label,
            phase,
            schemaJson: opts.schema !== undefined ? JSON.stringify(opts.schema) : undefined,
          },
          internal.signal,
        );
        if (outcome.status === 'refused') {
          events?.onAgentCall?.({ ...callInfo, state: 'refused' });
          return null;
        }
        if (outcome.status === 'error') {
          events?.onAgentCall?.({ ...callInfo, state: 'error' });
          throw new Error(outcome.message);
        }
        if (validate === undefined) {
          events?.onAgentCall?.({ ...callInfo, state: 'ok' });
          return outcome.text;
        }
        const parsed = extractJsonFromText(outcome.text);
        if (parsed === undefined) {
          events?.onAgentCall?.({ ...callInfo, state: 'error' });
          throw new Error('agent output did not contain parseable JSON for the requested schema');
        }
        if (!validate(parsed)) {
          events?.onAgentCall?.({ ...callInfo, state: 'error' });
          throw new Error(
            `agent output did not match the requested schema: ${ajv.errorsText(validate.errors)}`,
          );
        }
        events?.onAgentCall?.({ ...callInfo, state: 'ok' });
        // JSON round-trip so host-realm objects never leak into the vm realm.
        return JSON.parse(JSON.stringify(parsed));
      } finally {
        release();
      }
    },
    async parallel(fns: unknown): Promise<unknown[]> {
      if (!Array.isArray(fns) || fns.some((fn) => typeof fn !== 'function')) {
        throw new WorkflowValidationError('parallel(fns) requires an array of functions');
      }
      return Promise.all(fns.map((fn) => Promise.resolve((fn as () => unknown)())));
    },
    async pipeline(items: unknown, ...stages: unknown[]): Promise<unknown[]> {
      if (!Array.isArray(items)) {
        throw new WorkflowValidationError('pipeline(items, ...stages) requires an items array');
      }
      if (stages.length === 0 || stages.some((stage) => typeof stage !== 'function')) {
        throw new WorkflowValidationError('pipeline(items, ...stages) requires at least one stage function');
      }
      const stageFns = stages as Array<(value: unknown) => unknown>;
      // Items flow through their stages independently (no barrier between
      // items); a single item rejection rejects the whole pipeline.
      return Promise.all(
        items.map(async (item) => {
          let value: unknown = item;
          for (const stage of stageFns) {
            value = await stage(value);
            if (value === null || value === undefined) return null;
          }
          return value;
        }),
      );
    },
  };

  const abortPromise = new Promise<never>((_, reject) => {
    if (internal.signal.aborted) {
      reject(abortError(internal.signal));
      return;
    }
    internal.signal.addEventListener(
      'abort',
      () => {
        reject(abortError(internal.signal));
      },
      { once: true },
    );
  });
  // Referenced via Promise.race below; direct rejection is handled there.
  abortPromise.catch(() => {});

  try {
    const result = await Promise.race([compiled.run(api, { syncTimeoutMs: 100 }), abortPromise]);
    // The script may resolve normally even while an abort raced in (e.g. a
    // try/catch swallowed the abort error) — abort verdicts win.
    const verdict = abortVerdict();
    if (verdict !== undefined) return verdict;
    try {
      const serialized: unknown = result === undefined ? undefined : JSON.parse(JSON.stringify(result));
      return { status: 'completed', result: serialized, agentCalls, phase: currentPhase };
    } catch (error) {
      return {
        status: 'failed',
        error: `workflow result is not JSON-serializable: ${error instanceof Error ? error.message : String(error)}`,
        agentCalls,
        phase: currentPhase,
      };
    }
  } catch (error) {
    const verdict = abortVerdict();
    if (verdict !== undefined) return verdict;
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      agentCalls,
      phase: currentPhase,
    };
  } finally {
    clearTimeout(durationTimer);
    options.signal.removeEventListener('abort', onExternalAbort);
  }

  function abortVerdict(): WorkflowRunResult | undefined {
    if (options.signal.aborted) {
      return { status: 'cancelled', agentCalls, phase: currentPhase };
    }
    if (limitFailure !== undefined) {
      return { status: 'failed', error: limitFailure, agentCalls, phase: currentPhase };
    }
    if (timedOut) {
      return { status: 'failed', error: 'workflow exceeded max duration', agentCalls, phase: currentPhase };
    }
    return undefined;
  }
}

interface ParsedAgentOptions {
  label?: string;
  phase?: string;
  schema?: Record<string, unknown>;
}

function parseAgentOptions(rawOpts: unknown): ParsedAgentOptions {
  if (rawOpts === undefined || rawOpts === null) return {};
  if (typeof rawOpts !== 'object' || Array.isArray(rawOpts)) {
    throw new WorkflowValidationError('agent(prompt, opts) requires opts to be an object');
  }
  const opts = rawOpts as Record<string, unknown>;
  const label = opts['label'];
  if (label !== undefined && typeof label !== 'string') {
    throw new WorkflowValidationError('agent() opts.label must be a string');
  }
  const phase = opts['phase'];
  if (phase !== undefined && typeof phase !== 'string') {
    throw new WorkflowValidationError('agent() opts.phase must be a string');
  }
  const schema = opts['schema'];
  if (schema !== undefined && (typeof schema !== 'object' || schema === null || Array.isArray(schema))) {
    throw new WorkflowValidationError('agent() opts.schema must be a JSON Schema object');
  }
  return {
    label,
    phase,
    schema: schema as Record<string, unknown> | undefined,
  };
}

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  if (typeof reason === 'string' && reason.length > 0) return new Error(reason);
  return new Error('workflow aborted');
}

/**
 * Extract a JSON value from agent output text: direct `JSON.parse`, then the
 * first ```json fenced block, then the first balanced `{...}` / `[...]` span.
 * Returns `undefined` when nothing parses.
 */
export function extractJsonFromText(text: string): unknown {
  const direct = tryParseJson(text);
  if (direct !== undefined) return direct;

  const fenceMatch = /```(?:json)?\s*\n([\s\S]*?)```/.exec(text);
  if (fenceMatch?.[1] !== undefined) {
    const fenced = tryParseJson(fenceMatch[1]);
    if (fenced !== undefined) return fenced;
  }

  const balanced = extractFirstBalancedJson(text);
  if (balanced !== undefined) {
    const parsed = tryParseJson(balanced);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text.trim()) as unknown;
  } catch {
    return undefined;
  }
}

function extractFirstBalancedJson(text: string): string | undefined {
  const start = findFirst(text, ['{', '[']);
  if (start === -1) return undefined;
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

function findFirst(text: string, chars: readonly string[]): number {
  let best = -1;
  for (const ch of chars) {
    const index = text.indexOf(ch);
    if (index !== -1 && (best === -1 || index < best)) best = index;
  }
  return best;
}
