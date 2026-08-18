import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, normalize, basename, dirname } from 'pathe';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { IBashParserService } from '#/app/bashParser/bashParser';
import { BashParserService } from '#/app/bashParser/bashParserService';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import type { ToolCall } from '#/kosong/contract/message';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem, type HostFileStat } from '#/os/interface/hostFileSystem';
import type { RuntimeLease } from '#/runtime/runtime';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import {
  ToolAccesses,
  type ToolAccesses as ToolAccessesType,
} from '#/tool/toolContract';
import type {
  ExecutableTool,
  ExecutableToolContext,
  ExecutableToolResult,
  ToolExecution,
} from '#/tool/toolContract';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { AgentToolExecutorService } from '#/agent/toolExecutor/toolExecutorService';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { AgentToolRegistryService } from '#/agent/toolRegistry/toolRegistryService';
import { IAgentToolResultTruncationService } from '#/agent/toolResultTruncation/toolResultTruncation';
import { ToolResultTruncationService } from '#/agent/toolResultTruncation/toolResultTruncationService';
import { IEventBus } from '#/app/event/eventBus';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IAgentStateService } from '#/agent/state/agentState';
import { profileKey } from '#/agent/profile/profileOps';
import { AgentStateService } from '#/agent/state/agentStateService';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentToolDedupeService } from '#/agent/toolDedupe/toolDedupe';
import { AgentToolDedupeService } from '#/agent/toolDedupe/toolDedupeService';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import type { PromptOrigin } from '#/agent/contextMemory/types';
import { OrderedHookSlot } from '#/hooks';
import { IEventDispatcher } from '#/state/eventDispatcher';
import type { ToolDidExecuteContext } from '#/agent/toolExecutor/toolHooks';
import { IAgentAgentsMdReminderService } from '#/agent/agentsMdReminder/agentsMdReminder';
import { AgentAgentsMdReminderService } from '#/agent/agentsMdReminder/agentsMdReminderService';
import { extractBashTargetDirs } from '#/agent/agentsMdReminder/bashTargets';
import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';
import { stubToolExecutorEvents, type ToolExecutorEventStubs } from '../toolExecutor/stubs';
import { stubLoopWithHooks } from '../loop/stubs';
import { registerLogServices } from '../../_base/log/stubs';

let disposables: DisposableStore;
let homeDir: string;
let workDir: string;

beforeEach(async () => {
  disposables = new DisposableStore();
  homeDir = await mkdtemp(join(tmpdir(), 'kimi-reminder-home-'));
  workDir = await mkdtemp(join(tmpdir(), 'kimi-reminder-work-'));
  await mkdir(join(workDir, '.git'));
});

afterEach(async () => {
  disposables.dispose();
  await rm(homeDir, { recursive: true, force: true });
  await rm(workDir, { recursive: true, force: true });
});

interface CapturedReminder {
  readonly content: string;
  readonly origin: PromptOrigin;
}

interface Harness {
  readonly ix: TestInstantiationService;
  readonly events: ToolExecutorEventStubs;
  readonly reminder: IAgentAgentsMdReminderService;
  readonly dispatcher: IEventDispatcher;
  readonly telemetryEvents: TelemetryRecord[];
  readonly reminders: CapturedReminder[];
}

function createHarness(
  options: {
    readonly withDedupe?: boolean;
    readonly withRealExecutor?: boolean;
    readonly telemetry?: ITelemetryService;
    readonly cwd?: string;
    readonly hostFs?: IHostFileSystem;
    readonly pathClass?: 'posix' | 'win32';
    readonly restoredProfile?: {
      readonly systemPrompt: string;
      readonly agentsMdPaths?: readonly string[];
    };
  } = {},
): Harness {
  const telemetryEvents: TelemetryRecord[] = [];
  const reminders: CapturedReminder[] = [];
  const events = stubToolExecutorEvents();
  const ix = createServices(disposables, {
    additionalServices: (reg) => {
      if (options.withRealExecutor === true) {
        reg.defineInstance(IEventBus, {
          _serviceBrand: undefined,
          publish: () => {},
          subscribe: () => ({ dispose: () => {} }),
        });
        reg.define(IAgentToolRegistryService, AgentToolRegistryService);
        reg.define(IAgentToolExecutorService, AgentToolExecutorService);
        reg.defineInstance(IAgentScopeContext, {
          _serviceBrand: undefined,
          agentId: 'main',
          scope: (sub?: string): string => (sub ? `agents/main/${sub}` : 'agents/main'),
        } satisfies IAgentScopeContext);
        reg.definePartialInstance(IFileSystemStorageService, {
          write: async () => {},
        });
        reg.define(IAgentToolResultTruncationService, ToolResultTruncationService);
        registerLogServices(reg);
      } else {
        reg.defineInstance(IAgentToolExecutorService, events.executor);
      }
      const dispatcher: IEventDispatcher = {
        _serviceBrand: undefined,
        hooks: { onDidRestore: new OrderedHookSlot() },
        dispatch: async () => {},
      } as unknown as IEventDispatcher;
      reg.defineInstance(IEventDispatcher, dispatcher);
      reg.defineInstance(IBootstrapService, { homeDir } as unknown as IBootstrapService);
      const agentState = new AgentStateService();
      agentState.contributeState(profileKey);
      agentState.set(profileKey, {
        thinkingLevel: 'off',
        renderGeneration: 0,
        systemPrompt: options.restoredProfile?.systemPrompt ?? '',
        agentsMdPaths: options.restoredProfile?.agentsMdPaths,
      });
      reg.defineInstance(IAgentStateService, agentState);
      reg.defineInstance(IAgentSystemReminderService, {
        _serviceBrand: undefined,
        appendSystemReminder: (content: string, origin: PromptOrigin) => {
          reminders.push({ content, origin });
          return { role: 'user', content: [], toolCalls: [], origin };
        },
      } satisfies IAgentSystemReminderService);
      reg.defineInstance(ISessionContext, {
        _serviceBrand: undefined,
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        sessionDir: workDir,
        metaScope: 'sessions/workspace-1/session-1',
        cwd: options.cwd ?? workDir,
        scope: (sub?: string): string =>
          sub ? `sessions/workspace-1/session-1/${sub}` : 'sessions/workspace-1/session-1',
      } satisfies ISessionContext);
      const hostFs = options.hostFs ?? new HostFileSystem();
      const hostEnvironment = {
        _serviceBrand: undefined,
        homeDir,
        pathClass: options.pathClass ?? 'posix',
      } as unknown as IHostEnvironment;
      reg.defineInstance(IHostFileSystem, hostFs);
      reg.defineInstance(IHostEnvironment, hostEnvironment);
      reg.defineInstance(IAgentRuntimeService, {
        _serviceBrand: undefined,
        onDidChange: () => ({ dispose: () => {} }),
        isAvailable: () => true,
        inspect() { return this.acquire().runtime; },
        acquire: (): RuntimeLease => ({
          runtime: {
            identity: { workspaceId: 'workspace-1', runtimeId: 'local', generation: 'test' },
            capabilities: new Set(['fs', 'watch', 'process', 'terminal']),
            environment: hostEnvironment,
            path: {
              separator: options.pathClass === 'win32' ? '\\' : '/',
              delimiter: options.pathClass === 'win32' ? ';' : ':',
              isAbsolute: (path: string) => path.startsWith('/') || /^[A-Za-z]:[\\\\]/.test(path),
              join,
              relative: (from: string, to: string) => normalize(to).replace(`${normalize(from)}/`, ''),
              resolve: (...paths: readonly string[]) => normalize(join(...paths)),
              basename: (path: string) => basename(path),
              dirname: (path: string) => dirname(path),
            },
            workspace: { mapRoots: (roots) => roots },
            fs: hostFs,
            status: 'ready',
            onDidChangeStatus: () => ({ dispose: () => {} }),
            dispose: () => {},
          },
          track: (resource) => resource,
          dispose: () => {},
        }),
      } satisfies IAgentRuntimeService);
      reg.defineInstance(IBashParserService, new BashParserService());
      reg.defineInstance(
        ITelemetryService,
        options.telemetry ?? recordingTelemetry(telemetryEvents),
      );
      if (options.withDedupe === true) {
        reg.defineInstance(IAgentLoopService, stubLoopWithHooks());
        reg.define(IAgentToolDedupeService, AgentToolDedupeService);
      }
      reg.define(IAgentAgentsMdReminderService, AgentAgentsMdReminderService);
    },
    strict: true,
  });
  const reminder = ix.get(IAgentAgentsMdReminderService);
  const dispatcher = ix.get(IEventDispatcher);
  return { ix, events, reminder, dispatcher, telemetryEvents, reminders };
}

