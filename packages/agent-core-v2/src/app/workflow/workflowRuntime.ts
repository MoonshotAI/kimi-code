/**
 * Workflow runtime — Node.js `vm` sandbox + host hooks.
 *
 * Creates a sandboxed context with injected host functions that wrap
 * kimi-code's existing subagent infrastructure. The script runs as an
 * async IIFE — `agent()`, `parallel()`, `pipeline()` primitives compose
 * multi-phase agent work.
 *
 * The sandbox has no access to `require`, `process`, `fs`, or any Node
 * API — only the injected host functions and the `parallel`/`pipeline`/`URL`
 * prelude globals.
 */

import { createHash } from 'node:crypto';
import { join, resolve, isAbsolute } from 'pathe';
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import type { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import type { ISessionSubagentService } from '#/session/subagent/subagent';
import type { ISessionContext } from '#/session/sessionContext/sessionContext';
import type { ILogService } from '#/_base/log/log';
import type { WorkflowRunEntry, AgentOpts } from './workflowTypes';

const MAX_CONCURRENT = Math.min(16, 2 * (navigator?.hardwareConcurrency ?? 4));

/** Simple counting semaphore for agent concurrency control. */
class Semaphore {
  private available: number;
  private readonly waiters: (() => void)[] = [];

  constructor(max: number) {
    this.available = max;
  }

  async acquire(): Promise<() => void> {
    if (this.available <= 0) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.available--;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.available++;
      const next = this.waiters.shift();
      if (next) next();
    };
  }
}

export interface WorkflowRuntimeDeps {
  readonly lifecycle: IAgentLifecycleService;
  readonly subagents: ISessionSubagentService;
  readonly sessionContext: ISessionContext;
  readonly log: ILogService;
  readonly callerAgentId: string;
  readonly workspaceRoot: string;
}

export interface WorkflowRunOptions {
  readonly script: string;
  readonly args?: unknown;
  readonly deps: WorkflowRuntimeDeps;
  readonly entry: WorkflowRunEntry;
  readonly deadlineMs?: number;
}

