import type { PermissionPolicy } from '../policy';

export const AskUserQuestionAutoPermissionPolicy: PermissionPolicy = {
  name: 'auto.ask-user-question',
  evaluate({ mode, toolCallContext }) {
    if (mode !== 'auto') return undefined;
    if (toolCallContext.toolCall.name !== 'AskUserQuestion') return undefined;
    return {
      kind: 'result',
      result: {
        block: true,
        reason:
          'AskUserQuestion is disabled while auto permission mode is active. Make a reasonable decision and continue without asking the user.',
      },
    };
  },
};
