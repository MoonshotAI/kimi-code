import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IAgentKaos } from '#/kaos/kaos';
import type { ILogger } from '#/log/log';

import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IEnvironmentService } from '#/environment/environment';
import { ILogService } from '#/log/log';
import { IAgentRecords } from '#/records/records';
import { IConfigRegistry, IConfigService } from '#/config/config';

import { AgentConfigService, ConfigRegistry, ConfigService } from '#/config/configService';

const noopLogger: ILogger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  child: () => noopLogger,
};

const noopLog: ILogService = {
  ...noopLogger,
  _serviceBrand: undefined,
  level: 'info',
  setLevel: () => {},
};

const unusedEnv: IEnvironmentService = {
  _serviceBrand: undefined,
  homeDir: '',
  configPath: '',
  detect: () => Promise.reject(new Error('unused')),
};

const unusedRecords: IAgentRecords = {
  _serviceBrand: undefined,
  logRecord: () => Promise.resolve(),
  // eslint-disable-next-line @typescript-eslint/require-await
  replay: async function* () {},
  restore: () => Promise.resolve(),
};

describe('ConfigRegistry', () => {
  it('registers and retrieves a section', () => {
    const reg = new ConfigRegistry();
    const schema = { type: 'object' };
    reg.registerSection('permission', schema);
    expect(reg.getSection('permission')).toEqual({ domain: 'permission', schema });
    expect(reg.getSection('missing')).toBeUndefined();
  });

  it('throws when the same domain is registered twice', () => {
    const reg = new ConfigRegistry();
    reg.registerSection('permission', { type: 'object' });
    expect(() => reg.registerSection('permission', { type: 'object' })).toThrow(
      /already registered/,
    );
  });

  it('deep-merges patches', () => {
    const reg = new ConfigRegistry();
    const merged = reg.merge({ a: 1, nested: { x: 1, y: 2 } }, { nested: { y: 3, z: 4 }, b: 2 });
    expect(merged).toEqual({ a: 1, b: 2, nested: { x: 1, y: 3, z: 4 } });
  });
});

describe('ConfigService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(IConfigRegistry, new ConfigRegistry());
    ix.stub(IEnvironmentService, unusedEnv);
    ix.stub(ILogService, noopLog);
  });
  afterEach(() => disposables.dispose());

  it('set merges and get reads back', async () => {
    const svc = disposables.add(ix.createInstance(ConfigService));
    await svc.set('agent', { modelAlias: 'k2', nested: { a: 1 } });
    await svc.set('agent', { nested: { b: 2 } });
    expect(svc.get('agent')).toEqual({ modelAlias: 'k2', nested: { a: 1, b: 2 } });
  });

  it('fires onDidChange with the domain', async () => {
    const svc = disposables.add(ix.createInstance(ConfigService));
    const fired: string[] = [];
    disposables.add(svc.onDidChange((e) => fired.push(e.domain)));
    await svc.set('agent', { modelAlias: 'k2' });
    await svc.set('tool', { x: 1 });
    expect(fired).toEqual(['agent', 'tool']);
  });
});

describe('AgentConfigService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let agentSection: Record<string, unknown>;

  const agentKaos: IAgentKaos = {
    _serviceBrand: undefined,
    get kaos(): never {
      throw new Error('unused');
    },
    cwd: '/repo',
    chdir: () => Promise.resolve(),
  };

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    agentSection = {};
    ix.stub(IConfigService, { get: <T>() => agentSection as T });
    ix.stub(IAgentRecords, unusedRecords);
    ix.stub(IAgentKaos, agentKaos);
  });
  afterEach(() => disposables.dispose());

  it('reads the agent section and cwd from kaos', () => {
    agentSection = { modelAlias: 'k2', systemPrompt: 'hi', provider: 'p' };
    const view = ix.createInstance(AgentConfigService);
    expect(view.modelAlias).toBe('k2');
    expect(view.systemPrompt).toBe('hi');
    expect(view.provider).toBe('p');
    expect(view.thinkingLevel).toBeUndefined();
    expect(view.cwd).toBe('/repo');
  });

  it('setModel / setThinking update the view', async () => {
    const view = ix.createInstance(AgentConfigService);
    await view.setModel('k1');
    await view.setThinking('high');
    expect(view.modelAlias).toBe('k1');
    expect(view.thinkingLevel).toBe('high');
  });
});
