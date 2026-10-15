import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { writeResumeHint } from '#/cli/prompt-render';
import { resolveStartupWorkDir, resumeCommand } from '#/cli/startup-work-dir';
import { quoteShellArg } from '#/utils/shell-quote';

describe('resolveStartupWorkDir', () => {
  let launchDir: string;
  let target: string;

  beforeEach(async () => {
    launchDir = process.cwd();
    target = await realpath(await mkdtemp(join(tmpdir(), 'kimi-startup-work-dir-')));
  });

  afterEach(async () => {
    process.chdir(launchDir);
    vi.unstubAllEnvs();
    await rm(target, { recursive: true, force: true });
  });

  it('keeps the launch directory without the flag', async () => {
    const ensure = vi.fn(async () => target);

    expect(await resolveStartupWorkDir({ defaultWorkspace: false }, ensure)).toBe(launchDir);
    expect(ensure).not.toHaveBeenCalled();
    expect(process.cwd()).toBe(launchDir);
  });

  it('moves into the default workspace with the flag', async () => {
    vi.stubEnv('PWD', launchDir);

    expect(await resolveStartupWorkDir({ defaultWorkspace: true }, async () => target)).toBe(
      target,
    );
    expect(process.cwd()).toBe(target);
    expect(process.env['PWD']).toBe(target);
  });

  it('stays put when the default workspace cannot be prepared', async () => {
    const failure = new Error('default workspace is unavailable: permission denied');

    await expect(
      resolveStartupWorkDir({ defaultWorkspace: true }, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(process.cwd()).toBe(launchDir);
  });
});

describe('resumeCommand', () => {
  const workDir = '/Users/me/Documents/KimiCode/Default';

  it('repeats the flag so the session resumes from any directory', () => {
    expect(resumeCommand({ defaultWorkspace: true }, 'ses_1', workDir, `${workDir}/`)).toBe(
      'kimi --default-workspace -r ses_1',
    );
    expect(resumeCommand({}, 'ses_1', workDir, undefined)).toBe('kimi -r ses_1');
  });

  it('points at the session folder once the default workspace has moved', () => {
    expect(resumeCommand({ defaultWorkspace: true }, 'ses_1', workDir, '/Users/me/Chats')).toBe(
      `cd ${quoteShellArg(workDir)} && kimi -r ses_1`,
    );
    expect(resumeCommand({ defaultWorkspace: true }, 'ses_1', workDir, undefined)).toBe(
      `cd ${quoteShellArg(workDir)} && kimi -r ses_1`,
    );
  });

  it('is what print mode tells the user in both output formats', () => {
    const command = resumeCommand({ defaultWorkspace: true }, 'ses_1', workDir, workDir);
    const text = { stdout: '', stderr: '' };
    writeResumeHint('ses_1', command, 'text', sink(text, 'stdout'), sink(text, 'stderr'));
    const json = { stdout: '', stderr: '' };
    writeResumeHint('ses_1', command, 'stream-json', sink(json, 'stdout'), sink(json, 'stderr'));

    expect(text).toEqual({
      stdout: '',
      stderr: 'To resume this session: kimi --default-workspace -r ses_1\n',
    });
    expect(JSON.parse(json.stdout)).toMatchObject({
      type: 'session.resume_hint',
      session_id: 'ses_1',
      command: 'kimi --default-workspace -r ses_1',
    });
  });
});

function sink(target: { stdout: string; stderr: string }, key: 'stdout' | 'stderr') {
  return {
    write: (chunk: string) => {
      target[key] += chunk;
      return true;
    },
  };
}
