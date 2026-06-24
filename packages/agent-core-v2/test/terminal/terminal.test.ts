import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalKaos } from '@moonshot-ai/kaos';

import type { ILogService, ILogger } from '#/log/log';

import { SessionKaosService } from '#/kaos/sessionKaosService';
import { TerminalService } from '#/terminal/terminalService';

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

describe('TerminalService', () => {
  let dir: string;
  let terminal: TerminalService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'term-test-'));
    const base = await LocalKaos.create();
    const sessionKaos = new SessionKaosService(noopLog);
    sessionKaos.setToolKaos(base.withCwd(dir));
    terminal = new TerminalService(noopLog, sessionKaos);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('spawn returns a handle and kill terminates the process', async () => {
    const handle = await terminal.spawn('sleep', ['10']);
    expect(typeof handle.id).toBe('string');
    await terminal.kill(handle.id);
  });
});
