import type { PermissionPolicy } from './chain';

export const autoModeAskUserQuestionDeny: PermissionPolicy = {
  name: 'auto-mode-ask-user-question-deny',
  evaluate(context) {
    if (context.mode !== 'auto') return undefined;
    if (context.toolCall.name !== 'AskUserQuestion') return undefined;
    return {
      kind: 'deny',
      message:
        'AskUserQuestion is disabled while auto permission mode is active. Make a reasonable decision and continue without asking the user.',
    };
  },
};

export const autoModeApprove: PermissionPolicy = {
  name: 'auto-mode-approve',
  evaluate(context) {
    return context.mode === 'auto' ? { kind: 'approve' } : undefined;
  },
};

export const yoloModeApprove: PermissionPolicy = {
  name: 'yolo-mode-approve',
  evaluate(context) {
    return context.mode === 'yolo' ? { kind: 'approve' } : undefined;
  },
};
