import type { ApprovalController } from './approval-controller';
import { InteractionModalCoordinator, type InteractionModalUIHooks } from './modal-coordinator';
import type { QuestionController } from './question-controller';

export type { InteractionModalUIHooks };

/**
 * Wire the approval/question controllers' panel queues into the shared modal
 * coordinator so only one interaction dialog occupies the editor area at a
 * time. Returns disposers that clear the coordinator.
 */
export function registerInteractionPanels(
  approvalController: ApprovalController,
  questionController: QuestionController,
  uiHooks: InteractionModalUIHooks,
): Array<() => void> {
  const modalCoordinator = new InteractionModalCoordinator(uiHooks);

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
