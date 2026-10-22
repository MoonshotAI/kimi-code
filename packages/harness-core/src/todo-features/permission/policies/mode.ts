import type { PermissionPolicy } from './chain';

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