function didCtx(
  name: string,
  args: unknown,
  options: {
    readonly id?: string;
    readonly result?: ExecutableToolResult;
    readonly preflightRejected?: boolean;
    readonly accesses?: ToolAccessesType;
  } = {},
): ToolDidExecuteContext {
  const toolCall: ToolCall = {
    type: 'function',
    id: options.id ?? `call-${name}-1`,
    name,
    arguments: JSON.stringify(args),
  };
  return {
    turnId: 1,
    signal: new AbortController().signal,
    toolCall,
    toolCalls: [toolCall],
    args,
    tool: options.preflightRejected === true ? undefined : ({} as ExecutableTool),
    outcome: options.preflightRejected === true ? 'preflight-rejected' : 'executed',
    accesses:
      options.preflightRejected === true
        ? undefined
        : options.accesses ?? testAccesses(name, args),
    result: options.result ?? { output: 'original result' },
  };
}

function testAccesses(name: string, args: unknown): ToolAccessesType | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const path = (args as Record<string, unknown>)['path'];
  if (name === 'Read' || name === 'Edit' || name === 'Write') {
    return typeof path === 'string' ? ToolAccesses.readFile(path) : undefined;
  }
  if (name === 'Glob' || name === 'Grep') {
    return ToolAccesses.searchTree(typeof path === 'string' ? path : workDir);
  }
  return undefined;
}

async function fire(h: Harness, ctx: ToolDidExecuteContext): Promise<ExecutableToolResult> {
  await h.events.didExecuteSlot.run(ctx);
  return ctx.result;
}

function outputText(result: ExecutableToolResult): string {
  const output = result.output;
  if (typeof output === 'string') return output;
  return output
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

function reminderText(h: Harness): string {
  return h.reminders.map((entry) => entry.content).join('\n');
}

async function writeAgentsMd(dir: string, content = 'instructions'): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'AGENTS.md');
  await writeFile(path, content, 'utf-8');
  return normalize(path);
}

