import { mkdir, mkdtemp, readFile, realpath as fsRealpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'pathe';

import { afterEach, describe, expect, it } from 'vitest';

import {
  discoverWorkflows,
  resolveWorkflowRoots,
  saveWorkflow,
  SessionWorkflowRegistry,
} from '../../src/workflow';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function realpath(p: string): Promise<string> {
  return (await fsRealpath(p)).replaceAll('\\', '/');
}

interface Workspace {
  repoDir: string;
  workDir: string;
  homeDir: string;
  kimiHome: string;
}

async function makeWorkspace(): Promise<Workspace> {
  const repoDir = await makeTempDir('wf-repo-');
  const homeDir = await makeTempDir('wf-home-');
  await mkdir(path.join(repoDir, '.git'), { recursive: true });
  const workDir = path.join(repoDir, 'nested', 'dir');
  await mkdir(workDir, { recursive: true });
  return { repoDir, workDir, homeDir, kimiHome: path.join(homeDir, '.kimi-code') };
}

function workflowScript(name: string, extra = ''): string {
  return `export const meta = {
  name: '${name}',
  description: 'Workflow ${name}.',
  phases: [{ title: 'Main' }],
};
${extra}
return 'done';
`;
}

async function writeWorkflow(dir: string, fileName: string, content: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, fileName);
  await writeFile(filePath, content, 'utf8');
  return filePath;
}

describe('resolveWorkflowRoots', () => {
  it('resolves roots in precedence order: project brand > project generic > user brand > user generic > extra', async () => {
    const { repoDir, workDir, homeDir, kimiHome } = await makeWorkspace();
    await mkdir(path.join(repoDir, '.kimi-code', 'workflows'), { recursive: true });
    await mkdir(path.join(repoDir, '.agents', 'workflows'), { recursive: true });
    await mkdir(path.join(kimiHome, 'workflows'), { recursive: true });
    await mkdir(path.join(homeDir, '.agents', 'workflows'), { recursive: true });
    const extraDir = path.join(repoDir, 'team-workflows');
    await mkdir(extraDir, { recursive: true });

    const roots = await resolveWorkflowRoots({
      workDir,
      osHome: homeDir,
      extraDirs: ['team-workflows'],
      includeBuiltin: false,
    });

    expect(roots.map((root) => root.path)).toEqual([
      await realpath(path.join(repoDir, '.kimi-code', 'workflows')),
      await realpath(path.join(repoDir, '.agents', 'workflows')),
      await realpath(path.join(kimiHome, 'workflows')),
      await realpath(path.join(homeDir, '.agents', 'workflows')),
      await realpath(extraDir),
    ]);
    expect(roots.map((root) => root.source)).toEqual(['project', 'project', 'user', 'user', 'extra']);
  });

  it('tolerates missing project/user directories and appends the builtin root last', async () => {
    const { workDir, homeDir } = await makeWorkspace();
    const roots = await resolveWorkflowRoots({ workDir, osHome: homeDir });
    // No project/user/extra dirs exist; only the in-repo builtin dir remains.
    expect(roots.map((root) => root.source)).toEqual(['builtin']);
    expect(roots[0]?.path.endsWith('src/workflow/builtin')).toBe(true);

    const withoutBuiltin = await resolveWorkflowRoots({
      workDir,
      osHome: homeDir,
      includeBuiltin: false,
    });
    expect(withoutBuiltin).toEqual([]);
  });

  it('honors an explicit kimiHome over the osHome default', async () => {
    const { workDir } = await makeWorkspace();
    const kimiHome = await makeTempDir('wf-brand-');
    await mkdir(path.join(kimiHome, 'workflows'), { recursive: true });
    const roots = await resolveWorkflowRoots({ workDir, kimiHome, includeBuiltin: false });
    expect(roots).toEqual([
      { path: await realpath(path.join(kimiHome, 'workflows')), source: 'user' },
    ]);
  });
});

