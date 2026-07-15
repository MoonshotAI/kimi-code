import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { discoverAgentFiles } from '#/app/agentFileCatalog/agentFileDiscovery';
import type { AgentFileRoot } from '#/app/agentFileCatalog/types';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';

const hostFs = new HostFileSystem();

function agentMd(name: string): string {
  return `---\nname: ${name}\ndescription: ${name} agent\n---\n\n${name} prompt\n`;
}

describe('discoverAgentFiles', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-discovery-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function fileRoot(path: string, source: AgentFileRoot['source'] = 'project'): AgentFileRoot {
    return { path, source };
  }

  it('discovers top-level and nested .md files recursively', async () => {
    await writeFile(join(root, 'solo.md'), agentMd('solo'));
    await mkdir(join(root, 'team'), { recursive: true });
    await writeFile(join(root, 'team/reviewer.md'), agentMd('reviewer'));

    const result = await discoverAgentFiles(hostFs, [fileRoot(root)]);

    expect(result.agents.map((a) => a.name)).toEqual(['reviewer', 'solo']);
    expect(result.skipped).toEqual([]);
    expect(result.scannedRoots).toEqual([root]);
  });

  it('skips dot-prefixed entries and node_modules', async () => {
    await mkdir(join(root, '.hidden'), { recursive: true });
    await writeFile(join(root, '.hidden/ghost.md'), agentMd('ghost'));
    await mkdir(join(root, 'node_modules/pkg'), { recursive: true });
    await writeFile(join(root, 'node_modules/pkg/dep.md'), agentMd('dep'));
    await writeFile(join(root, '.dotfile.md'), agentMd('dotfile'));
    await writeFile(join(root, 'solo.md'), agentMd('solo'));

    const result = await discoverAgentFiles(hostFs, [fileRoot(root)]);

    expect(result.agents.map((a) => a.name)).toEqual(['solo']);
  });

  it('skips invalid files with reasons and keeps valid ones', async () => {
    await writeFile(join(root, 'good.md'), agentMd('good'));
    await writeFile(join(root, 'bad.md'), 'not an agent file');

    const warnings: string[] = [];
    const result = await discoverAgentFiles(hostFs, [fileRoot(root)], (message) =>
      warnings.push(message),
    );

    expect(result.agents.map((a) => a.name)).toEqual(['good']);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.path.endsWith('bad.md')).toBe(true);
    expect(result.skipped[0]?.reason).toContain('Missing frontmatter');
    expect(warnings).toHaveLength(1);
  });

  it('resolves name collisions first-wins in root order', async () => {
    const other = await mkdtemp(join(tmpdir(), 'agent-discovery-other-'));
    try {
      await writeFile(join(root, 'reviewer.md'), agentMd('reviewer'));
      await writeFile(
        join(other, 'reviewer.md'),
        '---\nname: reviewer\ndescription: other reviewer\n---\n\nother prompt\n',
      );

      const result = await discoverAgentFiles(hostFs, [
        fileRoot(root, 'user'),
        fileRoot(other, 'project'),
      ]);

      expect(result.agents).toHaveLength(1);
      expect(result.agents[0]?.description).toBe('reviewer agent');
      expect(result.agents[0]?.source).toBe('user');
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it('ignores non-markdown files', async () => {
    await writeFile(join(root, 'notes.txt'), agentMd('notes'));

    const result = await discoverAgentFiles(hostFs, [fileRoot(root)]);

    expect(result.agents).toEqual([]);
  });
});
