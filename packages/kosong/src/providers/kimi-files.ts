import * as fs from 'node:fs';
import * as path from 'node:path';
import { Blob, File } from 'node:buffer';

import { ChatProviderError } from '#/errors';
import type { VideoURLPart } from '#/message';
import type { ProviderRequestAuth, VideoUploadInput } from '#/provider';
import type OpenAI from 'openai';
import OpenAIClient from 'openai';

import { convertOpenAIError } from './openai-common';
import {
  mergeRequestHeaders,
  requireProviderApiKey,
  resolveAuthBackedClient,
} from './request-auth';

export interface KimiUploadOptions {
  auth?: ProviderRequestAuth;
  signal?: AbortSignal;
}

export interface KimiFilesOptions {
  apiKey?: string;
  baseUrl: string;
  defaultHeaders?: Record<string, string>;
  clientFactory?: (auth: ProviderRequestAuth) => OpenAI;
}

/**
 * Kimi-specific file upload client.
 *
 * Wraps the underlying OpenAI-compatible `files.create` API to upload videos
 * to Moonshot's file service and return them as {@link VideoURLPart} values
 * suitable for use in chat messages.
 *
 * A `KimiFiles` instance is typically obtained from
 * {@link KimiChatProvider.files}.
 */
export class KimiFiles {
  private readonly _apiKey: string | undefined;
  private readonly _baseUrl: string;
  private readonly _defaultHeaders: Record<string, string> | undefined;
  private readonly _client: OpenAI | undefined;
  private readonly _clientFactory: ((auth: ProviderRequestAuth) => OpenAI) | undefined;

  constructor(options: KimiFilesOptions) {
    this._apiKey = options.apiKey;
    this._baseUrl = options.baseUrl;
    this._defaultHeaders = options.defaultHeaders;
    this._clientFactory = options.clientFactory;
    this._client =
      options.apiKey === undefined || options.apiKey.length === 0
        ? undefined
        : new OpenAIClient({
            apiKey: options.apiKey,
            baseURL: options.baseUrl,
            defaultHeaders: options.defaultHeaders,
          });
  }

  /**
   * Upload a video file to Kimi/Moonshot for use in chat messages.
   *
   * Accepts either a local filesystem path or an in-memory
   * {@link VideoUploadInput}. Returns a {@link VideoURLPart} referencing the
   * uploaded file by its Moonshot file id.
   *
   * @param input - Local path string or `{ data, mimeType }` object.
   * @returns A `VideoURLPart` whose `url` references the uploaded file
   *          by its Moonshot file id (e.g. `ms://<file-id>`).
   * @throws {ChatProviderError} if the input is not a video or the upload
   *         fails.
   */
  async uploadVideo(
    input: string | VideoUploadInput,
    options?: KimiUploadOptions,
  ): Promise<VideoURLPart> {
    let file: unknown;

    if (typeof input === 'string') {
      // Validate the path eagerly so callers get a clear synchronous-ish
      // failure rather than a generic stream error from the upload pipeline.
      if (!fs.existsSync(input)) {
        throw new ChatProviderError(`Video file not found: ${input}`);
      }
      const filename = path.basename(input);
      // Infer mime type from the file extension and reject anything that is
      // not a recognised video type. Without this check, callers passing a
      // non-video file (e.g. `note.txt`) would still hit the upload API and
      // fail with a confusing server error; surfacing the issue here keeps
      // the API contract honest and matches the `VideoUploadInput` branch.
      const mimeType = guessMimeTypeFromExt(filename);
      if (mimeType === undefined || !mimeType.startsWith('video/')) {
        throw new ChatProviderError(
          `KimiFiles.uploadVideo: file extension does not indicate a video type: ${filename}`,
        );
      }
      // Read the file into memory and wrap it in a File/Blob. We avoid
      // `fs.createReadStream` here because a still-open stream would race
      // with callers that delete the source file after `uploadVideo`
      // resolves (also common in tests with tmp directories).
      const data = await fs.promises.readFile(input);
      const blob = new Blob([new Uint8Array(data)], { type: mimeType });
      file = new File([blob], filename, { type: mimeType });
    } else {
      if (!input.mimeType.startsWith('video/')) {
        throw new ChatProviderError(`Expected a video mime type, got ${input.mimeType}`);
      }
      const filename = input.filename ?? guessFilename(input.mimeType);
      // The OpenAI SDK's `Uploadable` accepts a File-like object. We build
      // one via the standard Web `File` constructor (available in Node 20+).
      // `Blob` and `File` are available as globals in Node 20+. The cast via
      // `Uint8Array` satisfies `BlobPart` in both Node and DOM lib contexts.
      const bytes = input.data instanceof Uint8Array ? input.data : new Uint8Array(input.data);
      const blob = new Blob([bytes], { type: input.mimeType });
      file = new File([blob], filename, { type: input.mimeType });
    }

    let uploaded: { id: string };
    try {
      const client = this._createClient(options?.auth);
      uploaded = (await client.files.create(
        {
          file: file as never,
          purpose: 'video' as never,
        },
        options?.signal ? { signal: options.signal } : undefined,
      )) as unknown as { id: string };
    } catch (error: unknown) {
      throw convertOpenAIError(error);
    }

    return {
      type: 'video_url',
      videoUrl: {
        url: `ms://${uploaded.id}`,
        id: uploaded.id,
      },
    };
  }

  private _createClient(auth: ProviderRequestAuth | undefined): OpenAI {
    return resolveAuthBackedClient(
      { cachedClient: this._client, clientFactory: this._clientFactory },
      auth,
      (a) => {
        const defaultHeaders = mergeRequestHeaders(this._defaultHeaders, a?.headers);
        return new OpenAIClient({
          apiKey: requireProviderApiKey('KimiFiles.uploadVideo', a, this._apiKey),
          baseURL: this._baseUrl,
          defaultHeaders,
        });
      },
    );
  }
}

/**
 * Guess a filename for an upload from a video MIME type.
 * Falls back to `upload.bin` for unknown types.
 */
function guessFilename(mimeType: string): string {
  const ext = MIME_TO_EXT[mimeType.toLowerCase()] ?? 'bin';
  return `upload.${ext}`;
}

const MIME_TO_EXT: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/mpeg': 'mpeg',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
  'video/x-msvideo': 'avi',
  'video/x-flv': 'flv',
  'video/3gpp': '3gp',
};

const EXT_TO_MIME: Record<string, string> = Object.fromEntries(
  Object.entries(MIME_TO_EXT).map(([mime, ext]) => [ext, mime]),
);

/**
 * Guess a MIME type from a filename extension. Only recognises the video
 * types listed in {@link MIME_TO_EXT}; returns `undefined` otherwise.
 */
function guessMimeTypeFromExt(filename: string): string | undefined {
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return undefined;
  const ext = filename.slice(dot + 1).toLowerCase();
  return EXT_TO_MIME[ext];
}
