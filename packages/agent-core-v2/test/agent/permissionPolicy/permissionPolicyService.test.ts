import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ToolCall } from '#/kosong/contract/message';
import type { ToolInputDisplay } from '#/tool/toolInputDisplay';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import {
  literalRulePattern,
  matchesGlobRuleSubject,
  matchesPathRuleSubject,
} from '#/tool/rule-match';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { IHostEnvironment, type IHostEnvironment as HostEnvironmentService } from '#/os/interface/hostEnvironment';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentPermissionPolicyService, type PermissionPolicyEvaluation } from '#/agent/permissionPolicy/permissionPolicy';
import type { PermissionMode } from '#/agent/permissionPolicy/types';
import { AgentPermissionPolicyService } from '#/agent/permissionPolicy/permissionPolicyService';
import {
  IAgentPermissionRulesService,
  type IAgentPermissionRulesService as PermissionRulesServiceContract,
  type PermissionRule,
} from '#/agent/permissionRules/permissionRules';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { ToolAccesses, type ToolAccesses as ToolAccessList } from '#/tool/toolContract';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';

import { stubPermissionModeService } from '../permissionMode/stubs';
import { recordingTelemetry } from '../../app/telemetry/stubs';

const signal = new AbortController().signal;

describe('AgentPermissionPolicyService chain', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let mode: PermissionMode;
  let rules: PermissionRule[];
  let sessionApprovalRulePatterns: string[];
  let workspace: ReturnType<typeof workspaceStub>;

  beforeEach(() => {
    disposables = new DisposableStore();
    mode = 'manual';
    rules = [];
    sessionApprovalRulePatterns = [];
    workspace = workspaceStub('/workspace');
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(IAgentPermissionModeService, stubPermissionModeService(() => mode));
        reg.defineInstance(
          IAgentScopeContext,
          makeAgentScopeContext({ agentId: 'main', agentScope: '' }),
        );
        reg.definePartialInstance(IAgentPermissionRulesService, permissionRulesStub({
          rules: () => rules,
          sessionApprovalRulePatterns: () => sessionApprovalRulePatterns,
        }));
        reg.defineInstance(ISessionWorkspaceContext, workspace);
        reg.defineInstance(IHostEnvironment, kaosStub());
        reg.defineInstance(ITelemetryService, recordingTelemetry([]));
        reg.define(IAgentPermissionPolicyService, AgentPermissionPolicyService);
      },
      strict: true,
    });
  });

  afterEach(() => {
    disposables.dispose();
  });

  function service(): IAgentPermissionPolicyService {
    return ix.get(IAgentPermissionPolicyService);
  }

  async function evaluate(
    input: PolicyContextInput,
  ): Promise<PermissionPolicyEvaluation | undefined> {
    const svc = service();
    return svc.evaluate(policyContext(input));
  }

  it('keeps auto-mode AskUserQuestion deny above default approval', async () => {
    mode = 'auto';

    await expect(evaluate({
      toolName: 'AskUserQuestion',
      args: { questions: [] },
    })).resolves.toMatchObject({
      policyName: 'auto-mode-ask-user-question-deny',
      result: { kind: 'deny' },
    });
  });

  it('applies deny rules before yolo-mode approval', async () => {
    mode = 'yolo';
    rules.push({
      decision: 'deny',
      scope: 'user',
      pattern: 'Bash',
      reason: 'blocked by test',
    });

    await expect(evaluate({
      toolName: 'Bash',
      args: { command: 'printf first', timeout: 60 },
    })).resolves.toMatchObject({
      policyName: 'user-configured-deny',
      result: {
        kind: 'deny',
        message: 'Tool "Bash" was denied by permission rule. Reason: blocked by test',
      },
    });
  });

  it('keeps ask rules higher priority than matching allow rules', async () => {
    rules.push(
      {
        decision: 'allow',
        scope: 'project',
        pattern: 'Bash',
      },
      {
        decision: 'ask',
        scope: 'user',
        pattern: 'Bash',
      },
    );

    await expect(evaluate({
      toolName: 'Bash',
      args: { command: 'printf first', timeout: 60 },
    })).resolves.toMatchObject({
      policyName: 'user-configured-ask',
      result: { kind: 'ask' },
    });
  });

  it('reuses approve-for-session before matching ask rules', async () => {
    rules.push({
      decision: 'ask',
      scope: 'user',
      pattern: 'Bash',
    });
    sessionApprovalRulePatterns.push('Bash(printf first)');

    await expect(evaluate({
      toolName: 'Bash',
      args: { command: 'printf first', timeout: 60 },
    })).resolves.toMatchObject({
      policyName: 'session-approval-history',
      result: {
        kind: 'approve',
        reason: {
          has_rule_args: true,
          match_strategy: 'matches_rule',
        },
      },
    });
  });

  it.each(['AgentSwarm', 'EnterPlanMode', 'ExitPlanMode', 'CreateGoal'] as const)(
    'approves %s through the default tool allowlist in manual mode',
    async (toolName) => {
      await expect(evaluate({ toolName, args: {} })).resolves.toMatchObject({
        policyName: 'default-tool-approve',
        result: { kind: 'approve' },
      });
    },
  );
});

