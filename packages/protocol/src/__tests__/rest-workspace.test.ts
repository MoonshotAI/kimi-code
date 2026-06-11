import { describe, expect, it } from 'vitest';

import {
  createWorkspaceRequestSchema,
  deleteWorkspaceResponseSchema,
  listWorkspacesResponseSchema,
  updateWorkspaceRequestSchema,
  workspaceIdParamSchema,
} from '../rest/workspace';
import { workspaceIdSchema, workspaceSchema, type Workspace } from '../workspace';

const sampleWorkspace: Workspace = {
  id: 'wd_kimi-code_0123456789ab',
  root: '/Users/foo/code/kimi-code',
  name: 'kimi-code',
  is_git_repo: true,
  branch: 'main',
  created_at: '2026-06-08T09:00:00.000Z',
  last_opened_at: '2026-06-08T09:30:00.000Z',
  session_count: 3,
};

describe('workspaceIdSchema', () => {
  it('accepts a wd_<slug>_<hash12> string', () => {
    expect(workspaceIdSchema.parse('wd_kimi_0123456789ab')).toBe('wd_kimi_0123456789ab');
  });

  it('accepts dots, dashes, underscores in slug', () => {
    expect(workspaceIdSchema.parse('wd_kimi-code.v2_0123456789ab')).toBe(
      'wd_kimi-code.v2_0123456789ab',
    );
  });

  it('rejects missing wd_ prefix', () => {
    expect(workspaceIdSchema.safeParse('kimi_0123456789ab').success).toBe(false);
  });

  it('rejects non-hex tail', () => {
    expect(workspaceIdSchema.safeParse('wd_kimi_xyzxyzxyzxyz').success).toBe(false);
  });

  it('rejects truncated hash', () => {
    expect(workspaceIdSchema.safeParse('wd_kimi_0123456789').success).toBe(false);
  });
});

describe('workspaceSchema', () => {
  it('round-trips a fully populated Workspace', () => {
    expect(workspaceSchema.parse(sampleWorkspace)).toEqual(sampleWorkspace);
  });

  it('accepts branch=null (detached HEAD / no git)', () => {
    const detached = { ...sampleWorkspace, is_git_repo: true, branch: null };
    expect(workspaceSchema.parse(detached).branch).toBeNull();
  });

  it('rejects name longer than 100 chars', () => {
    const tooLong = { ...sampleWorkspace, name: 'x'.repeat(101) };
    expect(workspaceSchema.safeParse(tooLong).success).toBe(false);
  });
});

describe('createWorkspaceRequestSchema (POST /api/v1/workspaces)', () => {
  it('accepts a root-only body', () => {
    expect(createWorkspaceRequestSchema.parse({ root: '/Users/foo/code' })).toEqual({
      root: '/Users/foo/code',
    });
  });

  it('accepts root + name override', () => {
    const parsed = createWorkspaceRequestSchema.parse({
      root: '/Users/foo/code',
      name: 'Frontend Project',
    });
    expect(parsed.name).toBe('Frontend Project');
  });

  it('rejects empty root', () => {
    expect(createWorkspaceRequestSchema.safeParse({ root: '' }).success).toBe(false);
  });

  it('rejects missing root', () => {
    expect(createWorkspaceRequestSchema.safeParse({} as unknown).success).toBe(false);
  });

  it('rejects empty name', () => {
    expect(
      createWorkspaceRequestSchema.safeParse({ root: '/Users/foo/code', name: '' }).success,
    ).toBe(false);
  });

  it('rejects name longer than 100 chars', () => {
    expect(
      createWorkspaceRequestSchema.safeParse({
        root: '/Users/foo/code',
        name: 'x'.repeat(101),
      }).success,
    ).toBe(false);
  });
});

describe('updateWorkspaceRequestSchema (PATCH /api/v1/workspaces/{id})', () => {
  it('accepts a name patch', () => {
    expect(updateWorkspaceRequestSchema.parse({ name: 'Renamed' })).toEqual({
      name: 'Renamed',
    });
  });

  it('rejects empty body (name is required for the patch)', () => {
    expect(updateWorkspaceRequestSchema.safeParse({} as unknown).success).toBe(false);
  });
});

describe('workspaceIdParamSchema', () => {
  it('accepts a wd_-shaped workspace_id', () => {
    expect(
      workspaceIdParamSchema.parse({ workspace_id: 'wd_kimi_0123456789ab' }).workspace_id,
    ).toBe('wd_kimi_0123456789ab');
  });

  it('rejects a non-wd-shaped id', () => {
    expect(
      workspaceIdParamSchema.safeParse({ workspace_id: 'sess_abc' }).success,
    ).toBe(false);
  });
});

describe('listWorkspacesResponseSchema', () => {
  it('accepts an empty list', () => {
    expect(listWorkspacesResponseSchema.parse({ items: [] })).toEqual({ items: [] });
  });

  it('accepts a non-empty list', () => {
    expect(
      listWorkspacesResponseSchema.parse({ items: [sampleWorkspace] }).items[0]?.id,
    ).toBe(sampleWorkspace.id);
  });
});

describe('deleteWorkspaceResponseSchema', () => {
  it('accepts {deleted:true}', () => {
    expect(deleteWorkspaceResponseSchema.parse({ deleted: true })).toEqual({
      deleted: true,
    });
  });

  it('rejects {deleted:false}', () => {
    expect(deleteWorkspaceResponseSchema.safeParse({ deleted: false }).success).toBe(false);
  });
});
