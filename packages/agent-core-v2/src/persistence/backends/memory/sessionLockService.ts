import { SessionLockHolds } from '#/persistence/interface/sessionLock';

export class InMemorySessionLockService extends SessionLockHolds {
  protected publish(): string {
    return '';
  }

  protected unpublish(): void {}
}
