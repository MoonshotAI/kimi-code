import type { ApprovalController } from './approval/controller';
import { ReverseRpcModalCoordinator } from './modal-coordinator';
import type { PasswordController } from './password/controller';
import type { QuestionController } from './question/controller';
import type { ApprovalPanelData, PasswordDialogData, QuestionPanelData } from './types';

export interface ReverseRPCUIHooks {
  readonly showApprovalPanel: (payload: ApprovalPanelData) => void;
  readonly hideApprovalPanel: () => void;
  readonly showQuestionDialog: (payload: QuestionPanelData) => void;
  readonly hideQuestionDialog: () => void;
  readonly showPasswordDialog: (payload: PasswordDialogData) => void;
  readonly hidePasswordDialog: () => void;
}

export function registerReverseRPCHandlers(
  approvalController: ApprovalController,
  questionController: QuestionController,
  passwordController: PasswordController,
  uiHooks: ReverseRPCUIHooks,
): Array<() => void> {
  const modalCoordinator = new ReverseRpcModalCoordinator(uiHooks);

  // Setup UI hooks for controllers
  approvalController.setUIHooks({
    showPanel: (payload) => {
      modalCoordinator.showApproval(payload);
    },
    hidePanel: () => {
      modalCoordinator.hide('approval');
    },
  });

  questionController.setUIHooks({
    showPanel: (payload) => {
      modalCoordinator.showQuestion(payload);
    },
    hidePanel: () => {
      modalCoordinator.hide('question');
    },
  });

  passwordController.setUIHooks({
    showPanel: (payload) => {
      modalCoordinator.showPassword(payload);
    },
    hidePanel: () => {
      modalCoordinator.hide('password');
    },
  });

  return [
    () => {
      modalCoordinator.clear();
    },
  ];
}
