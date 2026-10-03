

import type { ExecRule } from '@moonshot-ai/exec-policy';

import { IFlagService } from '#/app/flag/flag';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import {
  IAgentExecPolicyService,
  type ExecPolicyEvaluation,
} from '#/agent/execPolicy/execPolicy';
import { EXEC_POLICY_FLAG_ID } from '#/agent/execPolicy/flag';
import type {
  PermissionPolicy,
  PermissionPolicyContext,
  PermissionPolicyResult,
} from '#/agent/permissionPolicy/types';

function bashCommandText(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const command = (args as { readonly command?: unknown }).command;
  return typeof command === 'string' ? command : undefined;
}

function describeRule(rule: ExecRule | undefined): string | null {
  if (rule === undefined) return null;
  if (rule.kind === 'prefix_rule') {
    return `prefix_rule(${rule.pattern.join(' ')})`;
  }
  return `network_rule(${rule.host})`;
}

export class ExecPolicyPermissionPolicyService implements PermissionPolicy {
  readonly name = 'exec-policy';

  constructor(
    @IAgentExecPolicyService private readonly execPolicy: IAgentExecPolicyService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IFlagService private readonly flags: IFlagService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentPermissionModeService private readonly modeService: IAgentPermissionModeService,
  ) {}

  async evaluate(context: PermissionPolicyContext): Promise<PermissionPolicyResult | undefined> {
    if (!this.flags.enabled(EXEC_POLICY_FLAG_ID)) return undefined;
    if (context.toolCall.name !== 'Bash') return undefined;
    const command = bashCommandText(context.args);
    if (command === undefined) return undefined;
    const evaluation = await this.execPolicy.evaluate(command);
    const verdict: string = evaluation.verdict;
    const ruleSource: string = evaluation.matchedRule?.source ?? 'none';
    this.telemetry.track2('exec_policy_decision', {
      verdict,
      rule_source: ruleSource,
      segment_count: evaluation.segmentCount,
    });
    return this.toResult(evaluation);
  }

  private toResult(evaluation: ExecPolicyEvaluation): PermissionPolicyResult | undefined {
    const matched = describeRule(evaluation.matchedRule);
    const reason = {
      exec_policy: evaluation.verdict,
      matched_rule: matched,
      rule_source: evaluation.matchedRule?.source ?? null,
      justification: evaluation.matchedRule?.justification ?? null,
    } as const;
    switch (evaluation.verdict) {
      case 'forbidden':
        return { kind: 'deny', reason };
      case 'allow':
        return { kind: 'approve', reason };
      case 'prompt':
      case 'unanalyzable':
        if (this.bootstrap.args.nonInteractive && this.modeService.mode !== 'yolo') {
          return { kind: 'deny', reason: { ...reason, prompt_suppressed: true } };
        }
        if (this.modeService.mode !== 'manual') {
          return { kind: 'approve', reason: { ...reason, prompt_suppressed: true } };
        }
        return {
          kind: 'ask',
          reason:
            evaluation.verdict === 'unanalyzable'
              ? { ...reason, unanalyzable_command: true }
              : reason,
        };
      case 'none':
        return undefined;
    }
  }
}
