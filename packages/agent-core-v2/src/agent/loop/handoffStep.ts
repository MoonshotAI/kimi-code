import { ContinuationStepRequest } from './stepRequest';

export const HANDOFF_STEP_KIND = 'handoff';

export interface HandoffStepObserver {
  onMaterialize(): void;
  onAbort(): void;
}

export class HandoffStepRequest extends ContinuationStepRequest {
  constructor(private readonly observer: HandoffStepObserver) {
    super({ kind: HANDOFF_STEP_KIND });
  }

  override onWillMaterialize(): void {
    this.observer.onMaterialize();
  }

  override abort(): boolean {
    const aborted = super.abort();
    if (aborted) this.observer.onAbort();
    return aborted;
  }
}
