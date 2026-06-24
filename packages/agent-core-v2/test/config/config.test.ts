import { describe, expect, it } from 'vitest';

import type { IAgentKaos } from '#/kaos/kaos';
import type { ILogService, ILogger } from '#/log/log';
import type { IAgentRecords } from '#/records/records';

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

function makeConfigService(): ConfigService {
  return new ConfigService(
    new ConfigRegistry(),
    undefined as never, // env unused in memory store
    noopLog,
  );
}

describe('ConfigRegistry', () => {
  it('registers and retrieves a section', () => {
    const reg = new ConfigRegistry();
    const schema = { type: 'object' };
    reg.registerSection('permission', schema);
    expect(reg.getSection('permission')).toEqual({ domain: 'permission', schema });
    expect(reg.getSection('missing')).toBeUndefined();
  });

  it('deep-merges patches', () => {
    const reg = new ConfigRegistry();
    const merged = reg.merge({ a: 1, nested: { x: 1, y: 2 } }, { nested: { y: 3, z: 4 }, b: 2 });
    expect(merged).toEqual({ a: 1, b: 2, nested: { x: 1, y: 3, z: 4 } });
  });
});

describe('ConfigService', () => {
  it('set merges and get reads back', async () => {
    const svc = makeConfigService();
    await svc.set('agent', { modelAlias: 'k2', nested: { a: 1 } });
    await svc.set('agent', { nested: { b: 2 } });
    expect(svc.get('agent')).toEqual({ modelAlias: 'k2', nested: { a: 1, b: 2 } });
  });

  it('fires onDidChange with the domain', async () => {
    const svc = makeConfigService();
    const fired: string[] = [];
    svc.onDidChange((e) => fired.push(e.domain));
    await svc.set('agent', { modelAlias: 'k2' });
    await svc.set('tool', { x: 1 });
    expect(fired).toEqual(['agent', 'tool']);
  });
});

describe('AgentConfigService', () => {
  const agentKaos: IAgentKaos = {
    _serviceBrand: undefined,
    get kaos(): never {
      throw new Error('unused');
    },
    cwd: '/repo',
    chdir: () => Promise.resolve(),
  };
  const agentRecords = undefined as unknown as IAgentRecords;

  it('reads the agent section and cwd from kaos', async () => {
    const svc = makeConfigService();
    await svc.set('agent', { modelAlias: 'k2', systemPrompt: 'hi', provider: 'p' });
    const view = new AgentConfigService(svc, agentRecords, agentKaos);
    expect(view.modelAlias).toBe('k2');
    expect(view.systemPrompt).toBe('hi');
    expect(view.provider).toBe('p');
    expect(view.thinkingLevel).toBeUndefined();
    expect(view.cwd).toBe('/repo');
  });

  it('setModel / setThinking update the view', async () => {
    const svc = makeConfigService();
    const view = new AgentConfigService(svc, agentRecords, agentKaos);
    await view.setModel('k1');
    await view.setThinking('high');
    expect(view.modelAlias).toBe('k1');
    expect(view.thinkingLevel).toBe('high');
  });
});
