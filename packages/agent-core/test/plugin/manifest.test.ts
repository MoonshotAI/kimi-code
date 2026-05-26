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
  it('reads a minimal plugin.json', async () => {
    const root = await makePlugin({
      'plugin.json': JSON.stringify({ name: 'demo', version: '1.0.0' }),
    });
    const result = await parseManifest(root);
    expect(result.manifest?.name).toBe('demo');
    expect(result.manifest?.version).toBe('1.0.0');
    expect(result.manifestKind).toBe('plugin-json');
    expect(result.diagnostics).toEqual([]);
  });

  it('prefers plugin.json when .kimi-plugin/plugin.json also exists', async () => {
    const root = await makePlugin({
      'plugin.json': JSON.stringify({ name: 'plugin-json-version', version: '1.0.0' }),
      '.kimi-plugin/plugin.json': JSON.stringify({ name: 'kimi-plugin-version' }),
    });
    const result = await parseManifest(root);
    expect(result.manifestKind).toBe('plugin-json');
    expect(result.manifest?.name).toBe('plugin-json-version');
    expect(result.shadowedManifestPath).toBe(path.join(root, '.kimi-plugin/plugin.json'));
  });

  it('reads .kimi-plugin/plugin.json when plugin.json is absent', async () => {
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
    expect(result.manifestKind).toBe('kimi-plugin');
    expect(result.manifestPath).toBe(path.join(root, '.kimi-plugin/plugin.json'));
    expect(result.manifest?.name).toBe('demo');
    expect(result.manifest?.version).toBe('1.0.0');
    expect(result.manifest?.keywords).toEqual(['workflow']);
    expect(result.manifest?.skills).toEqual([path.join(root, 'skills')]);
    expect(result.manifest?.interface?.displayName).toBe('Demo');
    expect(result.manifest?.sessionStart).toEqual({ skill: 'using-demo' });
    expect(result.manifest?.skillInstructions).toBe('Use Kimi tools.');
  });

  it('does NOT fall back to .kimi-plugin/plugin.json when plugin.json is invalid JSON', async () => {
    const root = await makePlugin({
      'plugin.json': '{ not json',
      '.kimi-plugin/plugin.json': JSON.stringify({ name: 'kimi-plugin-version' }),
    });
    const result = await parseManifest(root);
    expect(result.manifest).toBeUndefined();
    expect(result.manifestKind).toBe('plugin-json');
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'manifest.invalid_json' }),
    );
    expect(result.shadowedManifestPath).toBe(path.join(root, '.kimi-plugin/plugin.json'));
  });

  it('rejects names that violate the regex', async () => {
    const root = await makePlugin({
      'plugin.json': JSON.stringify({ name: 'Bad Name!' }),
    });
    const result = await parseManifest(root);
    expect(result.manifest).toBeUndefined();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'manifest.invalid_name' }),
    );
  });

  it('returns manifest.missing when neither file exists', async () => {
    const root = await makePlugin({});
    const result = await parseManifest(root);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'manifest.missing' }),
    );
  });

  it('resolves a single skills path', async () => {
    const root = await makePlugin(
      { 'plugin.json': JSON.stringify({ name: 'demo', skills: './skills/' }) },
      { dirs: ['skills'] },
    );
    const result = await parseManifest(root);
    expect(result.manifest?.skills).toEqual([path.join(root, 'skills')]);
  });

  it('resolves an array of skills paths', async () => {
    const root = await makePlugin(
      {
        'plugin.json': JSON.stringify({
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
      'plugin.json': JSON.stringify({ name: 'demo', skills: 'skills/' }),
    });
    const result = await parseManifest(root);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'manifest.skills.path_required_dot_slash' }),
    );
    expect(result.manifest?.skills).toEqual([]);
  });

  it('rejects a skills path that escapes plugin_root', async () => {
    const root = await makePlugin({
      'plugin.json': JSON.stringify({ name: 'demo', skills: './../escape' }),
    });
    const result = await parseManifest(root);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'manifest.skills.path_escape' }),
    );
  });

  it('rejects a skills path that escapes via a symlink', async () => {
    const root = await makePlugin({
      'plugin.json': JSON.stringify({ name: 'demo', skills: './sym' }),
    });
    const outside = await mkdtemp(path.join(tmpdir(), 'kimi-plugin-outside-'));
    await symlink(outside, path.join(root, 'sym'));
    const result = await parseManifest(root);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'manifest.skills.path_escape' }),
    );
  });

  it('warns when skills resolves to a non-directory', async () => {
    const root = await makePlugin({
      'plugin.json': JSON.stringify({ name: 'demo', skills: './notes.md' }),
      'notes.md': 'hi',
    });
    const result = await parseManifest(root);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'manifest.skills.not_a_directory',
        severity: 'warn',
      }),
    );
  });

  it('falls back to root SKILL.md when skills field is absent', async () => {
    const root = await makePlugin({
      'plugin.json': JSON.stringify({ name: 'demo' }),
      'SKILL.md': '---\nname: root-skill\n---\nbody',
    });
    const result = await parseManifest(root);
    expect(result.manifest?.skills).toEqual([root]);
  });

  it('does not fall back to root SKILL.md when skills field is present', async () => {
    const root = await makePlugin(
      {
        'plugin.json': JSON.stringify({ name: 'demo', skills: './skills/' }),
        'SKILL.md': '---\nname: root-skill\n---\nbody',
      },
      { dirs: ['skills'] },
    );
    const result = await parseManifest(root);
    expect(result.manifest?.skills).toEqual([path.join(root, 'skills')]);
  });

  it('reports unsupported runtime fields in plugin.json without parsing them as capabilities', async () => {
    const root = await makePlugin({
      'plugin.json': JSON.stringify({
        name: 'demo',
        tools: [
          { name: 'tool-a', description: 'Desc A', command: ['echo', 'a'] },
          { name: 'tool-b', description: 'Desc B', command: ['echo', 'b'] },
        ],
        configFile: 'cfg.json',
        config_file: 'legacy-cfg.json',
        inject: { foo: 'bar' },
        bootstrap: { skill: 'using-demo' },
        hooks: { sessionStart: { skill: 'using-demo' } },
        apps: './apps',
      }),
    });
    const result = await parseManifest(root);
    expect(result.manifest).toEqual(
      expect.objectContaining({
        name: 'demo',
      }),
    );
    for (const field of [
      'tools',
      'configFile',
      'config_file',
      'inject',
      'bootstrap',
      'hooks',
      'apps',
    ]) {
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          code: `manifest.unsupported_field.${field}`,
          severity: 'info',
        }),
      );
    }
  });

  it('parses skillInstructions', async () => {
    const root = await makePlugin({
      'plugin.json': JSON.stringify({ name: 'demo', skillInstructions: 'Do this.' }),
    });
    const result = await parseManifest(root);
    expect(result.manifest?.skillInstructions).toBe('Do this.');
  });

  it('parses keywords metadata', async () => {
    const root = await makePlugin({
      'plugin.json': JSON.stringify({ name: 'demo', keywords: ['finance', 'workflow'] }),
    });
    const result = await parseManifest(root);
    expect(result.manifest?.keywords).toEqual(['finance', 'workflow']);
  });

  it('reads sessionStart in plugin.json', async () => {
    const root = await makePlugin({
      'plugin.json': JSON.stringify({
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
      expect.objectContaining({ code: 'manifest.missing', severity: 'error' }),
    );
  });

  it('parses plugin mcpServers without enabling them', async () => {
    const root = await makePlugin(
      {
        'plugin.json': JSON.stringify({
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
  });

  it('warns and skips invalid plugin mcpServers entries', async () => {
    const root = await makePlugin({
      'plugin.json': JSON.stringify({
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
        code: 'manifest.mcpServers.bad.command.path_required_dot_slash',
        severity: 'warn',
      }),
    );
  });

  it('captures interface.displayName and shortDescription', async () => {
    const root = await makePlugin({
      'plugin.json': JSON.stringify({
        name: 'demo',
        interface: { displayName: 'Demo', shortDescription: 'A demo.' },
      }),
    });
    const result = await parseManifest(root);
    expect(result.manifest?.interface?.displayName).toBe('Demo');
    expect(result.manifest?.interface?.shortDescription).toBe('A demo.');
  });
});