describe('agentsMdReminder path-carrying tools', () => {
  it('appends a reminder listing the uninjected AGENTS.md when Read touches its directory', async () => {
    const h = createHarness();
    const rootAgentsMd = await writeAgentsMd(workDir, 'root instructions');
    const subDir = join(workDir, 'packages', 'kap-server');
    const subAgentsMd = await writeAgentsMd(subDir, 'package instructions');
    h.reminder.seedInjected([rootAgentsMd], workDir);

    const result = await fire(h, didCtx('Read', { path: join(subDir, 'src', 'index.ts') }));

    expect(outputText(result)).toBe('original result');
    expect(h.reminders).toHaveLength(1);
    expect(h.reminders[0]?.origin).toEqual({ kind: 'injection', variant: 'agents_md' });
    expect(h.reminders[0]?.content.startsWith('The path(s) touched by a recent tool call')).toBe(
      true,
    );
    expect(h.reminders[0]?.content).not.toContain('<system-reminder>');
    const text = reminderText(h);
    expect(text).toContain(subAgentsMd);
    expect(text).not.toContain(rootAgentsMd);
  });

  it('reminds at most once per file', async () => {
    const h = createHarness();
    const subDir = join(workDir, 'packages', 'kap-server');
    const subAgentsMd = await writeAgentsMd(subDir);

    const first = await fire(h, didCtx('Read', { path: join(subDir, 'a.ts') }));
    const second = await fire(h, didCtx('Edit', { path: join(subDir, 'b.ts') }));

    expect(outputText(first)).toBe('original result');
    expect(outputText(second)).toBe('original result');
    expect(h.reminders).toHaveLength(1);
    expect(reminderText(h)).toContain(subAgentsMd);
  });

  it('marks an AGENTS.md known when read directly and never suggests it afterwards', async () => {
    const h = createHarness();
    const subDir = join(workDir, 'packages', 'kap-server');
    const subAgentsMd = await writeAgentsMd(subDir);

    const direct = await fire(h, didCtx('Read', { path: subAgentsMd }));
    expect(outputText(direct)).toBe('original result');
    expect(h.reminders).toHaveLength(0);

    const after = await fire(h, didCtx('Read', { path: join(subDir, 'src', 'index.ts') }));
    expect(outputText(after)).toBe('original result');
    expect(h.reminders).toHaveLength(0);
  });

  it('discovers the .kimi-code/AGENTS.md variant alongside the plain one', async () => {
    const h = createHarness();
    const subDir = join(workDir, 'packages', 'kap-server');
    const dotKimi = normalize(join(subDir, '.kimi-code', 'AGENTS.md'));
    await writeAgentsMd(join(subDir, '.kimi-code'), 'dot kimi instructions');
    const plain = await writeAgentsMd(subDir);

    const result = await fire(h, didCtx('Read', { path: join(subDir, 'index.ts') }));

    expect(outputText(result)).toBe('original result');
    const text = reminderText(h);
    expect(text).toContain(dotKimi);
    expect(text).toContain(plain);
  });

  it('anchors at the nearest existing ancestor when Write targets a not-yet-created directory', async () => {
    const h = createHarness();
    const rootAgentsMd = await writeAgentsMd(workDir, 'root instructions');
    h.reminder.seedInjected([], workDir);

    const result = await fire(
      h,
      didCtx('Write', { path: join(workDir, 'new-pkg', 'src', 'index.ts'), content: 'x' }),
    );

    expect(outputText(result)).toBe('original result');
    expect(reminderText(h)).toContain(rootAgentsMd);
  });

  it('does not remind for seeded paths on the injected chain', async () => {
    const h = createHarness();
    const rootAgentsMd = await writeAgentsMd(workDir, 'root instructions');
    h.reminder.seedInjected([rootAgentsMd], workDir);

    const result = await fire(h, didCtx('Glob', { pattern: '**/*.ts' }));

    expect(outputText(result)).toBe('original result');
    expect(h.reminders).toHaveLength(0);
  });

  it('tracks the shown event through telemetry', async () => {
    const h = createHarness();
    const subDir = join(workDir, 'packages', 'kap-server');
    await writeAgentsMd(subDir);

    await fire(h, didCtx('Read', { path: join(subDir, 'index.ts') }));

    expect(h.telemetryEvents).toHaveLength(1);
    expect(h.telemetryEvents[0]!.event).toBe('agents_md_reminder_shown');
    expect(h.telemetryEvents[0]!.properties).toMatchObject({
      turn_id: 1,
      tool_name: 'Read',
      reminded_count: 1,
    });
  });
});

describe('agentsMdReminder Bash coverage', () => {
  it('reminds for the directory listed by a plain ls', async () => {
    const h = createHarness();
    const subAgentsMd = await writeAgentsMd(join(workDir, 'packages', 'kap-server'));

    const result = await fire(h, didCtx('Bash', { command: 'ls packages/kap-server' }));

    expect(outputText(result)).toBe('original result');
    expect(reminderText(h)).toContain(subAgentsMd);
  });

  it('rebases relative operands across a literal cd', async () => {
    const h = createHarness();
    const subAgentsMd = await writeAgentsMd(join(workDir, 'packages', 'kap-server'));

    const result = await fire(h, didCtx('Bash', { command: 'cd packages && ls kap-server' }));

    expect(outputText(result)).toBe('original result');
    expect(reminderText(h)).toContain(subAgentsMd);
  });

  it('extracts find roots and stops at the expression', async () => {
    const h = createHarness();
    const subAgentsMd = await writeAgentsMd(join(workDir, 'packages', 'kap-server'));

    const result = await fire(
      h,
      didCtx('Bash', { command: "find packages/kap-server -name '*.ts'" }),
    );

    expect(outputText(result)).toBe('original result');
    expect(reminderText(h)).toContain(subAgentsMd);
  });

  it('extracts quoted directory operands', async () => {
    const h = createHarness();
    const subAgentsMd = await writeAgentsMd(join(workDir, 'packages', 'kap-server'));

    const result = await fire(h, didCtx('Bash', { command: 'ls "packages/kap-server"' }));

    expect(outputText(result)).toBe('original result');
    expect(reminderText(h)).toContain(subAgentsMd);
  });

  it('probes an explicit cwd even when the command lists nothing', async () => {
    const h = createHarness();
    const subAgentsMd = await writeAgentsMd(join(workDir, 'packages', 'kap-server'));

    const result = await fire(
      h,
      didCtx('Bash', { command: 'git status', cwd: 'packages/kap-server' }),
    );

    expect(outputText(result)).toBe('original result');
    expect(reminderText(h)).toContain(subAgentsMd);
  });

  it('skips operands that are not statically resolvable', async () => {
    const h = createHarness();
    await writeAgentsMd(join(workDir, 'packages', 'kap-server'));

    for (const command of ['ls $DIR', 'ls *.ts', 'ls $(pwd)', 'echo packages/kap-server']) {
      const result = await fire(h, didCtx('Bash', { command }));
      expect(outputText(result)).toBe('original result');
    }
    expect(h.reminders).toHaveLength(0);
  });
});

