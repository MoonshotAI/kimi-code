import { writeFileSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';

import type { IHostProcess, IHostProcessService } from '#/os/interface/hostProcess';

export function tinyJpeg(width = 4, height = 3): Buffer {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xff, 0xd9,
  ]);
}

export function heicBytes(brand = 'heic'): Buffer {
  const buf = Buffer.alloc(24);
  buf.writeUInt32BE(24, 0);
  buf.write('ftyp', 4, 'latin1');
  buf.write(brand, 8, 'latin1');
  buf.write(brand, 16, 'latin1');
  return buf;
}

export interface FakeSipsCall {
  readonly command: string;
  readonly args: readonly string[];
}

export interface FakeSipsOptions {
  readonly output?: Uint8Array | null;
  readonly exitCode?: number;
  readonly spawnError?: Error;
}

export interface FakeSips {
  readonly service: IHostProcessService;
  readonly calls: FakeSipsCall[];
}

export function fakeSips(options: FakeSipsOptions = {}): FakeSips {
  const calls: FakeSipsCall[] = [];
  const service: IHostProcessService = {
    _serviceBrand: undefined,
    spawn: async (command, args = []) => {
      calls.push({ command, args: [...args] });
      if (options.spawnError !== undefined) throw options.spawnError;
      const exitCode = options.exitCode ?? 0;
      const outIndex = args.indexOf('--out');
      const target = outIndex === -1 ? undefined : args[outIndex + 1];
      if (exitCode === 0 && target !== undefined && options.output !== null) {
        writeFileSync(target, options.output ?? tinyJpeg());
      }
      return fakeProcess(exitCode);
    },
  };
  return { service, calls };
}

function fakeProcess(exitCode: number): IHostProcess {
  return {
    _serviceBrand: undefined,
    pid: 4242,
    exitCode,
    stdin: new Writable({ write: (_chunk, _encoding, callback) => callback() }),
    stdout: Readable.from([]),
    stderr: Readable.from([]),
    wait: async () => exitCode,
    kill: async () => {},
    dispose: () => {},
  };
}
