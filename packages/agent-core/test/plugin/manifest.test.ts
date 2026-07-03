import { mkdtemp, mkdir, writeFile, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseManifest } from '../../src/plugin/manifest';

async function makePlugin(
  files: Record<string, string>,
  options: { dirs?: readonly string[] } = {},
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'kimi-plugin-test-'));
  for (const dir of options.dirs ?? []) {
    await mkdir(path.join(root, dir), { recursive: true });
  }
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), body, 'utf8');
  }
  return realpath(root);
}

describe('parseManifest', () => {
  it('reads a minimal kimi.plugin.json at the plugin root', async () => {
    const root = await makePlugin({
      'kimi.plugin.json': JSON.stringify({ name: 'demo', version: '1.0.0' }),
    });
    const result = await parseManifest(root);
    expect(result.manifest?.name).toBe('demo');
    expect(result.manifest?.version).toBe('1.0.0');
    expect(result.manifestKind).toBe('kimi-plugin-root');
    expect(result.diagnostics).toEqual([]);
  });

  it('prefers root kimi.plugin.json when .kimi-plugin/plugin.json also exists', async () => {
    const root = await makePlugin({
      'kimi.plugin.json': JSON.stringify({ name: 'root-version', version: '1.0.0' }),
      '.kimi-plugin/plugin.json': JSON.stringify({ name: 'dir-version' }),
    });
    const result = await parseManifest(root);
    expect(result.manifestKind).toBe('kimi-plugin-root');
    expect(result.manifest?.name).toBe('root-version');
    expect(result.shadowedManifestPath).toBe(path.join(root, '.kimi-plugin/plugin.json'));
  });

  it('falls back to .kimi-plugin/plugin.json when kimi.plugin.json is absent', async () => {
    const root = await makePlugin(
      {
        '.kimi-plugin/plugin.json': JSON.stringify({
          name: 'demo',
          version: '1.0.0',
          keywords: ['workflow'],
          skills: './skills/',
          interface: { displayName: 'Demo' },
          sessionStart: { skill: 'using-demo' },
          skillInstructions: 'Use Kimi tools.',
        }),
      },
      { dirs: ['skills'] },
    );
    const result = await parseManifest(root);
    expect(result.manifestKind).toBe('kimi-plugin-dir');
    expect(result.manifestPath).toBe(path.join(root, '.kimi-plugin/plugin.json'));
    expect(result.manifest?.name).toBe('demo');
    expect(result.manifest?.version).toBe('1.0.0');
    expect(result.manifest?.keywords).toEqual(['workflow']);
    expect(result.manifest?.skills).toEqual([path.join(root, 'skills')]);
    expect(result.manifest?.interface?.displayName).toBe('Demo');
    expect(result.manifest?.sessionStart).toEqual({ skill: 'using-demo' });
    expect(result.manifest?.skillInstructions).toBe('Use Kimi tools.');
  });

  it('does NOT fall back to .kimi-plugin/plugin.json when kimi.plugin.json is invalid JSON', async () => {
    const root = await makePlugin({
      'kimi.plugin.json': '{ not json',
      '.kimi-plugin/plugin.json': JSON.stringify({ name: 'dir-version' }),
    });
    const result = await parseManifest(root);
    expect(result.manifest).toBeUndefined();
    expect(result.manifestKind).toBe('kimi-plugin-root');
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: 'error',
        message: expect.stringContaining('Failed to parse'),
      }),
    );
    expect(result.shadowedManifestPath).toBe(path.join(root, '.kimi-plugin/plugin.json'));
  });

  it('rejects names that violate the regex', async () => {
    const root = await makePlugin({
      'kimi.plugin.json': JSON.stringify({ name: 'Bad Name!' }),
    });
    const result = await parseManifest(root);
    expect(result.manifest).toBeUndefined();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: 'error',
        message: expect.stringContaining('"name" must match'),
      }),
    );
  });

  it('reports an error when no manifest file exists', async () => {
    const root = await makePlugin({});
    const result = await parseManifest(root);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: 'error',
        message: expect.stringContaining('No manifest at'),
      }),
    );
  });

  it('resolves a single skills path', async () => {
    const root = await makePlugin(
      { 'kimi.plugin.json': JSON.stringify({ name: 'demo', skills: './skills/' }) },
      { dirs: ['skills'] },
    );
    const result = await parseManifest(root);
    expect(result.manifest?.skills).toEqual([path.join(root, 'skills')]);
  });

  it('resolves an array of skills paths', async () => {
    const root = await makePlugin(
      {
        'kimi.plugin.json': JSON.stringify({
          name: 'demo',
          skills: ['./a/', './b/'],
        }),
      },
      { dirs: ['a', 'b'] },
    );
    const result = await parseManifest(root);
    expect(result.manifest?.skills).toEqual([path.join(root, 'a'), path.join(root, 'b')]);
  });

  it('rejects a skills path not prefixed with ./', async () => {
    const root = await makePlugin({
      'kimi.plugin.json': JSON.stringify({ name: 'demo', skills: 'skills/' }),
    });
    const result = await parseManifest(root);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: 'error',
        message: expect.stringContaining('"skills" path must start with "./"'),
      }),
    );
    expect(result.manifest?.skills).toEqual([]);
  });

  it('rejects a skills path that escapes plugin_root', async () => {
    const root = await makePlugin({
      'kimi.plugin.json': JSON.stringify({ name: 'demo', skills: './../escape' }),
    });
    const result = await parseManifest(root);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: 'error',
        message: expect.stringContaining('resolves outside the plugin'),
      }),
    );
  });

  it('rejects a skills path that escapes via a symlink', async () => {
    const root = await makePlugin({
      'kimi.plugin.json': JSON.stringify({ name: 'demo', skills: './sym' }),
    });
    const outside = await mkdtemp(path.join(tmpdir(), 'kimi-plugin-outside-'));
    await symlink(outside, path.join(root, 'sym'));
    const result = await parseManifest(root);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: 'error',
        message: expect.stringContaining('resolves outside the plugin'),
      }),
    );
  });

  it('warns when skills resolves to a non-directory', async () => {
    const root = await makePlugin({
      'kimi.plugin.json': JSON.stringify({ name: 'demo', skills: './notes.md' }),
      'notes.md': 'hi',
    });
    const result = await parseManifest(root);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: 'warn',
        message: expect.stringContaining('is not a directory'),
      }),
    );
  });

  it('falls back to root SKILL.md when skills field is absent', async () => {
    const root = await makePlugin({
      'kimi.plugin.json': JSON.stringify({ name: 'demo' }),
      'SKILL.md': '---\nname: root-skill\n---\nbody',
    });
    const result = await parseManifest(root);
    expect(result.manifest?.skills).toEqual([root]);
  });

  it('does not fall back to root SKILL.md when skills field is present', async () => {
    const root = await makePlugin(
      {
        'kimi.plugin.json': JSON.stringify({ name: 'demo', skills: './skills/' }),
        'SKILL.md': '---\nname: root-skill\n---\nbody',
      },
      { dirs: ['skills'] },
    );
    const result = await parseManifest(root);
    expect(result.manifest?.skills).toEqual([path.join(root, 'skills')]);
  });

  it('emits info diagnostics for unsupported runtime extension fields', async () => {
    const root = await makePlugin({
      'kimi.plugin.json': JSON.stringify({
        name: 'demo',
        tools: { foo: { description: 'x' } },
        configFile: 'cfg.json',
        config_file: 'legacy-cfg.json',
        inject: { foo: 'bar' },
        bootstrap: { skill: 'using-demo' },
        apps: './apps',
      }),
    });
    const result = await parseManifest(root);
    expect(result.manifest).toEqual(expect.objectContaining({ name: 'demo' }));
    for (const field of [
      'tools',
      'configFile',
      'config_file',
      'inject',
      'bootstrap',
      'apps',
    ]) {
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          severity: 'info',
          message: expect.stringContaining(`"${field}" is present but not supported`),
        }),
      );
    }
  });

  it('parses skillInstructions', async () => {
    const root = await makePlugin({
      'kimi.plugin.json': JSON.stringify({ name: 'demo', skillInstructions: 'Do this.' }),
    });
    const result = await parseManifest(root);
    expect(result.manifest?.skillInstructions).toBe('Do this.');
  });

  it('parses keywords metadata', async () => {
    const root = await makePlugin({
      'kimi.plugin.json': JSON.stringify({ name: 'demo', keywords: ['finance', 'workflow'] }),
    });
    const result = await parseManifest(root);
    expect(result.manifest?.keywords).toEqual(['finance', 'workflow']);
  });

  it('reads sessionStart', async () => {
    const root = await makePlugin({
      'kimi.plugin.json': JSON.stringify({
        name: 'demo',
        sessionStart: { skill: 'using-demo' },
      }),
    });
    const result = await parseManifest(root);
    expect(result.manifest?.sessionStart).toEqual({ skill: 'using-demo' });
  });

  it('does not read .codex-plugin/plugin.json as a manifest', async () => {
    const root = await makePlugin({
      '.codex-plugin/plugin.json': JSON.stringify({ name: 'demo', skills: './skills/' }),
    });
    const result = await parseManifest(root);
    expect(result.manifest).toBeUndefined();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: 'error',
        message: expect.stringContaining('No manifest at'),
      }),
    );
  });

  it('parses plugin mcpServers', async () => {
    const root = await makePlugin(
      {
        'kimi.plugin.json': JSON.stringify({
          name: 'demo',
          mcpServers: {
            finance: {
              command: './bin/finance-mcp',
              args: ['--stdio'],
              cwd: './bin',
              env: { FINANCE_API_KEY: 'x' },
            },
            docs: {
              url: 'https://example.com/mcp',
              headers: { 'X-Test': '1' },
            },
            events: {
              transport: 'sse',
              url: 'https://example.com/sse',
              headers: { 'X-Events': '1' },
            },
          },
        }),
      },
      { dirs: ['bin'] },
    );
    await writeFile(path.join(root, 'bin', 'finance-mcp'), '#!/bin/sh\n', 'utf8');
    const result = await parseManifest(root);
    expect(result.manifest?.mcpServers?.['finance']).toEqual({
      transport: 'stdio',
      command: path.join(root, 'bin', 'finance-mcp'),
      args: ['--stdio'],
      cwd: path.join(root, 'bin'),
      env: { FINANCE_API_KEY: 'x' },
    });
    expect(result.manifest?.mcpServers?.['docs']).toEqual({
      transport: 'http',
      url: 'https://example.com/mcp',
      headers: { 'X-Test': '1' },
    });
    expect(result.manifest?.mcpServers?.['events']).toEqual({
      transport: 'sse',
      url: 'https://example.com/sse',
      headers: { 'X-Events': '1' },
    });
  });

  it('warns and skips invalid plugin mcpServers entries', async () => {
    const root = await makePlugin({
      'kimi.plugin.json': JSON.stringify({
        name: 'demo',
        mcpServers: {
          bad: { command: '/tmp/unsafe' },
        },
      }),
    });
    const result = await parseManifest(root);
    expect(result.manifest?.mcpServers).toBeUndefined();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: 'warn',
        message: expect.stringContaining('must be a PATH command or start with "./"'),
      }),
    );
  });

  it('captures interface.displayName and shortDescription', async () => {
    const root = await makePlugin({
      'kimi.plugin.json': JSON.stringify({
        name: 'demo',
        interface: { displayName: 'Demo', shortDescription: 'A demo.' },
      }),
    });
    const result = await parseManifest(root);
    expect(result.manifest?.interface?.displayName).toBe('Demo');
    expect(result.manifest?.interface?.shortDescription).toBe('A demo.');
  });

  it('parses a flat hooks array from the manifest', async () => {
    const root = await makePlugin({
      'kimi.plugin.json': JSON.stringify({
        name: 'demo',
        hooks: [
          { event: 'PreToolUse', matcher: 'Bash', command: './hooks/guard.sh', timeout: 10 },
          { event: 'UserPromptSubmit', command: 'node ./hooks/log.js' },
        ],
      }),
    });
    const result = await parseManifest(root);
    expect(result.diagnostics).toEqual([]);
    expect(result.manifest?.hooks).toEqual([
      { event: 'PreToolUse', matcher: 'Bash', command: './hooks/guard.sh', timeout: 10 },
      { event: 'UserPromptSubmit', command: 'node ./hooks/log.js' },
    ]);
  });

  it('warns and skips a hook entry that is missing required fields', async () => {
    const root = await makePlugin({
      'kimi.plugin.json': JSON.stringify({
        name: 'demo',
        hooks: [{ event: 'PreToolUse' }],
      }),
    });
    const result = await parseManifest(root);
    expect(result.manifest?.hooks).toBeUndefined();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ severity: 'warn', message: expect.stringContaining('index 0') }),
    );
  });

  it('warns when hooks is not an array', async () => {
    const root = await makePlugin({
      'kimi.plugin.json': JSON.stringify({ name: 'demo', hooks: { event: 'Stop', command: 'x' } }),
    });
    const result = await parseManifest(root);
    expect(result.manifest?.hooks).toBeUndefined();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ severity: 'warn', message: '"hooks" must be an array' }),
    );
  });

  it('rejects a hook entry that sets cwd/env (strict schema)', async () => {
    const root = await makePlugin({
      'kimi.plugin.json': JSON.stringify({
        name: 'demo',
        hooks: [{ event: 'PreToolUse', command: './x.sh', cwd: '/tmp' }],
      }),
    });
    const result = await parseManifest(root);
    expect(result.manifest?.hooks).toBeUndefined();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ severity: 'warn' }));
  });

  it('resolves a commands directory to its .md files', async () => {
    const root = await makePlugin(
      {
        'kimi.plugin.json': JSON.stringify({ name: 'demo', commands: ['./commands'] }),
        'commands/deploy.md': '---\ndescription: Deploy\n---\nbody',
        'commands/env.md': '---\ndescription: Env\n---\nbody',
        'commands/notes.txt': 'ignored',
      },
      { dirs: ['commands'] },
    );
    const result = await parseManifest(root);
    expect(result.diagnostics).toEqual([]);
    expect(result.manifest?.commands).toEqual([
      { path: path.join(root, 'commands/deploy.md'), name: 'deploy' },
      { path: path.join(root, 'commands/env.md'), name: 'env' },
    ]);
  });

  it('recurses into nested command directories and preserves the namespace', async () => {
    const root = await makePlugin(
      {
        'kimi.plugin.json': JSON.stringify({ name: 'demo', commands: ['./commands'] }),
        'commands/deploy.md': '---\ndescription: Deploy\n---\nbody',
        'commands/frontend/component.md': '---\ndescription: Component\n---\nbody',
        'commands/frontend/deep/nested.md': '---\ndescription: Nested\n---\nbody',
      },
      { dirs: ['commands', 'commands/frontend', 'commands/frontend/deep'] },
    );
    const result = await parseManifest(root);
    expect(result.diagnostics).toEqual([]);
    expect(result.manifest?.commands).toEqual([
      { path: path.join(root, 'commands/deploy.md'), name: 'deploy' },
      { path: path.join(root, 'commands/frontend/component.md'), name: 'frontend/component' },
      { path: path.join(root, 'commands/frontend/deep/nested.md'), name: 'frontend/deep/nested' },
    ]);
  });

  it('accepts a single command .md file', async () => {
    const root = await makePlugin({
      'kimi.plugin.json': JSON.stringify({ name: 'demo', commands: ['./deploy.md'] }),
      'deploy.md': '---\ndescription: Deploy\n---\nbody',
    });
    const result = await parseManifest(root);
    expect(result.manifest?.commands).toEqual([
      { path: path.join(root, 'deploy.md'), name: 'deploy' },
    ]);
  });

  it('warns when commands is not a string or string[]', async () => {
    const root = await makePlugin({
      'kimi.plugin.json': JSON.stringify({ name: 'demo', commands: { nope: true } }),
    });
    const result = await parseManifest(root);
    expect(result.manifest?.commands).toBeUndefined();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: 'warn',
        message: '"commands" must be a string or string[]',
      }),
    );
  });

  it('warns when a commands entry resolves outside the plugin', async () => {
    const root = await makePlugin({
      'kimi.plugin.json': JSON.stringify({ name: 'demo', commands: ['../outside.md'] }),
    });
    const result = await parseManifest(root);
    expect(result.manifest?.commands).toBeUndefined();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ severity: 'warn' }));
  });
});