describe('agentsMdReminder result shapes and edge cases', () => {
  it('leaves ContentPart[] results untouched and enqueues the reminder', async () => {
    const h = createHarness();
    const subAgentsMd = await writeAgentsMd(join(workDir, 'packages', 'kap-server'));

    const result = await fire(
      h,
      didCtx(
        'Read',
        { path: join(workDir, 'packages', 'kap-server', 'index.ts') },
        { result: { output: [{ type: 'text', text: 'part one' }] } },
      ),
    );

    expect(result.output).toEqual([{ type: 'text', text: 'part one' }]);
    expect(h.reminders).toHaveLength(1);
    expect(reminderText(h)).toContain(subAgentsMd);
  });

  it('does not mark an AGENTS.md known when the direct read failed', async () => {
    const h = createHarness();
    const subDir = join(workDir, 'packages', 'kap-server');
    const agentsMdPath = normalize(join(subDir, 'AGENTS.md'));

    const failed = await fire(
      h,
      didCtx('Read', { path: agentsMdPath }, { result: { output: 'not found', isError: true } }),
    );
    expect(outputText(failed)).toBe('not found');
    expect(h.reminders).toHaveLength(0);

    await writeAgentsMd(subDir);
    const after = await fire(h, didCtx('Read', { path: join(subDir, 'index.ts') }));
    expect(outputText(after)).toBe('original result');
    expect(reminderText(h)).toContain(agentsMdPath);
  });
});

describe('agentsMdReminder duplicate calls', () => {
  it('reminds exactly once for two same-step calls touching the same directory', async () => {
    const h = createHarness();
    const subAgentsMd = await writeAgentsMd(join(workDir, 'packages', 'kap-server'));
    const args = { path: join(workDir, 'packages', 'kap-server', 'index.ts') };

    const first = await fire(h, didCtx('Read', args, { id: 'call-1' }));
    const second = await fire(h, didCtx('Read', args, { id: 'call-2' }));

    expect(outputText(first)).toBe('original result');
    expect(outputText(second)).toBe('original result');
    expect(h.reminders).toHaveLength(1);
    expect(reminderText(h)).toContain(subAgentsMd);
  });

  it('leaves the vetoed placeholder untouched and reminds exactly once on the visible results', async () => {
    const h = createHarness({ withRealExecutor: true, withDedupe: true });
    h.ix.get(IAgentToolDedupeService);
    const subAgentsMd = await writeAgentsMd(join(workDir, 'packages', 'kap-server'));

    class ReadTool implements ExecutableTool<Record<string, unknown>> {
      readonly name = 'Read';
      readonly description = 'Returns file contents.';
      readonly parameters = { type: 'object', additionalProperties: true };
      resolveExecution(args: Record<string, unknown>): ToolExecution {
        return {
          accesses: ToolAccesses.readFile(String(args['path'])),
          approvalRule: this.name,
          execute: async (_ctx: ExecutableToolContext) => ({ output: 'file contents' }),
        };
      }
    }
    h.ix.get(IAgentToolRegistryService).register(new ReadTool());

    const args = { path: join(workDir, 'packages', 'kap-server', 'index.ts') };
    const calls: ToolCall[] = [
      { type: 'function', id: 'call-1', name: 'Read', arguments: JSON.stringify(args) },
      { type: 'function', id: 'call-2', name: 'Read', arguments: JSON.stringify(args) },
    ];
    const results = [];
    for await (const item of h.ix
      .get(IAgentToolExecutorService)
      .execute(calls, { turnId: 1, signal: new AbortController().signal })) {
      results.push(item);
    }

    expect(results).toHaveLength(2);
    for (const item of results) {
      expect(outputText(item.result)).toBe('file contents');
    }
    expect(h.reminders).toHaveLength(1);
    expect(reminderText(h)).toContain(subAgentsMd);
    const shown = h.telemetryEvents.filter((e) => e.event === 'agents_md_reminder_shown');
    expect(shown).toHaveLength(1);
  });
});

describe('agentsMdReminder lazy seeding after a restore', () => {
  it('self-seeds the injected chain on the first touch when no seed point ever fired', async () => {
    const h = createHarness();
    const rootAgentsMd = await writeAgentsMd(workDir, 'root instructions');
    const subAgentsMd = await writeAgentsMd(join(workDir, 'packages', 'kap-server'));

    const result = await fire(
      h,
      didCtx('Read', { path: join(workDir, 'packages', 'kap-server', 'index.ts') }),
    );

    expect(outputText(result)).toBe('original result');
    const text = reminderText(h);
    expect(text).toContain(subAgentsMd);
    expect(text).not.toContain(rootAgentsMd);
  });

  it('treats the brand-home AGENTS.md as injected after a restore', async () => {
    const h = createHarness();
    await writeAgentsMd(homeDir, 'brand instructions');

    const result = await fire(h, didCtx('Read', { path: join(homeDir, 'notes.txt') }));

    expect(outputText(result)).toBe('original result');
    expect(h.reminders).toHaveLength(0);
    expect(h.telemetryEvents).toHaveLength(0);
  });
});

describe('agentsMdReminder persisted restore provenance', () => {
  it('keeps a newly created instruction path eligible after restoring persisted paths', async () => {
    const rootAgentsMd = await writeAgentsMd(workDir, 'root instructions');
    const subDir = join(workDir, 'packages', 'kap-server');
    const subAgentsMd = await writeAgentsMd(subDir, 'package instructions');
    const h = createHarness({
      restoredProfile: {
        systemPrompt: `<!-- From: ${rootAgentsMd} -->\nroot instructions`,
        agentsMdPaths: [rootAgentsMd],
      },
    });

    await h.dispatcher.hooks.onDidRestore.run({});
    const result = await fire(h, didCtx('Read', { path: join(subDir, 'index.ts') }));

    expect(outputText(result)).toBe('original result');
    expect(reminderText(h)).toContain(subAgentsMd);
  });

  it('recovers injected paths from a legacy restored prompt without path provenance', async () => {
    const rootAgentsMd = await writeAgentsMd(workDir, 'root instructions');
    const h = createHarness({
      restoredProfile: {
        systemPrompt: `<!-- From: ${rootAgentsMd} -->\nroot instructions`,
      },
    });

    await h.dispatcher.hooks.onDidRestore.run({});
    const result = await fire(h, didCtx('Read', { path: join(workDir, 'index.ts') }));

    expect(outputText(result)).toBe('original result');
    expect(h.reminders).toHaveLength(0);
  });
});

