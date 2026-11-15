import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

export interface IArtexSessionContext {
  readonly _serviceBrand: undefined;
  readonly workspaceRoot: string;
  getActiveExplorationId(): number | undefined;
  setActiveExplorationId(explorationId: number | undefined): void;
}

export const IArtexSessionContext: ServiceIdentifier<IArtexSessionContext> =
  createDecorator<IArtexSessionContext>('artexSessionContext');

export class ArtexSessionContext extends Disposable implements IArtexSessionContext {
  declare readonly _serviceBrand: undefined;

  private activeExplorationId: number | undefined;

  constructor(@ISessionContext private readonly sessionContext: ISessionContext) {
    super();
  }

  get workspaceRoot(): string {
    return this.sessionContext.sessionDir;
  }

  getActiveExplorationId(): number | undefined {
    return this.activeExplorationId;
  }

  setActiveExplorationId(explorationId: number | undefined): void {
    this.activeExplorationId = explorationId;
  }
}
