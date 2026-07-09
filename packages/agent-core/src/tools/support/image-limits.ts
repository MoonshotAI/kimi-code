/**
 * Owner-scoped resolution of the `[image]` config limits.
 *
 * One instance per owner (KimiCore in production; a fresh default for a
 * standalone Agent), mirroring the FlagResolver lifecycle: the owner pushes
 * its config on load and reload via {@link ImageLimits.setConfig}, and every
 * consumer resolves through the instance it was handed. Nothing is stored in
 * module state, so two cores in one process (the SDK's multi-client pattern)
 * each compress with their own `[image]` settings and a reload of one never
 * restamps the other.
 *
 * Resolution precedence per value: env var > owning config > built-in
 * default. Env stays process-level on purpose — it is the operator's
 * override for everything in the process, exactly like the experimental-flag
 * env switches.
 */

import type { ImageConfig } from '#/config/schema';

import {
  MAX_IMAGE_EDGE_PX,
  maxImageEdgeFromEnv,
  READ_IMAGE_BYTE_BUDGET,
  readImageByteBudgetFromEnv,
} from './image-compress';

export class ImageLimits {
  constructor(
    private readonly env: Readonly<Record<string, string | undefined>> = process.env,
    private config: ImageConfig | undefined = undefined,
  ) {}

  /** Push (or clear, with `undefined`) the owning config. Called by the
   * config owner on load and reload, so limits hot-reload per owner. */
  setConfig(config: ImageConfig | undefined): void {
    this.config = config;
  }

  /** Longest-edge ceiling (px) for compressing images for the model. */
  maxEdgePx(): number {
    return maxImageEdgeFromEnv(this.env) ?? this.config?.maxEdgePx ?? MAX_IMAGE_EDGE_PX;
  }

  /** Raw-byte budget for model-initiated image reads (ReadMediaFile default path). */
  readByteBudget(): number {
    return (
      readImageByteBudgetFromEnv(this.env) ?? this.config?.readByteBudget ?? READ_IMAGE_BYTE_BUDGET
    );
  }
}
