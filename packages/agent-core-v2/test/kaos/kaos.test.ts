import { describe, expect, it } from 'vitest';

import { LocalKaos } from '@moonshot-ai/kaos';

import type { ILogService, ILogger } from '#/log/log';

import { AgentKaos } from '#/kaos/agentKaos';
import { KaosFactory } from '#/kaos/kaosFactory';
import { SessionKaosService } from '#/kaos/sessionKaosService';

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

describe('KaosFactory', () => {
  it('creates a local kaos', async () => {
    const factory = new KaosFactory(
      // env/log unused for local creation
      undefined as never,
      undefined as never,
    );
    const kaos = await factory.create({ kind: 'local' });
    expect(typeof kaos.getcwd()).toBe('string');
  });

  it('pins to the requested cwd', async () => {
    const factory = new KaosFactory(undefined as never, undefined as never);
    const base = await LocalKaos.create();
    const target = base.getcwd();
    const kaos = await factory.create({ kind: 'local', cwd: target });
    expect(kaos.getcwd()).toBe(target);
  });

  it('throws TODO for ssh', async () => {
    const factory = new KaosFactory(undefined as never, undefined as never);
    await expect(factory.create({ kind: 'ssh', host: 'h' })).rejects.toThrow(/TODO/);
  });
});

describe('SessionKaosService', () => {
  async function make(): Promise<{ svc: SessionKaosService; kaos: LocalKaos }> {
    const svc = new SessionKaosService(noopLog);
    const kaos = await LocalKaos.create();
    svc.setToolKaos(kaos);
    return { svc, kaos };
  }

  it('throws before setToolKaos', () => {
    const svc = new SessionKaosService(noopLog);
    expect(() => svc.toolKaos).toThrow(/before setToolKaos/);
  });

  it('persistenceKaos defaults to toolKaos', async () => {
    const { svc, kaos } = await make();
    expect(svc.persistenceKaos).toBe(kaos);
  });

  it('setPersistenceKaos overrides the default', async () => {
    const { svc } = await make();
    const other = await LocalKaos.create();
    svc.setPersistenceKaos(other);
    expect(svc.persistenceKaos).toBe(other);
  });

  it('additionalDirs add / dedupe / remove', async () => {
    const { svc } = await make();
    svc.addAdditionalDir('/a');
    svc.addAdditionalDir('/b');
    svc.addAdditionalDir('/a');
    expect(svc.additionalDirs).toEqual(['/a', '/b']);
    svc.removeAdditionalDir('/a');
    expect(svc.additionalDirs).toEqual(['/b']);
  });

  it('systemContextKaos is pinned to the tool cwd', async () => {
    const { svc } = await make();
    const sys = svc.systemContextKaos;
    expect(sys.getcwd()).toBe(svc.toolKaos.getcwd());
    expect(sys).not.toBe(svc.toolKaos);
  });
});

describe('AgentKaos', () => {
  it('derives cwd from the session kaos and isolates chdir', async () => {
    const session = new SessionKaosService(noopLog);
    const base = await LocalKaos.create();
    session.setToolKaos(base);

    const agent = new AgentKaos(session);
    expect(agent.cwd).toBe(base.getcwd());

    const next = base.withCwd('/').getcwd();
    await agent.chdir('/');
    expect(agent.cwd).toBe(next);
    // session kaos is untouched
    expect(session.toolKaos.getcwd()).toBe(base.getcwd());
  });
});
