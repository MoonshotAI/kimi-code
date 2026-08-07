/**
 * `tools` domain — `ReadMediaFileTool` contract.
 *
 * Public contract of the `ReadMediaFile` tool: the input zod schema the
 * model-facing parameters are derived from, the tool-owned size constants,
 * and the `VideoUploader` channel type for the provider's upload hook. This
 * tool has no DI decorator — it is a deliberate exception to the
 * `registerAgentToolService` contribution table.
 */

import { z } from 'zod';

import type { VideoURLPart } from '#/kosong/contract/message';
import type { VideoUploadInput as ProviderVideoUploadInput } from '#/kosong/contract/provider';

export const MAX_MEDIA_MEGABYTES = 100;
export const MAX_MEDIA_BYTES = MAX_MEDIA_MEGABYTES * 1024 * 1024;

export type VideoUploadInput = ProviderVideoUploadInput;

export type VideoUploader = (
  input: VideoUploadInput,
  options?: { readonly signal?: AbortSignal },
) => Promise<VideoURLPart>;


export const ReadMediaFileInputSchema = z.object({
  path: z
    .string()
    .describe(
      'Path to an image or video file. Relative paths resolve against the working directory; ' +
        'a path outside the working directory must be absolute. ' +
        'Directories and text files are not supported.',
    ),
  region: z
    .object({
      x: z.number().int().min(0).describe('Left edge of the crop, in original-image pixels.'),
      y: z.number().int().min(0).describe('Top edge of the crop, in original-image pixels.'),
      width: z.number().int().min(1).describe('Crop width, in original-image pixels.'),
      height: z.number().int().min(1).describe('Crop height, in original-image pixels.'),
    })
    .optional()
    .describe(
      'Images only: view just this rectangle of the image (original-image pixel coordinates). ' +
        'Use after a downsampled full view to inspect fine detail — a region within the size ' +
        'limits is delivered at full fidelity.',
    ),
  full_resolution: z
    .boolean()
    .optional()
    .describe(
      'Images only: skip the default downscaling and view at native resolution. Fails with an ' +
        'explicit error when the payload would exceed the per-image byte limit; use region for ' +
        'files that large.',
    ),
});

export type ReadMediaFileInput = z.infer<typeof ReadMediaFileInputSchema>;