describe('discoverWorkflows', () => {
  it('discovers workflows with project > user precedence (first root wins by name)', async () => {
    const { repoDir, workDir, homeDir, kimiHome } = await makeWorkspace();
    const projectPath = await writeWorkflow(
      path.join(repoDir, '.kimi-code', 'workflows'),
      'alpha.js',
      workflowScript('alpha', `log('project');`),
    );
    await writeWorkflow(path.join(kimiHome, 'workflows'), 'alpha.js', workflowScript('alpha', `log('user');`));
    await writeWorkflow(path.join(kimiHome, 'workflows'), 'beta.js', workflowScript('beta'));

    const { workflows, skipped } = await discoverWorkflows({
      workDir,
      osHome: homeDir,
      includeBuiltin: false,
    });

    expect(skipped).toEqual([]);
    expect(workflows.map((w) => [w.meta.name, w.source])).toEqual([
      ['alpha', 'project'],
      ['beta', 'user'],
    ]);
    const alpha = workflows.find((w) => w.meta.name === 'alpha');
    expect(alpha?.path).toBe(await realpath(projectPath));
    expect(alpha?.script).toContain(`log('project')`);
  });

  it('prefers the brand root over the generic project root', async () => {
    const { repoDir, workDir, homeDir } = await makeWorkspace();
    await writeWorkflow(
      path.join(repoDir, '.kimi-code', 'workflows'),
      'alpha.js',
      workflowScript('alpha', `log('brand');`),
    );
    await writeWorkflow(
      path.join(repoDir, '.agents', 'workflows'),
      'alpha.js',
      workflowScript('alpha', `log('generic');`),
    );
    const { workflows } = await discoverWorkflows({ workDir, osHome: homeDir, includeBuiltin: false });
    expect(workflows).toHaveLength(1);
    expect(workflows[0]?.script).toContain(`log('brand')`);
  });

  it('skips invalid files with a reason instead of throwing', async () => {
    const { repoDir, workDir, homeDir } = await makeWorkspace();
    const dir = path.join(repoDir, '.kimi-code', 'workflows');
    await writeWorkflow(dir, 'good.js', workflowScript('good'));
    await writeWorkflow(dir, 'no-meta.js', `return 42;`);
    await writeWorkflow(dir, 'syntax.js', `export const meta = {;`);
    await writeWorkflow(dir, 'mismatch.js', workflowScript('other-name'));
    await writeWorkflow(dir, 'notes.txt', 'not a workflow');

    const { workflows, skipped } = await discoverWorkflows({
      workDir,
      osHome: homeDir,
      includeBuiltin: false,
    });

    expect(workflows.map((w) => w.meta.name)).toEqual(['good']);
    expect(skipped).toHaveLength(3);
    expect(skipped.find((s) => s.path.endsWith('no-meta.js'))?.reason).toContain('export const meta');
    expect(skipped.find((s) => s.path.endsWith('syntax.js'))?.reason).toContain('syntax');
    expect(skipped.find((s) => s.path.endsWith('mismatch.js'))?.reason).toContain('does not match filename');
  });

  it('skips files larger than maxScriptBytes', async () => {
    const { repoDir, workDir, homeDir } = await makeWorkspace();
    const dir = path.join(repoDir, '.kimi-code', 'workflows');
    await writeWorkflow(dir, 'big.js', workflowScript('big', `// ${'x'.repeat(4096)}`));

    const { workflows, skipped } = await discoverWorkflows({
      workDir,
      osHome: homeDir,
      includeBuiltin: false,
      maxScriptBytes: 2048,
    });

    expect(workflows).toEqual([]);
    expect(skipped[0]?.reason).toContain('too large');
  });
});

describe('saveWorkflow', () => {
  it('saves to the project brand root and to the user brand root', async () => {
    const { repoDir, workDir, homeDir } = await makeWorkspace();

    const project = await saveWorkflow({
      script: workflowScript('proj-flow'),
      scope: 'project',
      workDir,
      osHome: homeDir,
    });
    expect(project.path).toBe(path.join(repoDir, '.kimi-code', 'workflows', 'proj-flow.js'));
    expect(await readFile(project.path, 'utf8')).toContain(`name: 'proj-flow'`);

    const user = await saveWorkflow({
      script: workflowScript('user-flow'),
      scope: 'user',
      workDir,
      osHome: homeDir,
    });
    expect(user.path).toBe(path.join(homeDir, '.kimi-code', 'workflows', 'user-flow.js'));
    expect(await readFile(user.path, 'utf8')).toContain(`name: 'user-flow'`);
  });

  it('refuses to overwrite an existing file unless overwrite is set', async () => {
    const { workDir, homeDir } = await makeWorkspace();
    const options = {
      script: workflowScript('dupe'),
      scope: 'project' as const,
      workDir,
      osHome: homeDir,
    };
    await saveWorkflow(options);
    await expect(saveWorkflow(options)).rejects.toThrow(/already exists/);
    await expect(saveWorkflow({ ...options, overwrite: true })).resolves.toBeDefined();
  });

  it('rejects scripts whose meta name is invalid', async () => {
    const { workDir, homeDir } = await makeWorkspace();
    const script = `export const meta = { name: 'Bad Name', description: 'x', phases: [{ title: 'A' }] };\nreturn 1;`;
    await expect(
      saveWorkflow({ script, scope: 'project', workDir, osHome: homeDir }),
    ).rejects.toThrow();
  });
});

describe('SessionWorkflowRegistry', () => {
  it('loads once, lists/gets by name, exposes skipped, and reload picks up new files', async () => {
    const { repoDir, workDir, homeDir } = await makeWorkspace();
    const dir = path.join(repoDir, '.kimi-code', 'workflows');
    await writeWorkflow(dir, 'alpha.js', workflowScript('alpha'));
    await writeWorkflow(dir, 'broken.js', 'not a workflow');

    const registry = new SessionWorkflowRegistry({
      workDir,
      osHome: homeDir,
      includeBuiltin: false,
    });

    await registry.load();
    expect(registry.list().map((wf) => wf.meta.name)).toEqual(['alpha']);
    expect(registry.get('alpha')?.source).toBe('project');
    expect(registry.get('missing')).toBeUndefined();
    expect(registry.skipped).toHaveLength(1);
    expect(registry.skipped[0]?.path.endsWith('broken.js')).toBe(true);

    // load() after the first load is a no-op; reload() rescans.
    await writeWorkflow(dir, 'beta.js', workflowScript('beta'));
    await registry.load();
    expect(registry.list().map((wf) => wf.meta.name)).toEqual(['alpha']);
    await registry.reload();
    expect(registry.list().map((wf) => wf.meta.name).toSorted()).toEqual(['alpha', 'beta']);
  });
});