describe('agentsMdReminder Bash operand hygiene', () => {
  it('does not treat option arguments as directories', async () => {
    const h = createHarness();
    const eighty = await writeAgentsMd(join(workDir, '80'), 'eighty instructions');
    const subAgentsMd = await writeAgentsMd(join(workDir, 'packages', 'kap-server'));

    const result = await fire(h, didCtx('Bash', { command: 'ls -w 80 packages/kap-server' }));

    expect(outputText(result)).toBe('original result');
    const text = reminderText(h);
    expect(text).toContain(subAgentsMd);
    expect(text).not.toContain(eighty);
  });

  it('collects find roots past its global options', async () => {
    const h = createHarness();
    const subAgentsMd = await writeAgentsMd(join(workDir, 'packages', 'kap-server'));

    const result = await fire(
      h,
      didCtx('Bash', { command: "find -L packages/kap-server -name '*.ts'" }),
    );

    expect(outputText(result)).toBe('original result');
    expect(reminderText(h)).toContain(subAgentsMd);
  });
});

describe('agentsMdReminder probing boundaries', () => {
  it('ignores an empty AGENTS.md just like the init-time load', async () => {
    const h = createHarness();
    const subDir = join(workDir, 'packages', 'kap-server');
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, 'AGENTS.md'), '', 'utf-8');

    const result = await fire(h, didCtx('Read', { path: join(subDir, 'index.ts') }));

    expect(outputText(result)).toBe('original result');
    expect(h.reminders).toHaveLength(0);
  });

  it('still reminds when the triggering call ended in an error result', async () => {
    const h = createHarness();
    const subDir = join(workDir, 'packages', 'kap-server');
    const subAgentsMd = await writeAgentsMd(subDir);

    const result = await fire(
      h,
      didCtx('Read', { path: join(subDir, 'missing.ts') }, {
        result: { output: 'not found', isError: true },
      }),
    );

    expect(outputText(result)).toBe('not found');
    expect(reminderText(h)).toContain(subAgentsMd);
  });

  it('marks an AGENTS.md known when it is written directly', async () => {
    const h = createHarness();
    const subDir = join(workDir, 'packages', 'kap-server');
    await mkdir(subDir, { recursive: true });
    const agentsMdPath = normalize(join(subDir, 'AGENTS.md'));

    const written = await fire(h, didCtx('Write', { path: agentsMdPath, content: 'x' }));
    expect(outputText(written)).toBe('original result');
    expect(h.reminders).toHaveLength(0);

    const after = await fire(h, didCtx('Read', { path: join(subDir, 'index.ts') }));
    expect(outputText(after)).toBe('original result');
    expect(h.reminders).toHaveLength(0);
  });

  it('reminds at most once for two parallel touches of the same directory', async () => {
    const h = createHarness();
    const subDir = join(workDir, 'packages', 'kap-server');
    await writeAgentsMd(subDir);

    const [first, second] = await Promise.all([
      fire(h, didCtx('Read', { path: join(subDir, 'a.ts') }, { id: 'call-a' })),
      fire(h, didCtx('Read', { path: join(subDir, 'b.ts') }, { id: 'call-b' })),
    ]);

    expect(outputText(first)).toBe('original result');
    expect(outputText(second)).toBe('original result');
    expect(h.reminders).toHaveLength(1);
  });

  it('re-judges the project root at a nested repository', async () => {
    const h = createHarness();
    const nested = join(workDir, 'packages', 'nested');
    await mkdir(join(nested, '.git'), { recursive: true });
    const rootAgentsMd = await writeAgentsMd(workDir, 'outer instructions');
    const nestedAgentsMd = await writeAgentsMd(nested, 'nested instructions');

    const result = await fire(h, didCtx('Read', { path: join(nested, 'index.ts') }));

    expect(outputText(result)).toBe('original result');
    const text = reminderText(h);
    expect(text).toContain(nestedAgentsMd);
    expect(text).not.toContain(rootAgentsMd);
  });

  it('probes only the immediate directory outside any project', async () => {
    const h = createHarness();
    const outside = await mkdtemp(join(tmpdir(), 'kimi-reminder-outside-'));
    const outerAgentsMd = await writeAgentsMd(outside, 'outer instructions');
    const leaf = join(outside, 'leaf');
    const leafAgentsMd = await writeAgentsMd(leaf, 'leaf instructions');

    try {
      const result = await fire(h, didCtx('Read', { path: join(leaf, 'index.ts') }));

      expect(outputText(result)).toBe('original result');
      const text = reminderText(h);
      expect(text).toContain(leafAgentsMd);
      expect(text).not.toContain(outerAgentsMd);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('discovers a symlinked directory through the link at its lexical address', async () => {
    const h = createHarness();
    const target = await mkdtemp(join(tmpdir(), 'kimi-reminder-target-'));
    const targetAgentsMd = await writeAgentsMd(target, 'target instructions');
    await symlink(target, join(workDir, 'link'));

    try {
      const result = await fire(h, didCtx('Read', { path: join(workDir, 'link', 'index.ts') }));

      expect(outputText(result)).toBe('original result');
      const text = reminderText(h);
      expect(text).toContain(normalize(join(workDir, 'link', 'AGENTS.md')));
      expect(text).not.toContain(targetAgentsMd);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });
});

describe('agentsMdReminder round-2 hardening', () => {
  it('skips preflight-rejected calls entirely (no probing behind the path policy)', async () => {
    const h = createHarness();
    const subDir = join(workDir, 'packages', 'kap-server');
    await writeAgentsMd(subDir);

    const result = await fire(
      h,
      didCtx('Read', { path: join(subDir, 'index.ts') }, { preflightRejected: true }),
    );

    expect(outputText(result)).toBe('original result');
    expect(h.reminders).toHaveLength(0);
    expect(h.telemetryEvents).toHaveLength(0);
  });

  it('resolves Bash targets against the frozen session cwd, not the seeded live cwd', async () => {
    const h = createHarness();
    const subAgentsMd = await writeAgentsMd(join(workDir, 'packages'));
    const liveCwd = join(workDir, 'elsewhere');
    h.reminder.seedInjected([], liveCwd);

    const result = await fire(h, didCtx('Bash', { command: 'true' }));

    expect(outputText(result)).toBe('original result');
    expect(h.reminders).toHaveLength(0);

    const listed = await fire(h, didCtx('Bash', { command: 'ls packages' }));
    expect(outputText(listed)).toBe('original result');
    expect(reminderText(h)).toContain(subAgentsMd);
  });

  it('ignores a whitespace-only AGENTS.md just like the init-time load', async () => {
    const h = createHarness();
    const subDir = join(workDir, 'packages', 'kap-server');
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, 'AGENTS.md'), '  \n\t \n', 'utf-8');

    const result = await fire(h, didCtx('Read', { path: join(subDir, 'index.ts') }));

    expect(outputText(result)).toBe('original result');
    expect(h.reminders).toHaveLength(0);
  });

  it('keeps known-sets isolated between agents', async () => {
    const subDir = join(workDir, 'packages', 'kap-server');
    const subAgentsMd = await writeAgentsMd(subDir);
    const first = createHarness();
    const second = createHarness();

    const firstResult = await fire(first, didCtx('Read', { path: join(subDir, 'index.ts') }));
    const secondResult = await fire(second, didCtx('Read', { path: join(subDir, 'index.ts') }));

    expect(outputText(firstResult)).toBe('original result');
    expect(outputText(secondResult)).toBe('original result');
    expect(first.reminders).toHaveLength(1);
    expect(second.reminders).toHaveLength(1);
    expect(reminderText(first)).toContain(subAgentsMd);
    expect(reminderText(second)).toContain(subAgentsMd);
  });

  it('releases the claim when attaching the reminder fails, so the next touch retries', async () => {
    let shouldThrow = true;
    const telemetry = {
      ...recordingTelemetry([]),
      track2: (event: string, properties?: unknown) => {
        if (shouldThrow) throw new Error('telemetry boom');
      },
    } satisfies ITelemetryService;
    const h = createHarness({ telemetry });
    const subDir = join(workDir, 'packages', 'kap-server');
    const subAgentsMd = await writeAgentsMd(subDir);

    const failed = await fire(h, didCtx('Read', { path: join(subDir, 'a.ts') }));
    expect(outputText(failed)).toBe('original result');
    expect(h.reminders).toHaveLength(0);

    shouldThrow = false;
    const retried = await fire(h, didCtx('Read', { path: join(subDir, 'b.ts') }));
    expect(outputText(retried)).toBe('original result');
    expect(h.reminders).toHaveLength(1);
    expect(reminderText(h)).toContain(subAgentsMd);
  });

  it('leaves oversized results to the truncation pipeline and enqueues the reminder instead', async () => {
    const h = createHarness({ withRealExecutor: true });
    const subAgentsMd = await writeAgentsMd(join(workDir, 'packages', 'kap-server'));

    class BigTool implements ExecutableTool<Record<string, unknown>> {
      readonly name = 'Read';
      readonly description = 'Returns a huge output.';
      readonly parameters = { type: 'object', additionalProperties: true };
      resolveExecution(args: Record<string, unknown>): ToolExecution {
        return {
          accesses: ToolAccesses.readFile(String(args['path'])),
          approvalRule: this.name,
          execute: async (_ctx: ExecutableToolContext) => ({ output: 'x'.repeat(60_000) }),
        };
      }
    }
    h.ix.get(IAgentToolRegistryService).register(new BigTool());

    const toolCall: ToolCall = {
      type: 'function',
      id: 'call-big-1',
      name: 'Read',
      arguments: JSON.stringify({ path: join(workDir, 'packages', 'kap-server', 'big.ts') }),
    };
    const results = [];
    for await (const item of h.ix
      .get(IAgentToolExecutorService)
      .execute([toolCall], { turnId: 1, signal: new AbortController().signal })) {
      results.push(item);
    }

    expect(results).toHaveLength(1);
    const output = results[0]!.result.output;
    expect(typeof output).toBe('string');
    const text = output as string;
    expect(text).toContain('output_path:');
    expect(text).not.toContain('<system-reminder>');
    expect(text).not.toContain(subAgentsMd);
    expect(h.reminders).toHaveLength(1);
    expect(reminderText(h)).toContain(subAgentsMd);
  });

  it('uses the resolved file access instead of reparsing the raw path', async () => {
    const h = createHarness({ withRealExecutor: true });
    const homePackage = join(homeDir, 'pkg');
    const homeAgentsMd = await writeAgentsMd(homePackage, 'home package instructions');

    class ResolvedReadTool implements ExecutableTool<Record<string, unknown>> {
      readonly name = 'Read';
      readonly description = 'Returns a resolved file result.';
      readonly parameters = { type: 'object', additionalProperties: true };

      resolveExecution(_args: Record<string, unknown>): ToolExecution {
        return {
          accesses: ToolAccesses.readFile(join(homePackage, 'index.ts')),
          approvalRule: this.name,
          execute: async (_ctx: ExecutableToolContext) => ({ output: 'home file contents' }),
        };
      }
    }
    h.ix.get(IAgentToolRegistryService).register(new ResolvedReadTool());

    const results = [];
    for await (const item of h.ix.get(IAgentToolExecutorService).execute(
      [
        {
          type: 'function',
          id: 'call-resolved-read',
          name: 'Read',
          arguments: JSON.stringify({ path: '~/pkg/index.ts' }),
        },
      ],
      { turnId: 1, signal: new AbortController().signal },
    )) {
      results.push(item);
    }

    expect(results).toHaveLength(1);
    expect(outputText(results[0]!.result)).toBe('home file contents');
    expect(h.reminders).toHaveLength(1);
    expect(reminderText(h)).toContain(homeAgentsMd);
  });

  it('does not probe or remind when permission vetoes an access-bearing call', async () => {
    const h = createHarness({ withRealExecutor: true });
    const subDir = join(workDir, 'packages', 'kap-server');
    await writeAgentsMd(subDir);
    const hostFs = h.ix.get(IHostFileSystem);
    const stat = vi.spyOn(hostFs, 'stat');
    const readText = vi.spyOn(hostFs, 'readText');

    class ReadTool implements ExecutableTool<Record<string, unknown>> {
      readonly name = 'Read';
      readonly description = 'Returns file contents.';
      readonly parameters = { type: 'object', additionalProperties: true };

      resolveExecution(_args: Record<string, unknown>): ToolExecution {
        return {
          accesses: ToolAccesses.readFile(join(subDir, 'index.ts')),
          approvalRule: this.name,
          execute: async () => {
            throw new Error('vetoed tool must not execute');
          },
        };
      }
    }
    h.ix.get(IAgentToolRegistryService).register(new ReadTool());
    h.ix.get(IAgentToolExecutorService).onBeforeExecuteTool((event) => {
      event.veto({ output: 'permission denied', isError: true });
    });

    const results = [];
    for await (const item of h.ix.get(IAgentToolExecutorService).execute(
      [
        {
          type: 'function',
          id: 'call-denied-read',
          name: 'Read',
          arguments: JSON.stringify({ path: join(subDir, 'index.ts') }),
        },
      ],
      { turnId: 1, signal: new AbortController().signal },
    )) {
      results.push(item);
    }

    expect(results).toHaveLength(1);
    expect(outputText(results[0]!.result)).toBe('permission denied');
    expect(h.reminders).toHaveLength(0);
    expect(stat).not.toHaveBeenCalled();
    expect(readText).not.toHaveBeenCalled();
    expect(
      h.telemetryEvents.filter((event) => event.event === 'agents_md_reminder_shown'),
    ).toHaveLength(0);
  });
});

