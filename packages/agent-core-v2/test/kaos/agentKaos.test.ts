import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type Kaos, LocalKaos } from '@moonshot-ai/kaos';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { AgentKaos } from '#/kaos/agentKaos';
import { IKaosService, ISessionKaosService } from '#/kaos';

function stubSessionKaos(toolKaos: Kaos): ISessionKaosService {
  return {
    _serviceBrand: undefined,
    toolKaos,
    persistenceKaos: toolKaos,
    systemContextKaos: toolKaos,
    additionalDirs: [],
    setToolKaos: () => {},
    setPersistenceKaos: () => {},
    addAdditionalDir: () => {},
    removeAdditionalDir: () => {},
  };
}

describe('AgentKaos', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
  });
  afterEach(() => disposables.dispose());

  it('exposes kaos and cwd from the session toolKaos', async () => {
    const base = await LocalKaos.create();
    ix.set(ISessionKaosService, stubSessionKaos(base.withCwd('/tmp/tool')));
    ix.set(IKaosService, new SyncDescriptor(AgentKaos));

    const agentKaos = ix.get(IKaosService);
    expect(agentKaos.kaos?.getcwd()).toBe('/tmp/tool');
    expect(agentKaos.cwd).toBe('/tmp/tool');
  });

  it('chdir switches the active cwd', async () => {
    const base = await LocalKaos.create();
    ix.set(ISessionKaosService, stubSessionKaos(base.withCwd('/tmp/a')));
    ix.set(IKaosService, new SyncDescriptor(AgentKaos));

    const agentKaos = ix.get(IKaosService);
    await agentKaos.chdir('/tmp/b');
    expect(agentKaos.cwd).toBe('/tmp/b');
  });
});
