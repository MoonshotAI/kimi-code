import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import './flag';
import { IAgentFileHistoryService } from './fileHistory';
import { AgentFileHistoryService } from './fileHistoryService';

export class FileHistoryFeature extends Feature {
  static override readonly name = 'fileHistory';

  constructor() {
    super();
    this.contributeAgentService(IAgentFileHistoryService, AgentFileHistoryService);
  }
}

registerFeature(FileHistoryFeature);