describe('agentsMdReminder cancellation outcomes', () => {
  it('does not consume a reminder for a conflicting task cancelled before execution starts', async () => {
    const h = createHarness({ withRealExecutor: true });
    const subDir = join(workDir, 'packages', 'kap-server');
    const subAgentsMd = await writeAgentsMd(subDir);
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });

    class BlockingBash implements ExecutableTool<Record<string, unknown>> {
      readonly name = 'Bash';
      readonly description = 'Blocks until cancelled.';
      readonly parameters = { type: 'object', additionalProperties: true };

      resolveExecution(): ToolExecution {
        return {
          accesses: ToolAccesses.all(),
          approvalRule: this.name,
          execute: ({ signal }) => {
            resolveStarted();
            return new Promise<ExecutableToolResult>((resolve) => {
              const onAbort = (): void => {
                signal.removeEventListener('abort', onAbort);
                resolve({ output: 'bash aborted', isError: true });
              };
              if (signal.aborted) onAbort();
              else signal.addEventListener('abort', onAbort);
            });
          },
        };
      }
    }

    class ReadTool implements ExecutableTool<Record<string, unknown>> {
      readonly name = 'Read';
      readonly description = 'Reads a file.';
      readonly parameters = { type: 'object', additionalProperties: true };

      resolveExecution(): ToolExecution {
        return {
          accesses: ToolAccesses.readFile(join(subDir, 'index.ts')),
          approvalRule: this.name,
          execute: async () => ({ output: 'read result' }),
        };
      }
    }

    h.ix.get(IAgentToolRegistryService).register(new BlockingBash());
    h.ix.get(IAgentToolRegistryService).register(new ReadTool());
    const controller = new AbortController();
    const calls: ToolCall[] = [
      {
        type: 'function',
        id: 'call-blocking-bash',
        name: 'Bash',
        arguments: JSON.stringify({ command: 'sleep 60' }),
      },
      {
        type: 'function',
        id: 'call-queued-read',
        name: 'Read',
        arguments: JSON.stringify({ path: join(subDir, 'index.ts') }),
      },
    ];
    const pending = (async () => {
      const results = [];
      for await (const item of h.ix.get(IAgentToolExecutorService).execute(calls, {
        turnId: 1,
        signal: controller.signal,
      })) {
        results.push(item);
      }
      return results;
    })();

    await started;
    controller.abort();
    const results = await pending;
    const queued = results.find((item) => item.toolCallId === 'call-queued-read');
    expect(queued).toBeDefined();
    expect(h.reminders).toHaveLength(0);
    expect(
      h.telemetryEvents.filter((event) => event.event === 'agents_md_reminder_shown'),
    ).toEqual([]);

    const real = [];
    for await (const item of h.ix.get(IAgentToolExecutorService).execute(
      [
        {
          type: 'function',
          id: 'call-real-read',
          name: 'Read',
          arguments: JSON.stringify({ path: join(subDir, 'index.ts') }),
        },
      ],
      {
        turnId: 2,
        signal: new AbortController().signal,
      },
    )) {
      real.push(item);
    }
    expect(outputText(real[0]!.result)).toBe('read result');
    expect(h.reminders).toHaveLength(1);
    expect(reminderText(h)).toContain(subAgentsMd);
  });
});

