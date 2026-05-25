import type { Agent } from '../..';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../policy';
import { fileInputDisplay, resolvePathToolAccess } from './utils';

export class CwdOutsideAskPermissionPolicy implements PermissionPolicy {
  readonly name = 'system.ask.cwd-outside-path';

  constructor(private readonly agent: Agent) {}

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    const access = resolvePathToolAccess(this.agent, context);
    if (access === undefined || !access.outsideCwd) return undefined;

    return {
      kind: 'ask',
      action: outsideCwdAction(context.toolCall.function.name),
      display: fileInputDisplay(access, 'Path is outside the current working directory.'),
    };
  }
}

function outsideCwdAction(tool: string): string {
  switch (tool) {
    case 'Read':
      return 'read file outside of working directory';
    case 'ReadMediaFile':
      return 'read media file outside of working directory';
    case 'Write':
      return 'write file outside of working directory';
    case 'Edit':
      return 'edit file outside of working directory';
    default:
      return `call ${tool} outside of working directory`;
  }
}
