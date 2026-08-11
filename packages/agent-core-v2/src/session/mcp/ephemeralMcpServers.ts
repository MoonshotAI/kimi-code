/**
 * `mcp` domain — seeded ephemeral per-session MCP server configs.
 *
 * Defines `ISessionEphemeralMcpServers`, the pure-data injection contract
 * carrying the session's ephemeral (caller-injected, never persisted) MCP
 * server configs, copied verbatim from the session's creation options
 * (`CreateSessionOptions.mcpServers` / `ResumeSessionOptions.mcpServers`).
 * Always seeded into the Session scope by the session lifecycle (an empty
 * record for ordinary sessions), so consumers can resolve it
 * unconditionally. The contract carries no IO of its own — connecting the
 * servers and projecting the resulting session handle is the
 * Workspace-side MCP domain's concern, activated through the session
 * lifecycle's `onWillCreateSession` event. Session-scoped.
 */

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