describe('agentsMdReminder Bash parse degradation', () => {
  it('falls back to the structured cwd argument when the command cannot be parsed', async () => {
    const h = createHarness();
    const subAgentsMd = await writeAgentsMd(join(workDir, 'packages', 'kap-server'));

    const result = await fire(
      h,
      didCtx('Bash', { command: "ls '", cwd: 'packages/kap-server' }),
    );

    expect(outputText(result)).toBe('original result');
    expect(reminderText(h)).toContain(subAgentsMd);
  });

  it('skips entirely when an unparseable command has no explicit cwd', async () => {
    const h = createHarness();
    await writeAgentsMd(join(workDir, 'packages', 'kap-server'));

    const result = await fire(h, didCtx('Bash', { command: "ls '" }));

    expect(outputText(result)).toBe('original result');
    expect(h.reminders).toHaveLength(0);
  });
});

describe('agentsMdReminder Windows Bash paths', () => {
  function windowsProbeFs(
    targetDir: string,
    agentsMdPath: string,
    projectRoot: string,
  ): IHostFileSystem {
    const directory: HostFileStat = {
      isFile: false,
      isDirectory: true,
      size: 0,
    };
    const stat = vi.fn(async (path: string): Promise<HostFileStat> => {
      if (path === targetDir || path === join(projectRoot, '.git')) return directory;
      throw new Error(`missing: ${path}`);
    });
    const readText = vi.fn(async (path: string): Promise<string> => {
      if (path === agentsMdPath) return 'windows instructions';
      throw new Error(`missing: ${path}`);
    });
    return { stat, readText } as unknown as IHostFileSystem;
  }

  it('converts Git Bash drive paths before probing the host filesystem', async () => {
    const projectRoot = 'C:/repo';
    const targetDir = `${projectRoot}/packages/app`;
    const agentsMdPath = `${targetDir}/AGENTS.md`;

    for (const args of [
      { command: 'ls /cygdrive/c/repo/packages/app' },
      { command: 'true', cwd: '/c/repo/packages/app' },
    ]) {
      const h = createHarness({
        cwd: projectRoot,
        hostFs: windowsProbeFs(targetDir, agentsMdPath, projectRoot),
        pathClass: 'win32',
      });
      h.reminder.seedInjected([], projectRoot);

      const result = await fire(h, didCtx('Bash', args));

      expect(outputText(result)).toBe('original result');
      expect(reminderText(h)).toContain(agentsMdPath);
    }
  });
});

