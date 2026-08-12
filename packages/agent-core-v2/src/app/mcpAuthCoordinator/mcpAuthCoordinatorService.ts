/**
 * `mcpAuthCoordinator` domain — `IMcpAuthCoordinator` implementation.
 *
 * Provides the App-scoped credential event broadcaster. Browser authorization
 * flows remain owned by their callers.
 */

import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { McpOAuthCoordinator } from '#/mcpCore/oauth/coordinator';

import { IMcpAuthCoordinator } from './mcpAuthCoordinator';

export class McpAuthCoordinatorService
  extends McpOAuthCoordinator
  implements IMcpAuthCoordinator
{
  declare readonly _serviceBrand: undefined;
}

registerScopedService(
  LifecycleScope.App,
  IMcpAuthCoordinator,
  McpAuthCoordinatorService,
  ScopeActivation.OnScopeCreated,
  'mcpAuthCoordinator',
);
