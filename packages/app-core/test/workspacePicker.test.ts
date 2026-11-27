import { describe, expect, it } from 'vitest';

import { filterWorkspaces } from '../src/lib/workspacePicker';

const workspaces = [
  { id: 'a', name: 'Alpha', root: '/work/alpha', shortPath: '~/work/alpha' },
  { id: 'b', name: 'Beta', root: '/work/beta', shortPath: '~/work/beta' },
  { id: 'c', name: 'Gamma', root: '/srv/shared', shortPath: '~/srv/shared' },
  { id: 'd', name: 'Delta', root: '/tmp/delta', shortPath: '~/tmp/delta' },
  { id: 'e', name: 'Echo', root: '/tmp/echo', shortPath: '~/tmp/echo' },
  { id: 'f', name: 'Foxtrot', root: '/tmp/f', shortPath: '~/tmp/f', hostId: 'host-1' },
];

describe('filterWorkspaces', () => {
  it('returns every workspace for an empty query', () => {
    expect(filterWorkspaces(workspaces, '')).toEqual(workspaces);
  });

  it('trims the query and matches names case-insensitively', () => {
    expect(filterWorkspaces(workspaces, '  ALPHA  ').map((workspace) => workspace.id)).toEqual(['a']);
  });

  it('matches full and display paths', () => {
    expect(filterWorkspaces(workspaces, 'shared').map((workspace) => workspace.id)).toEqual(['c']);
    expect(filterWorkspaces(workspaces, '~/tmp').map((workspace) => workspace.id)).toEqual(['d', 'e', 'f']);
  });

  it('matches remote host display names and addresses when provided', () => {
    const hostText = (hostId: string) => (hostId === 'host-1' ? ['GPU Box', 'ubuntu@10.0.0.8'] : []);
    expect(filterWorkspaces(workspaces, 'gpu box', hostText).map((workspace) => workspace.id)).toEqual(['f']);
    expect(filterWorkspaces(workspaces, '10.0.0.8', hostText).map((workspace) => workspace.id)).toEqual(['f']);
  });

  it('returns no workspaces when nothing matches', () => {
    expect(filterWorkspaces(workspaces, 'missing')).toEqual([]);
  });

  it('matches a Windows root whichever separators the query uses', () => {
    const windows = [
      { id: 'w', name: 'App', root: 'C:/Users/me/app', shortPath: '~\\app' },
      { id: 'n', name: 'Notes', root: 'C:\\Users\\me\\notes', shortPath: '~\\notes' },
    ];
    expect(filterWorkspaces(windows, 'C:\\Users\\me').map((workspace) => workspace.id)).toEqual(['w', 'n']);
    expect(filterWorkspaces(windows, 'c:/users/me').map((workspace) => workspace.id)).toEqual(['w', 'n']);
    expect(filterWorkspaces(windows, '~/notes').map((workspace) => workspace.id)).toEqual(['n']);
  });
});
