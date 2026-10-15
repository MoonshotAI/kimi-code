import {
  DEFAULT_WORKSPACE_SECTION,
  IConfigService,
  IEventService,
  IWorkspaceService,
  WorkspaceUpdated,
  type Scope,
} from '@moonshot-ai/agent-core-v2';

import type { ServerLogger } from '../pinoLoggerService';

export interface DefaultWorkspacePublisher {
  close(): void;
}

export function startDefaultWorkspacePublisher(
  core: Scope,
  logger: Pick<ServerLogger, 'warn'>,
): DefaultWorkspacePublisher {
  const config = core.accessor.get(IConfigService);
  const workspaces = core.accessor.get(IWorkspaceService);
  const events = core.accessor.get(IEventService);
  let closed = false;

  const announceAll = async (): Promise<void> => {
    const registered = await workspaces.list();
    if (closed) return;
    for (const workspace of registered) {
      events.publish(new WorkspaceUpdated({ payload: { workspace } }));
    }
  };

  const subscription = config.onDidSectionChange((event) => {
    if (closed || event.domain !== DEFAULT_WORKSPACE_SECTION) return;
    void announceAll().catch((error: unknown) => {
      logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'default workspace changed but workspace updates could not be broadcast',
      );
    });
  });

  return {
    close: () => {
      closed = true;
      subscription.dispose();
    },
  };
}
