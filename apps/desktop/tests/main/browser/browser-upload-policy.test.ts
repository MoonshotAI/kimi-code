import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileUploadNeedsApproval } from '../../../src/main/browser/browser-upload-policy';

let root: string;
let workspace: string;
let downloads: string;
let outside: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'browser-upload-')));
  workspace = join(root, 'workspace');
  downloads = join(root, 'downloads');
  outside = join(root, 'outside');
  for (const directory of [workspace, downloads, outside, join(workspace, 'nested')]) mkdirSync(directory, { recursive: true });
  writeFileSync(join(workspace, 'nested', 'report.txt'), 'report');
  writeFileSync(join(downloads, 'invoice.pdf'), 'invoice');
  writeFileSync(join(outside, 'secret.txt'), 'secret');
  writeFileSync(join(root, 'workspace-sibling.txt'), 'sibling');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('fileUploadNeedsApproval', () => {
  it('uploads workspace and Downloads files without a prompt', async () => {
    const context = { workspaceRoot: workspace, downloadsDirectory: downloads, permissionMode: 'manual' as const };
    await expect(fileUploadNeedsApproval(join(workspace, 'nested', 'report.txt'), context)).resolves.toEqual({ ok: true, path: join(workspace, 'nested', 'report.txt'), needsApproval: false });
    await expect(fileUploadNeedsApproval(join(downloads, 'invoice.pdf'), context)).resolves.toEqual({ ok: true, path: join(downloads, 'invoice.pdf'), needsApproval: false });
  });

  it.each(['manual', 'yolo', undefined] as const)('asks for other files in %s mode', async permissionMode => {
    const decision = await fileUploadNeedsApproval(join(outside, 'secret.txt'), { workspaceRoot: workspace, downloadsDirectory: downloads, permissionMode });
    expect(decision).toEqual({ ok: true, path: join(outside, 'secret.txt'), needsApproval: true });
  });

  it('does not ask when the session never asks for approval', async () => {
    const decision = await fileUploadNeedsApproval(join(outside, 'secret.txt'), { workspaceRoot: workspace, downloadsDirectory: downloads, permissionMode: 'auto' });
    expect(decision).toMatchObject({ ok: true, needsApproval: false });
  });

  it('follows symlinks before deciding and catches escapes from the workspace', async () => {
    symlinkSync(join(outside, 'secret.txt'), join(workspace, 'link.txt'));
    const escape = await fileUploadNeedsApproval(join(workspace, 'link.txt'), { workspaceRoot: workspace, downloadsDirectory: downloads, permissionMode: 'manual' });
    expect(escape).toEqual({ ok: true, path: join(outside, 'secret.txt'), needsApproval: true });
    symlinkSync(workspace, join(outside, 'workspace-link'));
    const inside = await fileUploadNeedsApproval(join(outside, 'workspace-link', 'nested', 'report.txt'), { workspaceRoot: workspace, downloadsDirectory: downloads, permissionMode: 'manual' });
    expect(inside).toEqual({ ok: true, path: join(workspace, 'nested', 'report.txt'), needsApproval: false });
  });

  it('treats a sibling with a matching name prefix as outside the workspace', async () => {
    const decision = await fileUploadNeedsApproval(join(root, 'workspace-sibling.txt'), { workspaceRoot: workspace, downloadsDirectory: downloads, permissionMode: 'manual' });
    expect(decision).toMatchObject({ ok: true, needsApproval: true });
  });

  it('asks for every file when the session has no workspace', async () => {
    const decision = await fileUploadNeedsApproval(join(workspace, 'nested', 'report.txt'), { workspaceRoot: null, downloadsDirectory: downloads, permissionMode: 'manual' });
    expect(decision).toMatchObject({ ok: true, needsApproval: true });
  });

  it('rejects relative, missing and non-file paths', async () => {
    const context = { workspaceRoot: workspace, downloadsDirectory: downloads, permissionMode: 'auto' as const };
    await expect(fileUploadNeedsApproval('report.txt', context)).resolves.toMatchObject({ ok: false });
    await expect(fileUploadNeedsApproval(join(workspace, 'missing.txt'), context)).resolves.toMatchObject({ ok: false });
    await expect(fileUploadNeedsApproval(join(workspace, 'nested'), context)).resolves.toMatchObject({ ok: false });
  });
});
