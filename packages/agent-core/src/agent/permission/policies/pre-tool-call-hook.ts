import type { Agent } from '../..';
import { isPlainRecord } from '../../turn/canonical-args';
import {
  renderAllowedHookResult,
  resolveHookBlockDecision,
  type RenderedHookResult,
} from '../../../session/hooks';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';

export class PreToolCallHookPermissionPolicy implements PermissionPolicy {
  readonly name = 'pre-tool-call-hook';

  constructor(
    private readonly agent: Agent,
    private readonly onAllowedResult?: (toolCallId: string, result: RenderedHookResult) => void,
  ) {}

  async evaluate(context: PermissionPolicyContext): Promise<PermissionPolicyResult | undefined> {
    const hookResults = await this.agent.hooks?.trigger?.('PreToolUse', {
      matcherValue: context.toolCall.name,
      signal: context.signal,
      inputData: {
        toolName: context.toolCall.name,
        toolInput: isPlainRecord(context.args) ? context.args : {},
        toolCallId: context.toolCall.id,
      },
    });
    context.signal.throwIfAborted();
    if (hookResults === undefined) return;
    const block = resolveHookBlockDecision('PreToolUse', hookResults);
    if (block === undefined) {
      const allowed = renderAllowedHookResult('PreToolUse', hookResults);
      if (allowed !== undefined) this.onAllowedResult?.(context.toolCall.id, allowed);
      return;
    }
    return {
      kind: 'deny',
      message: block.reason,
    };
  }
}
