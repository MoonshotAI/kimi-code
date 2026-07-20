/**
 * `media` domain (L4) — bridge from the `image` config section into the
 * compression support module's resolver seam.
 *
 * `image-compress` (`#/agent/media/image-compress`) is deliberately
 * config-agnostic so foundational code never imports the config domain: it
 * exposes `setConfiguredMaxImageEdgePx` / `setConfiguredReadImageByteBudget`
 * and resolves its defaults as `configured ?? built-in`. This bridge is the
 * single owner that populates that seam from the env-resolved `[image]`
 * section — env (`KIMI_IMAGE_MAX_EDGE_PX` / `KIMI_IMAGE_READ_BYTE_BUDGET`) is
 * already folded into `config.get('image')` by the config layer, so nothing
 * here reads `process.env`.
 *
 * Constructed eagerly at Agent scope (ignited alongside the media-tools
 * registrar, before the first turn) and kept in sync via
 * `onDidSectionChange`, so every compression call site — including the apps'
 * prompt ingestion that relies on the implicit default — honors config/env.
 * Pushes are idempotent (one global config), so multiple agents are harmless.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IConfigService } from '#/app/config/config';
import {
  setConfiguredMaxImageEdgePx,
  setConfiguredReadImageByteBudget,
} from '#/agent/media/image-compress';

import { IMAGE_SECTION, type ImageConfig } from './configSection';

export interface IImageConfigBridge {
  readonly _serviceBrand: undefined;
}

export const IImageConfigBridge: ServiceIdentifier<IImageConfigBridge> =
  createDecorator<IImageConfigBridge>('imageConfigBridge');

export class ImageConfigBridge extends Disposable implements IImageConfigBridge {
  declare readonly _serviceBrand: undefined;

  constructor(@IConfigService private readonly config: IConfigService) {
    super();
    this.push(this.config.get<ImageConfig>(IMAGE_SECTION));
    this._register(
      this.config.onDidSectionChange((e) => {
        if (e.domain === IMAGE_SECTION) {
          this.push(e.value as ImageConfig);
        }
      }),
    );
  }

  private push(image: ImageConfig | undefined): void {
    setConfiguredMaxImageEdgePx(image?.maxEdgePx);
    setConfiguredReadImageByteBudget(image?.readByteBudget);
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IImageConfigBridge,
  ImageConfigBridge,
  InstantiationType.Eager,
  'media',
);
