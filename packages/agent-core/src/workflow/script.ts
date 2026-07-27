/**
 * Workflow script compilation and metadata extraction.
 *
 * Script format (own format, no Claude Code compatibility): a JS module whose
 * first significant statement is `export const meta = { ... };`, followed by a
 * top-level body that uses the sandbox API (`args`, `phase()`, `log()`,
 * `agent()`, `parallel()`, `pipeline()`) with top-level `await` and a
 * top-level `return` for the final result.
 *
 * SECURITY NOTE: `node:vm` is a CONTROL boundary (restricted API surface, no
 * I/O, no timers, no dynamic code generation), NOT a security sandbox against
 * actively malicious scripts. Workflow scripts always go through explicit
 * user approval before they run.
 */
import { Buffer } from 'node:buffer';
import vm from 'node:vm';

import { DEFAULT_WORKFLOW_LIMITS, type WorkflowMeta } from './types';
import { WorkflowValidationError, validateWorkflowMeta } from './validate';

/** Host-side bridge the compiled script talks to (via the `__wf` global). */
export interface ScriptApi {
  readonly args: string;
  /** Invoked when the script assigns `export const meta = ...`. */
  defineMeta(value: unknown): void;
  phase(title: unknown): void;
  log(message: unknown): void;
  agent(prompt: unknown, opts?: unknown): Promise<unknown>;
  parallel(fns: unknown): Promise<unknown[]>;
  pipeline(items: unknown, ...stages: unknown[]): Promise<unknown[]>;
}

export interface CompiledWorkflow {
  /**
   * Run the script against the given API bridge in a fresh restricted vm
   * context. `syncTimeoutMs` bounds only the synchronous portions of the
   * execution (`vm` cannot interrupt awaited continuations); the real
   * wall-clock ceiling is enforced by the runtime's duration timer.
   */
  run(api: ScriptApi, opts?: { syncTimeoutMs?: number }): Promise<unknown>;
}

export interface CompileWorkflowScriptOptions {
  filename?: string;
  maxScriptBytes: number;
}

const EXPORT_META_PATTERN = /\bexport\s+const\s+meta\s*=/g;

