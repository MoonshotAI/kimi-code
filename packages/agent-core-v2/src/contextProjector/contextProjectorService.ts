import type { Message } from '@moonshot-ai/kosong';

import { project } from '../../../agent/context/projector';
import {
  IInstantiationService,
  registerSingleton,
  SyncDescriptor,
} from "#/_base/di";
import { IMicroCompactionService } from '../microCompaction/microCompaction';
import type { ContextMessage } from '../types';
import { IContextProjector } from './contextProjector';

export class ContextProjectorService implements IContextProjector {
  constructor(
    @IInstantiationService private readonly instantiation: IInstantiationService,
  ) {}

  project(messages: readonly ContextMessage[]): readonly Message[] {
    return project(this.microCompaction().compact(messages));
  }

  private microCompaction(): IMicroCompactionService {
    return this.instantiation.invokeFunction((accessor) =>
      accessor.get(IMicroCompactionService),
    );
  }
}

registerSingleton(IContextProjector, new SyncDescriptor(ContextProjectorService, [], true));
