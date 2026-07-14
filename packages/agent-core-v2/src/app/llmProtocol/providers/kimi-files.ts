import * as fs from 'node:fs';
import * as path from 'node:path';
import { Blob, File } from 'node:buffer';

import { ChatProviderError } from '../errors';
import type { VideoURLPart } from '../message';
import type { ProviderRequestAuth, VideoUploadInput } from '../provider';
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

  async uploadVideo(
    input: string | VideoUploadInput,
    options?: KimiUploadOptions,
  ): Promise<VideoURLPart> {
    let file: unknown;

    if (typeof input === 'string') {
      if (!fs.existsSync(input)) {
        throw new ChatProviderError(`Video file not found: ${input}`);
      }
      const filename = path.basename(input);
      const mimeType = guessMimeTypeFromExt(filename);
      if (mimeType === undefined || !mimeType.startsWith('video/')) {
        throw new ChatProviderError(
          `KimiFiles.uploadVideo: file extension does not indicate a video type: ${filename}`,
        );
      }
      const data = await fs.promises.readFile(input);
      const blob = new Blob([new Uint8Array(data)], { type: mimeType });
      file = new File([blob], filename, { type: mimeType });
    } else {
      if (!input.mimeType.startsWith('video/')) {
        throw new ChatProviderError(`Expected a video mime type, got ${input.mimeType}`);
      }
      const filename = input.filename ?? guessFilename(input.mimeType);
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

function guessMimeTypeFromExt(filename: string): string | undefined {
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return undefined;
  const ext = filename.slice(dot + 1).toLowerCase();
  return EXT_TO_MIME[ext];
}