describe('AgentPermissionPolicyService git cwd write approval', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let mode: PermissionMode;
  let workspace: ReturnType<typeof workspaceStub>;
  let workspaceDir: string;
  let cleanupDirs: string[];

  beforeEach(async () => {
    disposables = new DisposableStore();
    mode = 'manual';
    workspaceDir = await mkdtemp(join(tmpdir(), 'kimi-permission-git-'));
    cleanupDirs = [workspaceDir];
    await mkdir(join(workspaceDir, '.git'), { recursive: true });
    workspace = workspaceStub(workspaceDir);
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(IAgentPermissionModeService, stubPermissionModeService(() => mode));
        reg.defineInstance(
          IAgentScopeContext,
          makeAgentScopeContext({ agentId: 'main', agentScope: '' }),
        );
        reg.definePartialInstance(IAgentPermissionRulesService, permissionRulesStub());
        reg.defineInstance(ISessionWorkspaceContext, workspace);
        reg.defineInstance(IHostEnvironment, kaosStub());
        reg.defineInstance(ITelemetryService, recordingTelemetry([]));
        reg.define(IAgentPermissionPolicyService, AgentPermissionPolicyService);
      },
      strict: true,
    });
  });

  afterEach(async () => {
    disposables.dispose();
    await Promise.all(cleanupDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function evaluate(
    input: PolicyContextInput,
  ): Promise<PermissionPolicyEvaluation | undefined> {
    const svc = ix.get(IAgentPermissionPolicyService);
    return svc.evaluate(policyContext(input));
  }

  it('still asks for Bash inside a git cwd in manual mode', async () => {
    await expect(evaluate({
      toolName: 'Bash',
      args: { command: 'printf first', timeout: 60 },
    })).resolves.toMatchObject({
      policyName: 'fallback-ask',
      result: { kind: 'ask' },
    });
  });

  it('approves Write to a path inside the git cwd', async () => {
    await expect(evaluate({
      toolName: 'Write',
      args: { path: 'src/a.ts', content: 'x' },
      accesses: ToolAccesses.writeFile(join(workspaceDir, 'src/a.ts')),
    })).resolves.toMatchObject({
      policyName: 'git-cwd-write-approve',
      result: { kind: 'approve' },
    });
  });

  it('approves Edit on an additionalDir path in manual mode', async () => {
    const extraDir = await mkdtemp(join(tmpdir(), 'kimi-permission-extra-'));
    cleanupDirs.push(extraDir);
    workspace.addAdditionalDir(extraDir);
    await expect(evaluate({
      toolName: 'Edit',
      args: { path: join(extraDir, 'src/a.ts'), old_string: 'A', new_string: 'B' },
      accesses: ToolAccesses.readWriteFile(join(extraDir, 'src/a.ts')),
    })).resolves.toMatchObject({
      policyName: 'git-cwd-write-approve',
      result: { kind: 'approve' },
    });
  });

  it('asks for paths outside cwd and additionalDirs', async () => {
    const extraDir = await mkdtemp(join(tmpdir(), 'kimi-permission-extra-'));
    cleanupDirs.push(extraDir);
    workspace.addAdditionalDir(extraDir);
    const outsidePath = join(`${extraDir}-evil`, 'outside.ts');
    await expect(evaluate({
      toolName: 'Write',
      args: { path: outsidePath, content: 'x' },
      accesses: ToolAccesses.writeFile(outsidePath),
    })).resolves.toMatchObject({
      policyName: 'fallback-ask',
      result: { kind: 'ask' },
    });
  });

  it('asks for git control files before git-cwd approval', async () => {
    await expect(evaluate({
      toolName: 'Write',
      args: { path: '.git/config', content: 'x' },
      accesses: ToolAccesses.writeFile(join(workspaceDir, '.git/config')),
    })).resolves.toMatchObject({
      policyName: 'git-control-path-access-ask',
      result: { kind: 'ask' },
    });
  });

  it('asks for sensitive files before git-cwd approval', async () => {
    await expect(evaluate({
      toolName: 'Write',
      args: { path: '.env', content: 'SECRET=1' },
      accesses: ToolAccesses.writeFile(join(workspaceDir, '.env')),
    })).resolves.toMatchObject({
      policyName: 'sensitive-file-access-ask',
      result: { kind: 'ask' },
    });
  });

  it('does not use git-cwd approval in auto mode', async () => {
    mode = 'auto';
    await expect(evaluate({
      toolName: 'Write',
      args: { path: 'src/a.ts', content: 'x' },
      accesses: ToolAccesses.writeFile(join(workspaceDir, 'src/a.ts')),
    })).resolves.toMatchObject({
      policyName: 'auto-mode-approve',
      result: { kind: 'approve' },
    });
  });

  it('does not approve Write when execution has no write file access', async () => {
    await expect(evaluate({
      toolName: 'Write',
      args: { path: 'src/a.ts', content: 'x' },
      accesses: ToolAccesses.none(),
    })).resolves.toMatchObject({
      policyName: 'fallback-ask',
      result: { kind: 'ask' },
    });
  });

  it('does not approve when any write access is outside the cwd', async () => {
    await expect(evaluate({
      toolName: 'Write',
      args: { path: 'src/a.ts', content: 'x' },
      accesses: [
        { kind: 'file', operation: 'write', path: join(workspaceDir, 'src/a.ts') },
        { kind: 'file', operation: 'write', path: join(tmpdir(), 'outside.ts') },
      ],
    })).resolves.toMatchObject({
      policyName: 'fallback-ask',
      result: { kind: 'ask' },
    });
  });
});

interface MutablePermissionRulesStubOptions {
  readonly rules?: () => readonly PermissionRule[];
  readonly sessionApprovalRulePatterns?: () => readonly string[];
}

function permissionRulesStub(
  options: MutablePermissionRulesStubOptions = {},
): Partial<PermissionRulesServiceContract> {
  const rules = options.rules ?? (() => []);
  const sessionApprovalRulePatterns = options.sessionApprovalRulePatterns ?? (() => []);
  return {
    get rules() {
      return rules();
    },
    get sessionApprovalRulePatterns() {
      return sessionApprovalRulePatterns();
    },
    addRules: () => {},
    recordApprovalResult: () => {},
  };
}

interface PolicyContextInput {
  readonly id?: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly accesses?: ToolAccessList;
}

function policyContext(input: PolicyContextInput): ResolvedToolExecutionHookContext {
  const toolCall = toolCallFor(input.id ?? `call_${input.toolName}`, input.toolName, input.args);
  const subject = ruleSubject(input.toolName, input.args);
  return {
    turnId: 0,
    signal,
    toolCall,
    toolCalls: [toolCall],
    args: input.args,
    execution: {
      description: description(input.toolName),
      display: display(input.toolName, input.args),
      accesses: input.accesses ?? accesses(input.toolName, input.args),
      approvalRule:
        subject === undefined ? input.toolName : literalRulePattern(input.toolName, subject),
      matchesRule:
        subject === undefined
          ? undefined
          : (ruleArgs) => matchesRuleSubject(input.toolName, ruleArgs, subject),
      execute: async () => ({ output: '' }),
    },
  };
}

function toolCallFor(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return {
    type: 'function',
    id,
    name,
    arguments: JSON.stringify(args),
  };
}

function ruleSubject(toolName: string, args: Record<string, unknown>): string | undefined {
  switch (toolName) {
    case 'Bash':
      return stringArg(args, 'command');
    case 'Read':
    case 'ReadMediaFile':
    case 'Write':
    case 'Edit':
      return stringArg(args, 'path');
    case 'Grep':
    case 'Glob':
      return stringArg(args, 'pattern');
    default:
      return undefined;
  }
}

function matchesRuleSubject(toolName: string, ruleArgs: string, subject: string): boolean {
  switch (toolName) {
    case 'Read':
    case 'ReadMediaFile':
    case 'Write':
    case 'Edit':
      return matchesPathRuleSubject(ruleArgs, subject, { cwd: '/workspace', pathClass: 'posix' });
    default:
      return matchesGlobRuleSubject(ruleArgs, subject);
  }
}

function description(toolName: string): string {
  switch (toolName) {
    case 'Bash':
      return 'run command';
    case 'Write':
      return 'write file';
    case 'Edit':
      return 'edit file';
    default:
      return `Approve ${toolName}`;
  }
}

function display(toolName: string, args: Record<string, unknown>): ToolInputDisplay {
  const path = stringArg(args, 'path', '/workspace/file.txt');
  switch (toolName) {
    case 'Bash':
      return { kind: 'command', command: stringArg(args, 'command') };
    case 'Read':
    case 'ReadMediaFile':
      return { kind: 'file_io', operation: 'read', path };
    case 'Write':
      return { kind: 'file_io', operation: 'write', path };
    case 'Edit':
      return { kind: 'file_io', operation: 'edit', path };
    default:
      return { kind: 'generic', summary: `Approve ${toolName}`, detail: args };
  }
}

function accesses(toolName: string, args: Record<string, unknown>): ToolAccessList {
  const path = stringArg(args, 'path');
  switch (toolName) {
    case 'Read':
    case 'ReadMediaFile':
      return path.length > 0 ? ToolAccesses.readFile(path) : ToolAccesses.none();
    case 'Write':
      return path.length > 0 ? ToolAccesses.writeFile(path) : ToolAccesses.none();
    case 'Edit':
      return path.length > 0 ? ToolAccesses.readWriteFile(path) : ToolAccesses.none();
    case 'Grep':
    case 'Glob':
      return path.length > 0 ? ToolAccesses.searchTree(path) : ToolAccesses.none();
    default:
      return ToolAccesses.none();
  }
}

function stringArg(
  args: Record<string, unknown>,
  key: string,
  fallback = '',
): string {
  const value = args[key];
  return typeof value === 'string' ? value : fallback;
}

function workspaceStub(initialWorkDir: string): ISessionWorkspaceContext {
  let workDir = initialWorkDir;
  let additionalDirs: string[] = [];
  return {
    _serviceBrand: undefined,
    get workDir() {
      return workDir;
    },
    get additionalDirs() {
      return additionalDirs;
    },
    setWorkDir: (nextWorkDir) => {
      workDir = nextWorkDir;
    },
    setAdditionalDirs: (dirs) => {
      additionalDirs = [...dirs];
    },
    resolve: (path) => path,
    isWithin: () => true,
    assertAllowed: (path) => path,
    addAdditionalDir: (dir) => {
      if (!additionalDirs.includes(dir)) additionalDirs = [...additionalDirs, dir];
    },
    removeAdditionalDir: (dir) => {
      additionalDirs = additionalDirs.filter((candidate) => candidate !== dir);
    },
  };
}

function kaosStub(pathClass: HostEnvironmentService['pathClass'] = 'posix'): HostEnvironmentService {
  return {
    _serviceBrand: undefined,
    osKind: 'Linux',
    osArch: 'x86_64',
    osVersion: 'test',
    shellName: 'bash',
    shellPath: '/bin/bash',
    pathClass,
    homeDir: '/home/test',
    ready: Promise.resolve(),
  };
}
