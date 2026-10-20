import type { ApprovalPanelData, QuestionPanelData } from './types';

export type ReverseRpcModalOwner = 'approval' | 'question';

export interface ReverseRpcModalUIHooks {
  readonly showApprovalPanel: (payload: ApprovalPanelData) => void;
  readonly hideApprovalPanel: () => void;
  readonly showQuestionDialog: (payload: QuestionPanelData) => void;
  readonly hideQuestionDialog: () => void;
}

interface ReverseRpcModalEntry {
  readonly owner: ReverseRpcModalOwner;
  readonly show: () => void;
  readonly hide: () => void;
}

export class ReverseRpcModalCoordinator {
  private active: ReverseRpcModalEntry | null = null;
  private readonly queued: ReverseRpcModalEntry[] = [];

  constructor(private readonly hooks: ReverseRpcModalUIHooks) {}

  showApproval(payload: ApprovalPanelData): void {
    this.show({
      owner: 'approval',
      show: () => {
        this.hooks.showApprovalPanel(payload);
      },
      hide: () => {
        this.hooks.hideApprovalPanel();
      },
    });
  }

  showQuestion(payload: QuestionPanelData): void {
    this.show({
      owner: 'question',
      show: () => {
        this.hooks.showQuestionDialog(payload);
      },
      hide: () => {
        this.hooks.hideQuestionDialog();
      },
    });
  }

  hide(owner: ReverseRpcModalOwner): void {
    if (this.active?.owner === owner) {
      const active = this.active;
      this.active = null;
      active.hide();
      this.showNext();
      return;
    }

    const queuedIndex = this.queued.findIndex((entry) => entry.owner === owner);
    if (queuedIndex >= 0) this.queued.splice(queuedIndex, 1);
  }

  clear(): void {
    const active = this.active;
    this.active = null;
    this.queued.length = 0;
    active?.hide();
  }

  private show(entry: ReverseRpcModalEntry): void {
    const active = this.active;
    if (active === null) {
      this.active = entry;
      entry.show();
      return;
    }

    if (active.owner === entry.owner) {
      this.active = entry;
      entry.show();
      return;
    }

    const queuedIndex = this.queued.findIndex((queued) => queued.owner === entry.owner);
    if (queuedIndex >= 0) {
      this.queued[queuedIndex] = entry;
      return;
    }

    this.queued.push(entry);
  }

  private showNext(): void {
    const next = this.queued.shift();
    if (next === undefined) return;
    this.active = next;
    next.show();
  }
}
