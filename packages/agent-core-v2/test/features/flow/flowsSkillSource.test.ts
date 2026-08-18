import { beforeEach, describe, expect, it } from 'vitest';

import { Event } from '#/_base/event';
import type { IFlagService } from '#/app/flag/flag';
import { FLOW_FLAG_ID } from '#/features/flow/flow';
import { FlowsSkillSource } from '#/features/flow/flowsSkillSource';
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
  let flowFlagOn: boolean;
  let source: FlowsSkillSource;

  beforeEach(() => {
    files = new Map();
    flowFlagOn = true;
    const fs = {
      readdir: async (path: string): Promise<HostDirEntry[]> => {
        if (path !== '/ws/.kimi-code/flows') throw new Error('not found');
        return [...files.keys()].map((name) => ({ name, isFile: true, isDirectory: false }));
      },
      readText: async (path: string): Promise<string> => {
        const name = path.split('/').at(-1)!;
        const text = files.get(name);
        if (text === undefined) throw new Error('not found');
        return text;
      },
    } as unknown as IHostFileSystem;
    const fsWatch = {
      watch: () => ({ ready: Promise.resolve(), onDidChange: Event.None, dispose: () => {} }),
    } as unknown as IHostFsWatchService;
    const workspace = { cwd: '/ws' } as unknown as IWorkspaceContext;
    const flags = stubFlag((id) => flowFlagOn && id === FLOW_FLAG_ID) as IFlagService;
    source = new FlowsSkillSource(fs, fsWatch, workspace, flags);
  });

  it('projects a flow definition into a user-activatable flow skill', async () => {
    files.set('issue-fix.md', VALID);
    const contribution = await source.load();
    expect(contribution.skills).toHaveLength(1);
    const skill = contribution.skills[0]!;
    expect(skill.name).toBe('issue-fix');
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
});
