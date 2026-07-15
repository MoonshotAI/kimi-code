import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { ISessionProcessRunner } from '#/session/process/processRunner';

function notImplemented(name: string): never {
  throw new Error(`${name} not implemented - override it in the test`);
}

export function createFakeProcessRunner(
  overrides: Partial<ISessionProcessRunner> = {},
): ISessionProcessRunner {
  return {
    _serviceBrand: undefined,
    exec: () => notImplemented('FakeProcessRunner.exec'),
    ...overrides,
  };
}

export function createFakeHostFs(overrides: Partial<IHostFileSystem> = {}): IHostFileSystem {
  const fs: IHostFileSystem = {
    _serviceBrand: undefined,
    readText: () => notImplemented('FakeHostFs.readText'),
    writeText: () => notImplemented('FakeHostFs.writeText'),
    appendText: () => notImplemented('FakeHostFs.appendText'),
    readBytes: () => notImplemented('FakeHostFs.readBytes'),
    writeBytes: () => notImplemented('FakeHostFs.writeBytes'),
    readLines: () => notImplemented('FakeHostFs.readLines'),
    createExclusive: () => notImplemented('FakeHostFs.createExclusive'),
    stat: () => notImplemented('FakeHostFs.stat'),
    readdir: () => notImplemented('FakeHostFs.readdir'),
    mkdir: () => notImplemented('FakeHostFs.mkdir'),
    remove: () => notImplemented('FakeHostFs.remove'),
    realpath: () => notImplemented('FakeHostFs.realpath'),
  };
  return { ...fs, ...overrides };
}
