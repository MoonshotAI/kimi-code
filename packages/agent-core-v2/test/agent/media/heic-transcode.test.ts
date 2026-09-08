import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { Jimp } from 'jimp';
import { describe, expect, it } from 'vitest';

import { runCommand } from '#/app/capability/host';
import type { ITelemetryService, TelemetryProperties } from '#/app/telemetry/telemetry';
import { sniffImageDimensions } from '#/agent/media/file-type';
import {
  canTranscodeHeic,
  createImageTranscoder,
  isHeicMime,
  transcodeHeicToJpeg,
} from '#/agent/media/heic-transcode';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';

import { fakeSips, heicBytes, tinyJpeg } from './fakeSips';

const MAC = 'macOS';

interface Recorded {
  readonly event: string;
  readonly properties: Readonly<Record<string, unknown>> | undefined;
}

function recordingTelemetry(records: Recorded[]): ITelemetryService {
  const telemetry: ITelemetryService = {
    _serviceBrand: undefined,
    track2(event, properties) {
      records.push({ event, properties: properties as TelemetryProperties });
    },
    withContext: () => telemetry,
    setContext: () => {},
    getContext: () => ({}),
    addAppender: () => ({ dispose: () => {} }),
    removeAppender: () => {},
    setEnabled: () => {},
    flush: async () => {},
    shutdown: async () => {},
  };
  return telemetry;
}

describe('isHeicMime', () => {
  it('recognizes HEIC and HEIF, ignoring case and parameters', () => {
    expect(isHeicMime('image/heic')).toBe(true);
    expect(isHeicMime('image/heif')).toBe(true);
    expect(isHeicMime('IMAGE/HEIC; charset=binary')).toBe(true);
    expect(isHeicMime('image/avif')).toBe(false);
    expect(isHeicMime('image/jpeg')).toBe(false);
  });
});

describe('canTranscodeHeic', () => {
  it('offers conversion only on macOS with a process service', () => {
    const sips = fakeSips();
    expect(canTranscodeHeic({ osKind: MAC, process: sips.service })).toBe(true);
    expect(canTranscodeHeic({ osKind: 'Linux', process: sips.service })).toBe(false);
    expect(canTranscodeHeic({ osKind: 'Windows', process: sips.service })).toBe(false);
    expect(canTranscodeHeic({ osKind: MAC, process: undefined })).toBe(false);
  });
});

