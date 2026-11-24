import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ISessionManager } from '@moonshot-ai/agent-core-v2';
import { createDecorator, ScopeActivation } from '@moonshot-ai/agent-core-v2/_base/di/instantiation';
import { Service } from '@moonshot-ai/agent-core-v2/_base/di/service';
import { IFeatureManager } from '@moonshot-ai/agent-core-v2/app/feature/featureManager';
import { LifecycleScope } from '@moonshot-ai/agent-core-v2/app/scopes';
import { Feature } from '@moonshot-ai/agent-core-v2/features/feature';
import { ISessionContext } from '@moonshot-ai/agent-core-v2/session/sessionContext/sessionContext';
import { afterEach, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

interface IHostSessionProbe {
  readonly _serviceBrand: undefined;
  readonly sessionId: string;
}

const IHostSessionProbe = createDecorator<IHostSessionProbe>('hostSessionProbe');

class HostSessionProbe extends Service implements IHostSessionProbe {
  declare readonly _serviceBrand: undefined;
  readonly sessionId: string;

  constructor(@ISessionContext context: ISessionContext) {
    super();
    this.sessionId = context.sessionId;
  }
}

class HostProbeFeature extends Feature {
  static override readonly name = 'hostProbe';

  constructor() {
    super();
    this.contributeService(LifecycleScope.Session, IHostSessionProbe, HostSessionProbe, {
      activation: ScopeActivation.OnScopeCreated,
    });
  }
}

let server: RunningServer | undefined;
let home: string | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  if (home !== undefined) await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  home = undefined;
});

async function start(features?: Parameters<typeof startServer>[0]['features']): Promise<RunningServer> {
  home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-host-features-'));
  server = await startServer({
    hostIdentity: TEST_HOST_IDENTITY,
    host: '127.0.0.1',
    port: 0,
    homeDir: home,
    logLevel: 'silent',
    ...(features === undefined ? {} : { features }),
  });
  return server;
}

it('provides host features passed to startServer before sessions are created', async () => {
  const running = await start([HostProbeFeature]);
  expect(running.core.accessor.get(IFeatureManager).units().map((unit) => unit.name)).toContain('hostProbe');

  const session = await running.core.accessor.get(ISessionManager).create({ workDir: home as string });

  expect(session.accessor.get(IHostSessionProbe).sessionId).toBe(session.accessor.get(ISessionContext).sessionId);
});

it('provides no host features when none are passed', async () => {
  const running = await start();
  expect(running.core.accessor.get(IFeatureManager).units().map((unit) => unit.name)).not.toContain('hostProbe');
});
