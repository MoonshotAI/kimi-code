/**
 * Turn-level prompt media resolution.
 *
 * A video attached directly to a prompt rides in as a `video_url` part whose
 * url is a local `file://` reference (the TUI materializes the paste into a
 * cache copy and points the part at it). That reference must never reach the
 * model or the persisted history: the provider would send the `file://` string
 * verbatim on the wire, and a resumed session would replay it. So the turn
 * resolves every local `file://` video into its final delivered form — an
 * uploaded `ms://` reference, or an inline/tag fallback — BEFORE the prompt is
 * appended to context.
 *
 * Two entry points:
 *   - `resolvePromptMedia` (async): the primary prompt path. Validates and
 *     uploads through the provider's channel (see `deliverVideoContent`),
 *     degrading to a `<video path>` tag on validation failure, re-throwing
 *     auth rejections so the turn fails visibly, and re-throwing the abort
 *     reason when the turn is cancelled mid-upload so the cancellation ends
 *     the turn instead of appending a degraded message.
 *   - `degradeUnresolvedVideoToTag` (sync): the always-safe floor for the few
 *     append sites that cannot await an upload (steer-buffer flushes, the
 *     budget-exhausted goal turn). The local video becomes a `<video path>`
 *     tag the model opens with ReadMediaFile, which uploads it in-turn — the
 *     same path a pasted video took before inline prompt delivery existed.
 */

import { fileURLToPath } from 'node:url';

import type { ContentPart } from '@moonshot-ai/kosong';

import type { Agent } from '..';
import { MEDIA_SNIFF_BYTES, detectFileType } from '../../tools/support/file-type';
import {
  deliverVideoContent,
  inlineVideoSupported,
  isAuthUploadError,
} from '../../tools/support/video-delivery';
import { MAX_MEDIA_BYTES } from '../../tools/builtin/file/read-media';
import { abortReason } from '../../utils/abort';

/** The local filesystem path behind a prompt-attached `file://` video part. */
function localVideoUrl(part: ContentPart): string | undefined {
  return part.type === 'video_url' && part.videoUrl.url.startsWith('file:')
    ? part.videoUrl.url
    : undefined;
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/** A `<video path="…">` tag part the model can open with ReadMediaFile. */
function videoTag(path: string): ContentPart {
  return { type: 'text', text: `<video path="${escapeAttribute(path)}"></video>` };
}

/**
 * Resolve prompt-attached local videos to their final delivered form. Upload
 * through the provider channel when the model supports video and the file
 * validates; otherwise degrade to a `<video path>` tag. Auth rejections from
 * the upload channel propagate so the turn fails visibly. Returns the input
 * unchanged when it carries no local video part.
 */
export async function resolvePromptMedia(
  agent: Agent,
  input: readonly ContentPart[],
  signal?: AbortSignal,
): Promise<readonly ContentPart[]> {
  if (!input.some((part) => localVideoUrl(part) !== undefined)) return input;
  const resolved: ContentPart[] = [];
  for (const part of input) {
    const url = localVideoUrl(part);
    if (url === undefined) {
      resolved.push(part);
      continue;
    }
    resolved.push(await resolveOneVideo(agent, url, signal));
  }
  return resolved;
}

async function resolveOneVideo(
  agent: Agent,
  fileUrl: string,
  signal?: AbortSignal,
): Promise<ContentPart> {
  let path: string;
  try {
    path = fileURLToPath(fileUrl);
  } catch {
    // A malformed file URL cannot name a readable file — degrade to a tag
    // rather than let the raw reference reach the provider.
    return videoTag(fileUrl);
  }
  try {
    // Validation ladder — any failure degrades to a tag (always safe): the
    // model reads the file with ReadMediaFile, which re-validates and uploads.
    if (path.trim().length === 0) return videoTag(path);
    if (!agent.config.modelCapabilities.video_in) return videoTag(path);
    const header = await agent.kaos.readBytes(path, MEDIA_SNIFF_BYTES);
    const fileType = detectFileType(path, header, 'media');
    if (fileType.kind !== 'video') return videoTag(path);
    const stat = await agent.kaos.stat(path);
    if (stat.stSize === 0) return videoTag(path);
    if (stat.stSize > MAX_MEDIA_BYTES) return videoTag(path);

    const data = await agent.kaos.readBytes(path);
    const uploader = agent.tools.videoUploader();
    // No upload channel and a wire that drops inline video (OpenAI family):
    // the tag is the only form that actually reaches the model — an inline
    // part would persist ~4/3× the file size in history just to be degraded
    // to a placeholder on every request.
    if (
      uploader === undefined &&
      agent.config.hasProvider &&
      !inlineVideoSupported(agent.config.provider.name)
    ) {
      return videoTag(path);
    }
    return await deliverVideoContent(
      { data, mimeType: fileType.mimeType, filename: path.split(/[\\/]/).at(-1) },
      uploader,
      signal,
    );
  } catch (error) {
    // A cancelled turn surfaces as its abort reason — whatever error the
    // interrupted read/upload happened to produce, the user's cancellation is
    // the real outcome, not a delivery failure to degrade around. Auth
    // rejections must also surface (credential refresh + clear error); any
    // other read/upload failure degrades to the always-safe tag form.
    if (signal?.aborted) throw abortReason(signal);
    if (isAuthUploadError(error)) throw error;
    return videoTag(path);
  }
}

/**
 * Synchronously replace every prompt-attached local `file://` video part with
 * a `<video path>` tag. The always-safe floor for append sites that cannot
 * await an upload. Returns the input unchanged when it carries no local video.
 */
export function degradeUnresolvedVideoToTag(
  input: readonly ContentPart[],
): readonly ContentPart[] {
  if (!input.some((part) => localVideoUrl(part) !== undefined)) return input;
  return input.map((part) => {
    const url = localVideoUrl(part);
    if (url === undefined) return part;
    try {
      return videoTag(fileURLToPath(url));
    } catch {
      return videoTag(url);
    }
  });
}
