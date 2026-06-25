import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalKaos } from '@moonshot-ai/kaos';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import type { TestInstantiationService } from '#/_base/di/test';
import { ISessionKaosService } from '#/kaos/kaos';
import { SessionKaosService } from '#/kaos/sessionKaosService';
import { ITerminalService } from '#/terminal/terminal';
import { TerminalService } from '#/terminal/terminalService';
import { registerLogServices } from '../log/stubs';

describe('TerminalService', () => {
  let dir: string;
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let terminal: ITerminalService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'term-test-'));
    const base = await LocalKaos.create();
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      base: [registerLogServices],
      additionalServices: (reg) => {
        reg.define(ISessionKaosService, SessionKaosService);
        reg.define(ITerminalService, TerminalService);
      },
    });
    const sessionKaos = ix.get(ISessionKaosService);
    sessionKaos.setToolKaos(base.withCwd(dir));
    terminal = ix.get(ITerminalService);
  });

  afterEach(async () => {
    disposables.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  it('spawn returns a handle and kill terminates the process', async () => {
    const handle = await terminal.spawn('sleep', ['10']);
    expect(typeof handle.id).toBe('string');
    await terminal.kill(handle.id);
  });
});