describe('transcodeHeicToJpeg', () => {
  it('returns null without spawning anything on hosts other than macOS', async () => {
    const sips = fakeSips();

    const result = await transcodeHeicToJpeg({ bytes: heicBytes() }, 'image/heic', {
      osKind: 'Linux',
      process: sips.service,
    });

    expect(result).toBeNull();
    expect(sips.calls).toEqual([]);
  });

  it('returns null without spawning for images that are not HEIC', async () => {
    const sips = fakeSips();

    const result = await transcodeHeicToJpeg({ bytes: Buffer.from('BM') }, 'image/bmp', {
      osKind: MAC,
      process: sips.service,
    });

    expect(result).toBeNull();
    expect(sips.calls).toEqual([]);
  });

  it('converts HEIC bytes through sips into JPEG and removes its scratch directory', async () => {
    const sips = fakeSips({ output: tinyJpeg(6, 4) });

    const result = await transcodeHeicToJpeg({ bytes: heicBytes() }, 'image/heic', {
      osKind: MAC,
      process: sips.service,
    });

    expect(result).toEqual({ data: tinyJpeg(6, 4), mimeType: 'image/jpeg' });
    expect(sips.calls).toHaveLength(1);
    const call = sips.calls[0]!;
    expect(call.command).toBe('sips');
    const outIndex = call.args.indexOf('--out');
    expect(call.args.slice(0, outIndex - 1)).toEqual([
      '-s', 'format', 'jpeg', '-s', 'formatOptions', '90',
    ]);
    const source = call.args[outIndex - 1]!;
    const target = call.args[outIndex + 1]!;
    expect(source.endsWith('.heic')).toBe(true);
    expect(target.endsWith('.jpg')).toBe(true);
    expect(dirname(source)).toBe(dirname(target));
    expect(existsSync(dirname(target))).toBe(false);
  });

  it('hands a path input to sips directly instead of copying the file', async () => {
    const sips = fakeSips();

    const result = await transcodeHeicToJpeg({ path: '/photos/IMG_0001.HEIC' }, 'image/heif', {
      osKind: MAC,
      process: sips.service,
    });

    expect(result?.mimeType).toBe('image/jpeg');
    const call = sips.calls[0]!;
    const outIndex = call.args.indexOf('--out');
    expect(call.args[outIndex - 1]).toBe('/photos/IMG_0001.HEIC');
    expect(existsSync(dirname(call.args[outIndex + 1]!))).toBe(false);
  });

  it.each([
    { name: 'sips exits non-zero', options: { exitCode: 1 } },
    { name: 'sips writes no output file', options: { output: null } },
    { name: 'sips cannot be spawned', options: { spawnError: new Error('ENOENT') } },
  ])('returns null and cleans up when $name', async ({ options }) => {
    const sips = fakeSips(options);

    const result = await transcodeHeicToJpeg({ bytes: heicBytes() }, 'image/heic', {
      osKind: MAC,
      process: sips.service,
    });

    expect(result).toBeNull();
    const call = sips.calls[0]!;
    const outIndex = call.args.indexOf('--out');
    expect(existsSync(dirname(call.args[outIndex + 1]!))).toBe(false);
  });

  it('reports the conversion outcome to telemetry', async () => {
    const records: Recorded[] = [];
    const telemetry = recordingTelemetry(records);

    await transcodeHeicToJpeg({ bytes: heicBytes() }, 'image/heic', {
      osKind: MAC,
      process: fakeSips({ output: tinyJpeg() }).service,
      telemetry,
      telemetrySource: 'read_media',
    });
    await transcodeHeicToJpeg({ bytes: heicBytes() }, 'image/heic', {
      osKind: MAC,
      process: fakeSips({ exitCode: 2 }).service,
      telemetry,
      telemetrySource: 'read_media',
    });

    expect(records.map((record) => record.event)).toEqual(['image_transcode', 'image_transcode']);
    expect(records[0]!.properties).toMatchObject({
      source: 'read_media',
      outcome: 'converted',
      input_mime: 'image/heic',
      original_bytes: heicBytes().length,
      final_bytes: tinyJpeg().length,
    });
    expect(records[1]!.properties).toMatchObject({ outcome: 'command_failed' });
  });

  it('createImageTranscoder binds the host so callers only pass bytes', async () => {
    const sips = fakeSips({ output: tinyJpeg(2, 2) });
    const transcode = createImageTranscoder({ osKind: MAC, process: sips.service });

    expect(await transcode(heicBytes(), 'image/heic')).toEqual({
      data: tinyJpeg(2, 2),
      mimeType: 'image/jpeg',
    });
    expect(await transcode(Buffer.from('BM'), 'image/bmp')).toBeNull();
  });

  describe.skipIf(process.platform !== 'darwin')('with the real macOS sips', () => {
    it('converts a HEIC written by sips itself back into a decodable JPEG', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'heic-real-'));
      try {
        const pngPath = join(dir, 'source.png');
        const heicPath = join(dir, 'source.heic');
        await new Jimp({ width: 40, height: 24, color: 0x3366ccff }).write(pngPath as `${string}.png`);
        const process = new HostProcessService();
        const encoded = await runCommand(process, 'sips', ['-s', 'format', 'heic', pngPath, '--out', heicPath]);
        expect(encoded.code).toBe(0);
        const bytes = await readFile(heicPath);

        const result = await transcodeHeicToJpeg({ bytes }, 'image/heic', { osKind: MAC, process });

        expect(result?.mimeType).toBe('image/jpeg');
        expect([...result!.data.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
        expect(sniffImageDimensions(result!.data)).toMatchObject({ width: 40, height: 24 });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
