import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

export interface IArtexSessionContext {
  readonly _serviceBrand: undefined;
  readonly workspaceRoot: string;
  readonly onDidChangeActiveExplorationId?: Event<number | undefined>;
  getActiveExplorationId(): number | undefined;
  setActiveExplorationId(explorationId: number | undefined): void;
}

export const IArtexSessionContext: ServiceIdentifier<IArtexSessionContext> =
  createDecorator<IArtexSessionContext>('artexSessionContext');

export class ArtexSessionContext extends Disposable implements IArtexSessionContext {
  declare readonly _serviceBrand: undefined;

  private activeExplorationId: number | undefined;
  private readonly onDidChangeEmitter = this._register(new Emitter<number | undefined>());

  readonly onDidChangeActiveExplorationId: Event<number | undefined> =
    this.onDidChangeEmitter.event;

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
    if (this.activeExplorationId === explorationId) return;
    this.activeExplorationId = explorationId;
    this.onDidChangeEmitter.fire(explorationId);
  }
}
