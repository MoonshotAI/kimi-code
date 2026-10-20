import { createCollection, useCleanup } from '@moonshot-ai/agent-core/kernel/index';
import { currentUnit, lineage, type UnitNode } from '@moonshot-ai/agent-core/kernel/runtime';

import type { McpServerConfig } from '../core/config-schema';

export interface McpServerSource {
  readonly id: string;
  load(): Promise<Record<string, McpServerConfig>>;
  onDidChange?: (listener: () => void) => () => void;
}

export const McpServerSources = createCollection<McpServerSource>('mcp.server-sources');

export function useMcpServerSource(source: McpServerSource): void {
  useCleanup(
    ([...lineage(currentUnit())].at(-1) as UnitNode).register(McpServerSources, source, 0),
  );
}
