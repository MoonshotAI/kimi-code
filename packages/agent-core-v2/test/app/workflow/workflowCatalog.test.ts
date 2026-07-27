import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { isError2 } from '#/_base/errors/errors';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { DEFAULT_WORKFLOWS_CONFIG, WORKFLOWS_SECTION } from '#/app/workflow/configSection';
import { WorkflowErrors } from '#/app/workflow/errors';
import { IWorkflowCatalogService } from '#/app/workflow/workflowCatalog';
import { WorkflowCatalogService } from '#/app/workflow/workflowCatalogService';

import { stubLog } from '../../_base/log/stubs';
import { ILogService } from '#/_base/log/log';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

interface Workspace {
  repoDir: string;
  workDir: string;
  homeDir: string;
  kimiHome: string;
}

async function makeWorkspace(): Promise<Workspace> {
  const repoDir = await mkdtemp(path.join(tmpdir(), 'wf-cat-repo-'));
  const homeDir = await mkdtemp(path.join(tmpdir(), 'wf-cat-home-'));
  tempDirs.push(repoDir, homeDir);
  await mkdir(path.join(repoDir, '.git'), { recursive: true });
  const workDir = path.join(repoDir, 'nested');
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

describe('WorkflowCatalogService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let workspace: Workspace;

  beforeEach(async () => {
    workspace = await makeWorkspace();
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(ILogService, stubLog());
        reg.definePartialInstance(IBootstrapService, {
          cwd: workspace.workDir,
          homeDir: workspace.kimiHome,
          osHomeDir: workspace.homeDir,
        });
        reg.definePartialInstance(IConfigService, {
          get: <T = unknown>(domain: string): T =>
            (domain === WORKFLOWS_SECTION ? DEFAULT_WORKFLOWS_CONFIG : undefined) as T,
        });
        reg.define(IWorkflowCatalogService, WorkflowCatalogService);
      },
    });
  });
  afterEach(() => disposables.dispose());

  it('discovers the builtin workflows on first load', async () => {
    const catalog = ix.get(IWorkflowCatalogService);
    await catalog.ready;
    const names = catalog.list().map((workflow) => workflow.meta.name);
    expect(names).toContain('deep-research');
    expect(catalog.get('deep-research')?.source).toBe('builtin');
    expect(catalog.get('missing')).toBeUndefined();
    expect(catalog.skipped()).toEqual([]);
  });

  it('merges project and user roots with first-wins precedence and reports skipped files', async () => {
    const projectDir = path.join(workspace.repoDir, '.kimi-code', 'workflows');
    await mkdir(projectDir, { recursive: true });
    await writeFile(path.join(projectDir, 'alpha.js'), workflowScript('alpha', `log('project');`), 'utf8');
    await writeFile(path.join(projectDir, 'broken.js'), 'not a workflow', 'utf8');
    const userDir = path.join(workspace.kimiHome, 'workflows');
    await mkdir(userDir, { recursive: true });
    await writeFile(path.join(userDir, 'alpha.js'), workflowScript('alpha', `log('user');`), 'utf8');

    const catalog = ix.get(IWorkflowCatalogService);
    await catalog.ready;

    const alpha = catalog.get('alpha');
    expect(alpha?.source).toBe('project');
    expect(alpha?.script).toContain(`log('project')`);
    expect(catalog.skipped()).toHaveLength(1);
    expect(catalog.skipped()[0]?.path.endsWith('broken.js')).toBe(true);
  });

  it('reload picks up newly written files', async () => {
    const catalog = ix.get(IWorkflowCatalogService);
    await catalog.ready;
    expect(catalog.get('beta')).toBeUndefined();

    const projectDir = path.join(workspace.repoDir, '.kimi-code', 'workflows');
    await mkdir(projectDir, { recursive: true });
    await writeFile(path.join(projectDir, 'beta.js'), workflowScript('beta'), 'utf8');
    await catalog.reload();
    expect(catalog.get('beta')?.source).toBe('project');
  });

  it('saves to the project and user roots and refreshes the listing', async () => {
    const catalog = ix.get(IWorkflowCatalogService);
    await catalog.ready;

    const project = await catalog.save({ script: workflowScript('proj-flow'), scope: 'project' });
    expect(project.path).toBe(
      path.join(workspace.repoDir, '.kimi-code', 'workflows', 'proj-flow.js'),
    );
    expect(await readFile(project.path, 'utf8')).toContain(`name: 'proj-flow'`);
    expect(catalog.get('proj-flow')?.source).toBe('project');

    const user = await catalog.save({ script: workflowScript('user-flow'), scope: 'user' });
    expect(user.path).toBe(path.join(workspace.kimiHome, 'workflows', 'user-flow.js'));
    expect(catalog.get('user-flow')?.source).toBe('user');
  });

  it('throws workflow.already_exists on a conflicting save without overwrite', async () => {
    const catalog = ix.get(IWorkflowCatalogService);
    await catalog.ready;
    await catalog.save({ script: workflowScript('dupe'), scope: 'project' });

    const conflict = await catalog
      .save({ script: workflowScript('dupe'), scope: 'project' })
      .catch((error: unknown) => error);
    expect(isError2(conflict)).toBe(true);
    if (isError2(conflict)) {
      expect(conflict.code).toBe(WorkflowErrors.codes.WORKFLOW_ALREADY_EXISTS);
    }

    await expect(
      catalog.save({ script: workflowScript('dupe'), scope: 'project', overwrite: true }),
    ).resolves.toBeDefined();
  });

  it('throws workflow.invalid for an invalid script', async () => {
    const catalog = ix.get(IWorkflowCatalogService);
    await catalog.ready;
    const failure = await catalog
      .save({ script: 'return 42;', scope: 'project' })
      .catch((error: unknown) => error);
    expect(isError2(failure)).toBe(true);
    if (isError2(failure)) {
      expect(failure.code).toBe(WorkflowErrors.codes.WORKFLOW_INVALID);
    }
  });
});
