import {
  createCollection,
  lineage,
  pushCleanup,
  useNode,
  type UnitNode,
  type Unsubscribe,
} from '@moonshot-ai/agent-core/kernel/index';

import type { McpServerConfig } from '../core/config-schema';

export interface McpServerSource {
  readonly id: string;
  load(): Promise<Record<string, McpServerConfig>>;
  onDidChange?: (listener: () => void) => Unsubscribe;
}

export const McpServerSources = createCollection<McpServerSource>('mcp.server-sources');

export function useMcpServerSource(source: McpServerSource): void {
  const node = useNode();
  pushCleanup(
    node,
    ([...lineage(node)].at(-1) as UnitNode).contribute(McpServerSources, source, 0),
  );
}
