import { McpRef, type McpFacade, type McpServerEntry } from '@moonshot-ai/harness-core';
import type { KimiHarness } from '@moonshot-ai/kimi-code-sdk';

import type { AppState } from '../types';
import { buildMcpServersSummary } from '../components/messages/mcp-status-panel';

export interface McpStatusHost {
  readonly harness: KimiHarness;
  setAppState(patch: Partial<AppState>): void;
  showNotice(title: string, detail?: string): void;
}

export class McpStatusController {
  private off: Array<() => void> | undefined;

  constructor(private readonly host: McpStatusHost) {}

  start(): void {
    if (this.off !== undefined) return;
    const { harness } = this.host;
    const mcp = harness.app.resolve(McpRef);
    if (mcp === undefined) return;
    const off: Array<() => void> = [];
    off.push(
      harness.app.on('mcp.server.state', () => {
        this.refreshSummary(mcp);
      }),
    );
    off.push(
      harness.app.on('mcp.oauth.authorization_url', (event) => {
        const server = event['server'];
        const url = event['authorizationUrl'];
        if (typeof url !== 'string' || url.length === 0) return;
        this.host.showNotice(
          `MCP server ${typeof server === 'string' ? server : ''} needs authorization`,
          `Open this URL to authorize:\n${url}`,
        );
      }),
    );
    this.off = off;
    this.refreshSummary(mcp);
  }

  stop(): void {
    for (const off of this.off ?? []) off();
    this.off = undefined;
  }

  private refreshSummary(mcp: McpFacade): void {
    const servers: readonly McpServerEntry[] = mcp.list();
    this.host.setAppState({
      mcpServersSummary: servers.length === 0 ? null : buildMcpServersSummary(servers),
    });
  }
}
