import { createCollection, useCleanup } from '#/composition-api/index';
import { currentUnit, lineage, type UnitNode } from '#/composition-api/runtime';

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
