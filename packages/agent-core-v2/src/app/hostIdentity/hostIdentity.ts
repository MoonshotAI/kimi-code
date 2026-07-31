/**
 * `hostIdentity` domain — runtime identity of the embedding host.
 *
 * Holds process-level overrides the host product (CLI, desktop, …) injects at
 * the composition root: `displayName` fills the `${product_name}` slot in the
 * base system-prompt template, `replyStyleGuide` replaces the
 * `${reply_style_guide}` block (the CLI default describes Markdown rendering
 * in a terminal). Composition roots set them through {@link hostIdentitySeed};
 * the registered default carries no overrides, so the template renders its CLI
 * defaults. Bound at App scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { LifecycleScope, registerScopedService, ScopeActivation, type ScopeSeed } from '#/_base/di/scope';

export interface PromptIdentityOverrides {
  readonly displayName?: string;
  readonly replyStyleGuide?: string;
}

export interface IHostIdentity {
  readonly _serviceBrand: undefined;
  readonly productName?: string;
  readonly replyStyleGuide?: string;
}

export const IHostIdentity: ServiceIdentifier<IHostIdentity> =
  createDecorator<IHostIdentity>('hostIdentity');

export class HostIdentity implements IHostIdentity {
  declare readonly _serviceBrand: undefined;

  constructor(
    readonly productName?: string,
    readonly replyStyleGuide?: string,
  ) {}
}

export function hostIdentitySeed(overrides: PromptIdentityOverrides | undefined): ScopeSeed {
  if (overrides === undefined) return [];
  if (overrides.displayName === undefined && overrides.replyStyleGuide === undefined) return [];
  return [
    [
      IHostIdentity as ServiceIdentifier<unknown>,
      new HostIdentity(overrides.displayName, overrides.replyStyleGuide),
    ],
  ];
}

registerScopedService(
  LifecycleScope.App,
  IHostIdentity,
  HostIdentity,
  ScopeActivation.OnScopeCreated,
  'hostIdentity',
);
