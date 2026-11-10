import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
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
  ScopeActivation.OnScopeCreated,
  'media',
);
