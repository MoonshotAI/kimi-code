import type { ApprovalController } from './approval/controller';
import type { QuestionController } from './question/controller';
import { ReverseRpcModalCoordinator } from './modal-coordinator';
import type { ApprovalPanelData, QuestionPanelData } from './types';

export interface ReverseRPCUIHooks {
  readonly showApprovalPanel: (payload: ApprovalPanelData) => void;
  readonly hideApprovalPanel: () => void;
  readonly showQuestionDialog: (payload: QuestionPanelData) => void;
  readonly hideQuestionDialog: () => void;
}

export function registerReverseRPCHandlers(
  approvalController: ApprovalController,
  questionController: QuestionController,
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

  return [
    () => {
      modalCoordinator.clear();
    },
  ];
}
