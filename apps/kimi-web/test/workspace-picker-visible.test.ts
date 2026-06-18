import { describe, expect, it } from 'vitest';
import { getVisibleWorkspaces, MAX_VISIBLE_WORKSPACES } from '../src/lib/workspacePicker';

describe('getVisibleWorkspaces', () => {
  const ws = Array.from({ length: 8 }, (_, i) => ({
    id: `ws-${i}`,
    name: `Workspace ${i}`,
  }));

  it('returns all workspaces when count is at or below max', () => {
    expect(getVisibleWorkspaces(ws.slice(0, 5), null, false)).toHaveLength(5);
    expect(getVisibleWorkspaces(ws.slice(0, 3), null, false)).toHaveLength(3);
  });

  it('caps at MAX_VISIBLE_WORKSPACES when not expanded', () => {
    const visible = getVisibleWorkspaces(ws, null, false);
    expect(visible).toHaveLength(MAX_VISIBLE_WORKSPACES);
    expect(visible.map((w) => w.id)).toEqual(['ws-0', 'ws-1', 'ws-2', 'ws-3', 'ws-4']);
  });

  it('returns all workspaces when expanded', () => {
    expect(getVisibleWorkspaces(ws, null, true)).toHaveLength(8);
  });

  it('keeps the active workspace visible even if it is beyond the cap', () => {
    const visible = getVisibleWorkspaces(ws, 'ws-7', false);
    expect(visible).toHaveLength(MAX_VISIBLE_WORKSPACES);
    expect(visible[visible.length - 1]!.id).toBe('ws-7');
  });
});
