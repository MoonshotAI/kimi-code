import { describe, expect, it } from 'vitest';

import { McpService } from '#/mcp/mcpService';

describe('McpService', () => {
  it('connect / disconnect / list + status events', async () => {
    const svc = new McpService(
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );
    const statuses: string[] = [];
    svc.onDidChangeServerStatus((e) => statuses.push(`${e.serverId}:${e.status}`));
    await svc.connect('s1');
    await svc.connect('s2');
    expect([...svc.list()].sort()).toEqual(['s1', 's2']);
    await svc.disconnect('s1');
    expect(svc.list()).toEqual(['s2']);
    expect(statuses).toEqual(['s1:connected', 's2:connected', 's1:disconnected']);
    svc.dispose();
  });
});
