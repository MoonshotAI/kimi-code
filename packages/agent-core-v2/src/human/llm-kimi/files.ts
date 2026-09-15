import { Blob, File } from 'node:buffer';

import type OpenAI from 'openai';
import OpenAIClient from 'openai';

import type { VideoURLPart } from '#/llm/message';
import type { VideoUploadInput } from '#/llm/media/upload';

export interface KimiUploadOptions {
  signal?: AbortSignal;
}

export interface KimiFilesOptions {
  apiKey?: string;
  baseUrl: string;
  defaultHeaders?: Record<string, string>;
}

export class KimiFiles {
  private readonly _client: OpenAI | undefined;

  constructor(options: KimiFilesOptions) {
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
    input: VideoUploadInput,
    options?: KimiUploadOptions,
  ): Promise<VideoURLPart> {
    if (!input.mimeType.startsWith('video/')) {
      throw new Error(`Expected a video mime type, got ${input.mimeType}`);
    }
    const filename = input.filename ?? guessFilename(input.mimeType);
    const bytes = input.data instanceof Uint8Array ? input.data : new Uint8Array(input.data);
    const blob = new Blob([bytes], { type: input.mimeType });
    const file = new File([blob], filename, { type: input.mimeType });

    const client = this._createClient();
    const uploaded = (await client.files.create(
      {
        file: file as never,
        purpose: 'video' as never,
      },
      options?.signal ? { signal: options.signal } : undefined,
    )) as unknown as { id: string };

    return {
      type: 'video_url',
      videoUrl: {
        url: `ms://${uploaded.id}`,
        id: uploaded.id,
      },
    };
  }

  private _createClient(): OpenAI {
    if (this._client === undefined) {
      throw new Error('KimiFiles.uploadVideo: apiKey is required');
    }
    return this._client;
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
