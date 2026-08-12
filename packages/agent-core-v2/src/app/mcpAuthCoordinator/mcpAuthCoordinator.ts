/**
 * `mcpAuthCoordinator` domain — App-scoped MCP OAuth coordination contract.
 *
 * Broadcasts credential updates from global management calls to workspace MCP
 * runtimes. It does not own or share browser authorization flows.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { McpOAuthCredentialsCoordinator } from '#/mcpCore/oauth/coordinator';

export interface IMcpAuthCoordinator extends McpOAuthCredentialsCoordinator {
  readonly _serviceBrand: undefined;
}

export const IMcpAuthCoordinator: ServiceIdentifier<IMcpAuthCoordinator> =
  createDecorator<IMcpAuthCoordinator>('mcpAuthCoordinator');
