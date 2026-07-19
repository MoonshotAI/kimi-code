/**
 * `kosong/provider` domain (L2) — Kimi video-upload trait.
 *
 * `kimiVideoUploadTrait.uploadVideo`: uploads through the Kimi files API.
 * The `KimiFiles` client is memoized per trait context with a WeakMap — one
 * composition (one resolved ctx) gets one files client, derived from the
 * same endpoint fallback chain the params trait declares.
 */

import type { ProtocolTrait, TraitContext } from '#/kosong/protocol/protocolTrait';

import { KimiFiles } from './kimi-files';
import { KIMI_API_KEY_ENV, KIMI_BASE_URL_ENV, KIMI_DEFAULT_BASE_URL } from './kimi-params';

const filesByContext = new WeakMap<TraitContext, KimiFiles>();

function firstEnv(...names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}

function resolveFiles(ctx: TraitContext): KimiFiles {
  let files = filesByContext.get(ctx);
  if (files === undefined) {
    files = new KimiFiles({
      apiKey: ctx.config.apiKey ?? firstEnv(KIMI_API_KEY_ENV),
      baseUrl: ctx.config.baseUrl ?? firstEnv(KIMI_BASE_URL_ENV) ?? KIMI_DEFAULT_BASE_URL,
      defaultHeaders:
        ctx.config.defaultHeaders === undefined ? undefined : { ...ctx.config.defaultHeaders },
    });
    filesByContext.set(ctx, files);
  }
  return files;
}

export const kimiVideoUploadTrait: ProtocolTrait = {
  uploadVideo: (input, options, ctx) => resolveFiles(ctx).uploadVideo(input, options),
};
