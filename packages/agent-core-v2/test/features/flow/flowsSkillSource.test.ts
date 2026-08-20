import { beforeEach, describe, expect, it } from 'vitest';

import { Event } from '#/_base/event';
import type { IBootstrapService } from '#/app/bootstrap/bootstrap';
import type { IConfigService } from '#/app/config/config';
import type { IFlagService } from '#/app/flag/flag';
import { FLOW_FLAG_ID } from '#/features/flow/flow';
import { FlowsSkillSource, isProjectedFlowSkill } from '#/features/flow/flowsSkillSource';
import type { HostDirEntry, IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { IHostFsWatchService } from '#/os/interface/hostFsWatch';
import type { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';

import { stubFlag } from '../../app/flag/stubs';

const VALID = `---
id: issue-fix
when: GitHub issue bugs
stages:
  - id: triage
    objective: find it
    completion: found
---
`;

describe('FlowsSkillSource', () => {
  let files: Map<string, string>;
  let userFiles: Map<string, string>;
  let flowFlagOn: boolean;
  let source: FlowsSkillSource;

  beforeEach(() => {
    files = new Map();
    userFiles = new Map();
    flowFlagOn = true;
    const dirOf = (path: string): Map<string, string> | undefined => {
      if (path === '/ws/.kimi-code/flows') return files;
      if (path === '/home/.kimi-code/flows') return userFiles;
      return undefined;
    };
    const fs = {
      readdir: async (path: string): Promise<HostDirEntry[]> => {
        const dir = dirOf(path);
        if (dir === undefined) throw new Error('not found');
        return [...dir.keys()].map((name) => ({ name, isFile: true, isDirectory: false }));
      },
      readText: async (path: string): Promise<string> => {
        const name = path.split('/').at(-1)!;
        const text = dirOf(path.split('/').slice(0, -1).join('/'))?.get(name);
        if (text === undefined) throw new Error('not found');
        return text;
      },
    } as unknown as IHostFileSystem;
    const fsWatch = {
      watch: () => ({ ready: Promise.resolve(), onDidChange: Event.None, dispose: () => {} }),
    } as unknown as IHostFsWatchService;
    const workspace = { cwd: '/ws' } as unknown as IWorkspaceContext;
    const bootstrap = { homeDir: '/home/.kimi-code' } as unknown as IBootstrapService;
    const flags = stubFlag((id) => flowFlagOn && id === FLOW_FLAG_ID) as IFlagService;
    const config = {
      get: () => undefined,
      onDidChangeConfiguration: () => ({ dispose: () => {} }),
    } as unknown as IConfigService;
    source = new FlowsSkillSource(fs, fsWatch, workspace, bootstrap, flags, config);
  });

  it('projects a flow definition into a user-activatable flow skill', async () => {
    files.set('issue-fix.md', VALID);
    const contribution = await source.load();
    expect(contribution.skills).toHaveLength(1);
    const skill = contribution.skills[0]!;
    expect(skill.name).toBe('flow:issue-fix');
    expect(skill.source).toBe('project');
    expect(skill.metadata.type).toBe('flow');
    expect(skill.metadata.disableModelInvocation).toBe(true);
    expect(skill.description).toContain('GitHub issue bugs');
    expect(skill.content).toContain('The engine starts a run');
    expect(skill.content).toContain('do NOT call FlowStart');
    expect(skill.content).toContain('`triage` (gate: ai)');
    expect(skill.content).toContain('$ARGUMENTS');
    expect(skill.content).toContain('## Contract');
  });

  it('contributes nothing while the flow flag is off', async () => {
    files.set('issue-fix.md', VALID);
    flowFlagOn = false;
    expect((await source.load()).skills).toHaveLength(0);
  });

  it('contributes nothing when the flows directory does not exist', async () => {
    const contribution = await source.load();
    expect(contribution.skills).toHaveLength(0);
  });

  it('skips a definition whose id does not match its file name, and unparseable files', async () => {
    files.set('renamed.md', VALID);
    files.set('broken.md', 'not a flow definition');
    const contribution = await source.load();
    expect(contribution.skills).toHaveLength(0);
    expect(contribution.skipped?.map((entry) => entry.path).toSorted()).toEqual([
      '/ws/.kimi-code/flows/broken.md',
      '/ws/.kimi-code/flows/renamed.md',
    ]);
  });

  it('projects a user-level flow definition with the user source', async () => {
    userFiles.set('issue-fix.md', VALID);
    const contribution = await source.load();
    expect(contribution.skills).toHaveLength(1);
    const skill = contribution.skills[0]!;
    expect(skill.name).toBe('flow:issue-fix');
    expect(skill.source).toBe('user');
    expect(skill.path).toBe('/home/.kimi-code/flows/issue-fix.md');
    expect(contribution.scannedRoots).toEqual([
      '/ws/.kimi-code/flows',
      '/home/.kimi-code/flows',
    ]);
  });

  it('treats only prefixed flow-typed skills as projected flows', () => {
    expect(isProjectedFlowSkill('flow:issue-fix', 'flow')).toBe(true);
    expect(isProjectedFlowSkill('issue-fix', 'flow')).toBe(false);
    expect(isProjectedFlowSkill('flow:issue-fix', 'prompt')).toBe(false);
    expect(isProjectedFlowSkill(undefined, 'flow')).toBe(false);
  });

  it('a project flow shadows a user flow with the same id', async () => {
    files.set('issue-fix.md', VALID);
    userFiles.set('issue-fix.md', VALID);
    const contribution = await source.load();
    expect(contribution.skills).toHaveLength(1);
    expect(contribution.skills[0]!.source).toBe('project');
    expect(contribution.skipped).toEqual([
      {
        path: '/home/.kimi-code/flows/issue-fix.md',
        type: 'flow',
        reason: 'shadowed by the project flow `issue-fix`',
      },
    ]);
  });
});
