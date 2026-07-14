import { describe, expect, it, vi } from 'vitest';

import { registerInteractionPanels, type InteractionModalUIHooks } from '#/tui/interactions/index';
import type { PanelQueueUIHooks } from '#/tui/interactions/panel-queue';
import type { ApprovalPanelData, QuestionPanelData } from '#/tui/interactions/types';

function approvalPanel(id: string): ApprovalPanelData {
  return {
    id,
    tool_call_id: id,
    tool_name: 'Bash',
    action: 'run',
    description: '',
    display: [],
    choices: [],
  };
}

function questionPanel(id: string): QuestionPanelData {
  return { id, tool_call_id: id, questions: [] };
}

interface FakePanelController<TPayload> {
  setUIHooks: ReturnType<typeof vi.fn>;
  show(payload: TPayload): void;
  hide(): void;
}

function fakeController<TPayload>(): FakePanelController<TPayload> {
  let hooks: PanelQueueUIHooks<TPayload> | null = null;
  return {
    setUIHooks: vi.fn((next: PanelQueueUIHooks<TPayload>) => {
      hooks = next;
    }),
    show(payload: TPayload) {
      hooks?.showPanel(payload);
    },
    hide() {
      hooks?.hidePanel();
    },
  };
}

function makeUIHooks(): InteractionModalUIHooks {
  return {
    showApprovalPanel: vi.fn(),
    hideApprovalPanel: vi.fn(),
    showQuestionDialog: vi.fn(),
    hideQuestionDialog: vi.fn(),
  };
}

describe('registerInteractionPanels', () => {
  it('wires controller UI hooks into the modal coordinator', () => {
    const approvalController = fakeController<ApprovalPanelData>();
    const questionController = fakeController<QuestionPanelData>();
    const uiHooks = makeUIHooks();

    registerInteractionPanels(approvalController as never, questionController as never, uiHooks);

    approvalController.show(approvalPanel('approval-1'));
    expect(uiHooks.showApprovalPanel).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'approval-1' }),
    );

    approvalController.hide();
    expect(uiHooks.hideApprovalPanel).toHaveBeenCalledOnce();

    questionController.show(questionPanel('question-1'));
    expect(uiHooks.showQuestionDialog).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'question-1' }),
    );
    questionController.hide();
    expect(uiHooks.hideQuestionDialog).toHaveBeenCalledOnce();
  });

  it('queues question dialogs behind active approval panels', () => {
    const approvalController = fakeController<ApprovalPanelData>();
    const questionController = fakeController<QuestionPanelData>();
    const uiHooks = makeUIHooks();

    registerInteractionPanels(approvalController as never, questionController as never, uiHooks);

    approvalController.show(approvalPanel('approval-1'));
    questionController.show(questionPanel('question-1'));

    expect(uiHooks.showApprovalPanel).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'approval-1' }),
    );
    expect(uiHooks.showQuestionDialog).not.toHaveBeenCalled();

    approvalController.hide();
    expect(uiHooks.hideApprovalPanel).toHaveBeenCalledOnce();
    expect(uiHooks.showQuestionDialog).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'question-1' }),
    );
  });

  it('queues approval panels behind active question dialogs', () => {
    const approvalController = fakeController<ApprovalPanelData>();
    const questionController = fakeController<QuestionPanelData>();
    const uiHooks = makeUIHooks();

    registerInteractionPanels(approvalController as never, questionController as never, uiHooks);

    questionController.show(questionPanel('question-1'));
    approvalController.show(approvalPanel('approval-1'));

    expect(uiHooks.showQuestionDialog).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'question-1' }),
    );
    expect(uiHooks.showApprovalPanel).not.toHaveBeenCalled();

    questionController.hide();
    expect(uiHooks.hideQuestionDialog).toHaveBeenCalledOnce();
    expect(uiHooks.showApprovalPanel).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'approval-1' }),
    );
  });

  it('clears active and queued modals without showing queued entries', () => {
    const approvalController = fakeController<ApprovalPanelData>();
    const questionController = fakeController<QuestionPanelData>();
    const uiHooks = makeUIHooks();

    const disposers = registerInteractionPanels(
      approvalController as never,
      questionController as never,
      uiHooks,
    );

    approvalController.show(approvalPanel('approval-1'));
    questionController.show(questionPanel('question-1'));

    for (const dispose of disposers) dispose();
    expect(uiHooks.hideApprovalPanel).toHaveBeenCalledOnce();
    // The queued question is dropped — it must not be shown after clear.
    expect(uiHooks.showQuestionDialog).not.toHaveBeenCalled();
  });
});