describe('extractBashTargetDirs', () => {
  const parser = new BashParserService();

  function targets(command: string, cwd = workDir): string[] {
    const parsed = parser.parse(command);
    if (!parsed.ok) throw new Error(`parse aborted for: ${command}`);
    return extractBashTargetDirs(parsed.root, cwd, homeDir);
  }

  it('resolves operands of listing commands against the cwd', () => {
    expect(targets('ls packages')).toEqual([normalize(join(workDir, 'packages'))]);
    expect(targets('tree /opt /srv')).toEqual(['/opt', '/srv']);
  });

  it('tracks cd chains, the bare-cd home fallback, and operand-less listings', () => {
    expect(targets('cd packages && cd kap-server && ls')).toEqual([
      normalize(join(workDir, 'packages', 'kap-server')),
    ]);
    expect(targets('cd packages && ls ../docs')).toEqual([normalize(join(workDir, 'docs'))]);
    expect(targets('cd && ls notes')).toEqual([normalize(join(homeDir, 'notes'))]);
    expect(targets('ls')).toEqual([workDir]);
    expect(targets('find')).toEqual([workDir]);
  });

  it('poisons relative resolution after an unresolvable cd instead of guessing a base', () => {
    expect(targets('cd $DIR && ls packages')).toEqual([]);
    expect(targets('cd ~/packages && ls src')).toEqual([]);
    expect(targets('cd - && ls packages')).toEqual([]);
    expect(targets('cd $X && cd /opt && ls x')).toEqual(['/opt/x']);
  });

  it('skips listing commands invoked through a path prefix', () => {
    expect(targets('/bin/ls packages')).toEqual([]);
    expect(targets('./ls packages')).toEqual([]);
    expect(targets('../tools/find packages')).toEqual([]);
  });

  it('ignores pipelines of non-listing commands and compound constructs', () => {
    expect(targets('cat packages | grep foo')).toEqual([]);
    expect(targets('if [ -f x ]; then ls packages; fi')).toEqual([]);
    expect(targets('(cd packages && ls)')).toEqual([]);
  });

  it('drops the arguments of known argument-taking options', () => {
    expect(targets('ls -w 80 packages')).toEqual([normalize(join(workDir, 'packages'))]);
    expect(targets('ls --sort size packages')).toEqual([normalize(join(workDir, 'packages'))]);
    expect(targets('ls --sort=size packages')).toEqual([normalize(join(workDir, 'packages'))]);
    expect(targets('ls -L packages')).toEqual([normalize(join(workDir, 'packages'))]);
    expect(targets('ls -P packages')).toEqual([normalize(join(workDir, 'packages'))]);
    expect(targets('ls -o packages')).toEqual([normalize(join(workDir, 'packages'))]);
    expect(targets('ls -s packages')).toEqual([normalize(join(workDir, 'packages'))]);
    expect(targets('tree -L 2 packages')).toEqual([normalize(join(workDir, 'packages'))]);
    expect(targets('find -L packages -name x')).toEqual([normalize(join(workDir, 'packages'))]);
    expect(targets('find -H -P /srv -type f')).toEqual(['/srv']);
    expect(targets('find -- packages -name x')).toEqual([normalize(join(workDir, 'packages'))]);
    expect(targets('ls -- packages')).toEqual([normalize(join(workDir, 'packages'))]);
  });

  it('skips words whose escapes would introduce glob characters', () => {
    expect(targets('ls foo\\*bar')).toEqual([]);
  });

  it('does not rebase operands on a cd inside a pipeline', () => {
    expect(targets('cd /tmp | ls packages')).toEqual([normalize(join(workDir, 'packages'))]);
  });

  it('skips quoted glob operands as well', () => {
    expect(targets("ls '*.ts'")).toEqual([]);
    expect(targets('ls "*.ts"')).toEqual([]);
  });

  it('handles assignment prefixes and redirects, and skips wrappers', () => {
    expect(targets('FOO=bar ls packages')).toEqual([normalize(join(workDir, 'packages'))]);
    expect(targets('ls packages > out.txt')).toEqual([normalize(join(workDir, 'packages'))]);
    expect(targets('sudo ls packages')).toEqual([]);
    expect(targets('! ls packages')).toEqual([]);
  });
});
