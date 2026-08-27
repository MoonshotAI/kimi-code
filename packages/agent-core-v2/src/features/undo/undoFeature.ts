import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';
import { undoAgentRuntimeProvider } from './undoAgentRuntime';

export class UndoFeature extends Feature {
  static override readonly name = 'undo';

  constructor() {
    super();
    this.contributeAgentRuntime(undoAgentRuntimeProvider);
  }
}

registerFeature(UndoFeature);