/** Execute a workflow script in a vm sandbox. */
export async function executeWorkflow(opts: WorkflowRunOptions): Promise<unknown> {
  const { script, args, deps, entry } = opts;
  const deadlineMs = opts.deadlineMs ?? 12 * 60 * 60 * 1000;

  const sem = new Semaphore(MAX_CONCURRENT);
  const workspaceRoot = deps.workspaceRoot;

  // ── Host hooks ────────────────────────────────────────────────

  const agentHook = async (prompt: string, agentOpts?: AgentOpts): Promise<unknown> => {
    if (typeof prompt !== 'string' || prompt.length === 0) return null;
    const release = await sem.acquire();
    try {
      entry.agentCount++;
      const result = await spawnAgent(prompt, agentOpts ?? {}, deps, entry);
      return result;
    } catch (err) {
      deps.log.warn('workflow.agent.failed', {
        label: agentOpts?.label,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    } finally {
      release();
    }
  };

  const phaseHook = (title: string): void => {
    entry.currentPhase = title;
    deps.log.debug('workflow.phase', { runId: entry.runId, phase: title });
  };

  const logHook = (message: string): void => {
    deps.log.debug('workflow.log', { runId: entry.runId, message });
  };

  const readFileHook = async (path: string): Promise<string> => {
    const resolved = resolveInWorkspace(workspaceRoot, path);
    return readFile(resolved, 'utf-8');
  };

  const writeFileHook = async (path: string, content: string): Promise<void> => {
    const resolved = resolveInWorkspace(workspaceRoot, path);
    await writeFile(resolved, content, 'utf-8');
  };

  const globHook = async (pattern: string): Promise<string[]> => {
    // Simple glob: convert pattern to regex
    const regex = globToRegex(pattern);
    const results: string[] = [];
    await walkDir(workspaceRoot, '', (relPath) => {
      if (regex.test(relPath)) results.push(relPath);
    });
    return results;
  };

  const existsHook = async (path: string): Promise<boolean> => {
    try {
      const resolved = resolveInWorkspace(workspaceRoot, path);
      await stat(resolved);
      return true;
    } catch {
      return false;
    }
  };

  // ── Sandbox setup ────────────────────────────────────────────

  const vm = await import('node:vm');

  const sandbox: Record<string, unknown> = {
    agent: agentHook,
    phase: phaseHook,
    log: logHook,
    readFile: readFileHook,
    writeFile: writeFileHook,
    glob: globHook,
    exists: existsHook,
    args,
    parallel: (thunks: (() => Promise<unknown>)[]) =>
      Promise.all(thunks.map((t) => Promise.resolve().then(() => t()))),
    pipeline: <T>(items: T[], ...stages: ((prev: unknown, item: T, index: number) => Promise<unknown>)[]) =>
      Promise.all(
        items.map((item, index) =>
          stages.reduce(
            (acc, stage) => acc.then((prev) => stage(prev, item, index)),
            Promise.resolve(item as unknown),
          ),
        ),
      ),
    URL: MiniURL,
    console: {
      log: logHook,
      warn: logHook,
      error: logHook,
      debug: logHook,
    },
  };

  const context = vm.createContext(sandbox);

  // Wrap script in async IIFE to support `await` at top level.
  const wrappedScript = `(async () => {
${script}
})()`;

  // Set a deadline timer.
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadlinePromise = new Promise<never>((_resolve, reject) => {
    deadlineTimer = setTimeout(() => {
      reject(new Error('Workflow script deadline exceeded'));
    }, deadlineMs);
  });

  try {
    const runPromise = vm.runInContext(wrappedScript, context, {
      timeout: deadlineMs,
      filename: 'workflow.js',
    });

    const result = await Promise.race([runPromise, deadlinePromise]);
    return result;
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }
}

// ── Agent spawning ─────────────────────────────────────────────────

async function spawnAgent(
  prompt: string,
  opts: AgentOpts,
  deps: WorkflowRuntimeDeps,
  entry: WorkflowRunEntry,
): Promise<unknown> {
  const { lifecycle, subagents, sessionContext, callerAgentId } = deps;

  // Build the full prompt — include schema instructions if provided.
  let fullPrompt = prompt;
  if (opts.schema) {
    fullPrompt = `${prompt}\n\nYou MUST respond with a JSON object matching this schema:\n${JSON.stringify(opts.schema, null, 2)}\n\nReturn ONLY the JSON object, no markdown fences, no explanation.`;
  }

  // Create a subagent.
  const handle = await lifecycle.create({
    binding: {
      profile: opts.agentType ?? 'coder',
      model: sessionContext.cwd, // placeholder — will be overridden
      cwd: sessionContext.cwd,
    },
    labels: {
      parentAgentId: callerAgentId,
      workflowRunId: entry.runId,
      ...(opts.label ? { workflowLabel: opts.label } : {}),
    },
  });

  // Run the agent turn.
  const controller = new AbortController();
  const signal = linkSignals(entry.abortController.signal, controller);

  try {
    const runHandle = await subagents.run(
      handle.id,
      { kind: 'prompt', prompt: fullPrompt },
      { signal },
    );

    const { summary } = await runHandle.completion;

    // Parse JSON if schema was provided.
    if (opts.schema) {
      return parseJsonResult(summary);
    }
    return summary;
  } finally {
    // Clean up the subagent.
    await lifecycle.remove(handle.id).catch(() => {});
  }
}

function parseJsonResult(text: string): unknown {
  // Try direct parse.
  try {
    return JSON.parse(text);
  } catch {
    // Try extracting JSON from markdown fences.
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match && match[1]) {
      try {
        return JSON.parse(match[1].trim());
      } catch {
        // fall through
      }
    }
    // Try finding a JSON object in the text.
    const objMatch = text.match(/\{[\s\S]*\}/);
    if (objMatch) {
      try {
        return JSON.parse(objMatch[0]);
      } catch {
        // fall through
      }
    }
    return null;
  }
}

// ── Utilities ─────────────────────────────────────────────────────

function resolveInWorkspace(root: string, path: string): string {
  if (isAbsolute(path) || path.includes('..')) {
    throw new Error(`Path escapes workspace root: ${path}`);
  }
  return resolve(join(root, path));
}

function globToRegex(pattern: string): RegExp {
  let regex = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
  return new RegExp(regex);
}

async function walkDir(
  base: string,
  rel: string,
  fn: (relPath: string) => void,
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(join(base, rel));
  } catch {
    return;
  }
  for (const name of entries) {
    const childRel = rel ? `${rel}/${name}` : name;
    const full = join(base, childRel);
    try {
      const s = await stat(full);
      if (s.isDirectory()) {
        await walkDir(base, childRel, fn);
      } else {
        fn(childRel);
      }
    } catch {
      // skip
    }
  }
}

function linkSignals(parent: AbortSignal, child: AbortController): AbortSignal {
  if (parent.aborted) {
    child.abort(parent.reason);
    return child.signal;
  }
  parent.addEventListener('abort', () => child.abort(parent.reason), { once: true });
  return child.signal;
}

// ── Minimal URL polyfill for sandbox ──────────────────────────────

class MiniURL {
  protocol: string;
  hostname: string;
  pathname: string;
  search: string;
  hash: string;
  href: string;

  constructor(url: string) {
    const match = url.match(/^(\w+):\/\/([^/]+)(\/[^?#]*)?(\?[^#]*)?(#.*)?$/);
    if (!match) throw new TypeError(`Invalid URL: ${url}`);
    this.protocol = `${match[1]}:`;
    this.hostname = match[2]!;
    this.pathname = match[3] ?? '/';
    this.search = match[4] ?? '';
    this.hash = match[5] ?? '';
    this.href = url;
  }

  toString(): string {
    return this.href;
  }
}
