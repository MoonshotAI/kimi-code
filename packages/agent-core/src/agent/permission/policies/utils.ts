import type { Agent } from '../..';
import type { ToolInputDisplay } from '../../../tools/display';
import {
  resolvePathAccess,
  type PathAccessOperation,
  type PathClass,
} from '../../../tools/policies/path-access';
import { matchesRule } from '../matches-rule';
import type { PermissionPathMatchOptions } from '../path-glob-match';
import type { PermissionPolicyContext } from '../policy';
import type { PermissionRule, PermissionRuleDecision } from '../types';

export type PathToolDisplayOperation = Extract<
  ToolInputDisplay,
  { kind: 'file_io' }
>['operation'];

export interface PathToolAccess {
  readonly inputPath: string;
  readonly path: string;
  readonly outsideCwd: boolean;
  readonly pathClass: PathClass;
  readonly operation: PathAccessOperation;
  readonly displayOperation: PathToolDisplayOperation;
}

export function readStringField(args: unknown, key: string): string | undefined {
  if (args === null || typeof args !== 'object') return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

export function resolvePathToolAccess(
  agent: Agent,
  context: PermissionPolicyContext,
): PathToolAccess | undefined {
  const name = context.toolCall.function.name;
  const operation = pathAccessOperationForTool(name);
  if (operation === undefined) return undefined;

  const inputPath = readStringField(context.args, 'path');
  if (inputPath === undefined) return undefined;

  const cwd = agent.config.cwd;
  if (cwd.length === 0) return undefined;

  const kaos = agent.runtime.kaos;
  const pathClass = kaos.pathClass();
  let access;
  try {
    access = resolvePathAccess(
      inputPath,
      cwd,
      { workspaceDir: cwd, additionalDirs: [] },
      {
        operation,
        pathClass,
        homeDir: kaos.gethome(),
        policy: { guardMode: 'disabled', checkSensitive: false },
      },
    );
  } catch {
    return undefined;
  }

  return {
    inputPath,
    path: access.path,
    outsideCwd: access.outsideWorkspace,
    pathClass,
    operation,
    displayOperation: pathToolDisplayOperation(name),
  };
}

export function pathAccessOperationForTool(tool: string): PathAccessOperation | undefined {
  switch (tool) {
    case 'Read':
    case 'ReadMediaFile':
      return 'read';
    case 'Write':
    case 'Edit':
      return 'write';
    default:
      return undefined;
  }
}

export function pathToolDisplayOperation(tool: string): PathToolDisplayOperation {
  switch (tool) {
    case 'Write':
      return 'write';
    case 'Edit':
      return 'edit';
    default:
      return 'read';
  }
}

export function fileInputDisplay(
  access: PathToolAccess,
  detail: string | undefined,
): ToolInputDisplay {
  return {
    kind: 'file_io',
    operation: access.displayOperation,
    path: access.path,
    detail,
  };
}

export function genericInputDisplay(summary: string, detail?: unknown): ToolInputDisplay {
  return {
    kind: 'generic',
    summary,
    detail,
  };
}

export function permissionPathMatchOptions(
  agent: Agent,
): PermissionPathMatchOptions {
  return {
    cwd: agent.config.cwd,
    pathClass: agent.runtime.kaos.pathClass(),
    homeDir: agent.runtime.kaos.gethome(),
  };
}

export function firstMatchingRuleDecision(
  rules: readonly PermissionRule[],
  agent: Agent,
  context: PermissionPolicyContext,
): { readonly decision: PermissionRuleDecision; readonly rule: PermissionRule } | undefined {
  for (const decision of ['deny', 'ask', 'allow'] as const) {
    const rule = firstMatchingRule(rules, decision, agent, context);
    if (rule !== undefined) return { decision, rule };
  }
  return undefined;
}

function firstMatchingRule(
  rules: readonly PermissionRule[],
  decision: PermissionRuleDecision,
  agent: Agent,
  context: PermissionPolicyContext,
): PermissionRule | undefined {
  const name = context.toolCall.function.name;
  const args = context.args;
  const pathOptions = permissionPathMatchOptions(agent);
  for (const rule of rules) {
    if (rule.decision !== decision) continue;
    if (matchesRule(rule, name, args, pathOptions)) return rule;
  }
  return undefined;
}

export function formatPermissionRuleDenyMessage(
  tool: string,
  reason: string | undefined,
): string {
  const suffix = reason !== undefined && reason.length > 0 ? ` Reason: ${reason}` : '';
  return `Tool "${tool}" was denied by permission rule.${suffix}`;
}