export function compileWorkflowScript(
  script: string,
  opts: CompileWorkflowScriptOptions,
): CompiledWorkflow {
  const bytes = Buffer.byteLength(script, 'utf8');
  if (bytes > opts.maxScriptBytes) {
    throw new WorkflowValidationError(
      `workflow script is too large: ${bytes} bytes (max ${opts.maxScriptBytes})`,
    );
  }

  const matches = script.match(EXPORT_META_PATTERN);
  if (matches === null || matches.length === 0) {
    throw new WorkflowValidationError(
      "missing export const meta: a workflow script must start with 'export const meta = { ... };'",
    );
  }
  if (matches.length > 1) {
    throw new WorkflowValidationError('workflow script must declare export const meta exactly once');
  }

  // Chained assignment keeps the statement valid JS without needing to close
  // any injected parenthesis; the host-side `meta` setter captures the value.
  const body = script.replace(
    /\bexport\s+const\s+meta\s*=/,
    'const meta = __wf.meta =',
  );
  // Reserved identifiers (args/phase/log/agent/parallel/pipeline) are bound in
  // the prologue; a script redeclaring them fails compilation, by design.
  const wrapped =
    '(async (__wf) => { "use strict";\n' +
    'const args = __wf.args;\n' +
    'const phase = __wf.phase;\n' +
    'const log = __wf.log;\n' +
    'const agent = __wf.agent;\n' +
    'const parallel = __wf.parallel;\n' +
    'const pipeline = __wf.pipeline;\n' +
    `${body}\n})(__wf);`;

  let vmScript: vm.Script;
  try {
    vmScript = new vm.Script(wrapped, { filename: opts.filename ?? 'workflow.js' });
  } catch (error) {
    throw new WorkflowValidationError(
      `workflow script has a syntax error: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  return {
    run(api: ScriptApi, runOpts?: { syncTimeoutMs?: number }): Promise<unknown> {
      const context = createWorkflowVmContext();
      context['__wf'] = createWfBridge(api);
      try {
        const value = vmScript.runInContext(
          context,
          runOpts?.syncTimeoutMs !== undefined ? { timeout: runOpts.syncTimeoutMs } : {},
        );
        return Promise.resolve(value);
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
}

export interface ExtractWorkflowMetaOptions {
  filename?: string;
  maxScriptBytes?: number;
}

/** Sentinel thrown by the metadata-mode `meta` setter to abort execution. */
class MetaCapturedSignal extends Error {
  constructor() {
    super('workflow meta captured');
    this.name = 'MetaCapturedSignal';
  }
}

/**
 * Execute the script in metadata-only mode: the `meta` setter captures and
 * validates the value, then throws a sentinel so the rest of the body never
 * runs; every API function throws if used before the meta export. The capture
 * is synchronous — `export const meta` must be the first significant
 * statement, before any `await`.
 */
export function extractWorkflowMeta(
  script: string,
  opts: ExtractWorkflowMetaOptions = {},
): WorkflowMeta {
  const compiled = compileWorkflowScript(script, {
    filename: opts.filename,
    maxScriptBytes: opts.maxScriptBytes ?? DEFAULT_WORKFLOW_LIMITS.maxScriptBytes,
  });

  let captured: WorkflowMeta | undefined;
  let metaError: Error | undefined;
  let apiUseError: WorkflowValidationError | undefined;
  const rejectApiUse = (): never => {
    const error = new WorkflowValidationError('workflow API used before meta export');
    apiUseError ??= error;
    throw error;
  };

  const api: ScriptApi = {
    args: '',
    defineMeta(value: unknown): void {
      try {
        captured = validateWorkflowMeta(value);
      } catch (error) {
        metaError = error instanceof Error ? error : new Error(String(error));
      }
      throw new MetaCapturedSignal();
    },
    phase: rejectApiUse,
    log: rejectApiUse,
    agent: rejectApiUse,
    parallel: rejectApiUse,
    pipeline: rejectApiUse,
  };

  let promise: Promise<unknown>;
  try {
    promise = compiled.run(api, { syncTimeoutMs: 1000 });
  } catch (error) {
    throw new WorkflowValidationError(
      `workflow meta extraction failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  // The sentinel rejects the wrapper promise; swallow it — extraction is
  // decided by the synchronous capture above.
  promise.catch(() => {});

  if (metaError !== undefined) throw metaError;
  if (captured !== undefined) return captured;
  if (apiUseError !== undefined) throw apiUseError;
  throw new WorkflowValidationError(
    "workflow script did not define meta: 'export const meta = { ... };' must be the first statement (before any await)",
  );
}

/**
 * Fresh restricted vm context. JS intrinsics (Object, Array, Promise, JSON,
 * Math, Date, RegExp, Map/Set, Error types, parseInt/parseFloat, ...) are the
 * context's OWN realm versions — vm contexts always carry them, and we
 * deliberately do NOT shadow them with host-realm copies (that would leak
 * host intrinsics). Node globals are either injected explicitly (URL,
 * TextEncoder/TextDecoder, structuredClone) or masked with `undefined`
 * (process, require, Buffer, fetch, timers, console). `codeGeneration:
 * { strings: false }` disables eval/Function inside the context, so
 * `({}).constructor.constructor('...')` fails too.
 */
function createWorkflowVmContext(): vm.Context {
  const sandbox: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  sandbox['URL'] = URL;
  sandbox['URLSearchParams'] = URLSearchParams;
  sandbox['TextEncoder'] = TextEncoder;
  sandbox['TextDecoder'] = TextDecoder;
  sandbox['structuredClone'] = structuredClone;
  sandbox['console'] = undefined;
  sandbox['process'] = undefined;
  sandbox['require'] = undefined;
  sandbox['module'] = undefined;
  sandbox['exports'] = undefined;
  sandbox['Buffer'] = undefined;
  sandbox['fetch'] = undefined;
  sandbox['setTimeout'] = undefined;
  sandbox['setInterval'] = undefined;
  sandbox['setImmediate'] = undefined;
  sandbox['clearTimeout'] = undefined;
  sandbox['clearInterval'] = undefined;
  sandbox['queueMicrotask'] = undefined;
  sandbox['global'] = undefined;
  return vm.createContext(sandbox, {
    codeGeneration: { strings: false, wasm: false },
  });
}

/**
 * Bridge object exposed as `__wf`. Null prototype so the script cannot walk
 * `__wf.constructor` up into host intrinsics; only bound functions and
 * primitive values are attached.
 */
function createWfBridge(api: ScriptApi): Record<string, unknown> {
  const bridge: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  bridge['args'] = api.args;
  Object.defineProperty(bridge, 'meta', {
    set(value: unknown) {
      api.defineMeta(value);
    },
    get() {
      return undefined;
    },
  });
  bridge['phase'] = (title: unknown) => {
    api.phase(title);
  };
  bridge['log'] = (message: unknown) => {
    api.log(message);
  };
  bridge['agent'] = (prompt: unknown, opts?: unknown) => api.agent(prompt, opts);
  bridge['parallel'] = (fns: unknown) => api.parallel(fns);
  bridge['pipeline'] = (items: unknown, ...stages: unknown[]) => api.pipeline(items, ...stages);
  return bridge;
}
