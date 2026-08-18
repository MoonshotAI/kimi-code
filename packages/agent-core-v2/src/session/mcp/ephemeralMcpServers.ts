import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ScopeSeed } from '#/_base/di/scope';
import type { McpServerConfig } from '#/mcpCore/config-schema';

export const ISessionEphemeralMcpServers: ServiceIdentifier<
  Readonly<Record<string, McpServerConfig>>
> = createDecorator<Readonly<Record<string, McpServerConfig>>>('sessionEphemeralMcpServers');

export function sessionEphemeralMcpServersSeed(
  servers: Readonly<Record<string, McpServerConfig>>,
): ScopeSeed {
  return [[ISessionEphemeralMcpServers as ServiceIdentifier<unknown>, servers]];
}
