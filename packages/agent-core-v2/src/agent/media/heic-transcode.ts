import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCommand } from '#/app/capability/host';
import type { ImageTranscodeEvent } from '#/app/telemetry/events';
import type { ITelemetryService } from '#/app/telemetry/telemetry';
import type { IHostProcessService } from '#/os/interface/hostProcess';

import { normalizeImageMime } from './image-format-policy';

const HEIC_MIMES: ReadonlySet<string> = new Set(['image/heic', 'image/heif']);

const TRANSCODED_MIME = 'image/jpeg';

const SIPS_JPEG_QUALITY = '90';

const SIPS_TIMEOUT_MS = 15_000;

export interface HeicTranscodeDeps {
  readonly osKind: string;
  readonly process: IHostProcessService | undefined;
  readonly telemetry?: ITelemetryService;
  readonly telemetrySource?: string;
}

export type HeicTranscodeInput =
  | { readonly path: string }
  | { readonly bytes: Uint8Array };

export interface TranscodedImage {
  readonly data: Buffer;
  readonly mimeType: string;
}

export type ImageTranscoder = (
  bytes: Uint8Array,
  mimeType: string,
) => Promise<TranscodedImage | null>;

export function isHeicMime(mimeType: string): boolean {
  return HEIC_MIMES.has(normalizeImageMime(mimeType));
}

export function canTranscodeHeic(deps: Pick<HeicTranscodeDeps, 'osKind' | 'process'>): boolean {
  return deps.osKind === 'macOS' && deps.process !== undefined;
}

export async function transcodeHeicToJpeg(
  input: HeicTranscodeInput,
  mimeType: string,
  deps: HeicTranscodeDeps,
): Promise<TranscodedImage | null> {
  if (!isHeicMime(mimeType) || !canTranscodeHeic(deps)) return null;
  const startedAt = Date.now();
  const originalBytes = 'bytes' in input ? input.bytes.length : undefined;
  const finish = (
    outcome: ImageTranscodeEvent['outcome'],
    result: TranscodedImage | null,
  ): TranscodedImage | null => {
    reportTranscodeEvent(deps.telemetry, deps.telemetrySource, {
      outcome,
      startedAt,
      inputMime: normalizeImageMime(mimeType),
      originalBytes,
      finalBytes: result?.data.length,
    });
    return result;
  };

  let scratchDir: string | undefined;
  try {
    scratchDir = await mkdtemp(join(tmpdir(), 'kimi-heic-'));
    let source: string;
    if ('path' in input) {
      source = input.path;
    } else {
      source = join(scratchDir, 'source.heic');
      await writeFile(source, input.bytes);
    }
    const target = join(scratchDir, 'converted.jpg');
    const result = await runCommand(
      deps.process!,
      'sips',
      ['-s', 'format', 'jpeg', '-s', 'formatOptions', SIPS_JPEG_QUALITY, source, '--out', target],
      { timeout: SIPS_TIMEOUT_MS },
    );
    if (result.code !== 0) return finish('command_failed', null);
    const data = await readFile(target).catch(() => Buffer.alloc(0));
    if (data.length === 0) return finish('empty_output', null);
    return finish('converted', { data, mimeType: TRANSCODED_MIME });
  } catch {
    return finish('error', null);
  } finally {
    if (scratchDir !== undefined) {
      await rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export function createImageTranscoder(deps: HeicTranscodeDeps): ImageTranscoder {
  return (bytes, mimeType) => transcodeHeicToJpeg({ bytes }, mimeType, deps);
}

function reportTranscodeEvent(
  telemetry: ITelemetryService | undefined,
  source: string | undefined,
  input: {
    readonly outcome: ImageTranscodeEvent['outcome'];
    readonly startedAt: number;
    readonly inputMime: string;
    readonly originalBytes: number | undefined;
    readonly finalBytes: number | undefined;
  },
): void {
  if (telemetry === undefined || source === undefined) return;
  try {
    const event: ImageTranscodeEvent = {
      source,
      outcome: input.outcome,
      input_mime: input.inputMime,
      output_mime: TRANSCODED_MIME,
      original_bytes: input.originalBytes,
      final_bytes: input.finalBytes,
      duration_ms: Date.now() - input.startedAt,
    };
    telemetry.track2('image_transcode', event);
  } catch {
  }
}
