import { describe, expect, it } from 'vitest';

import { applyCompatShims } from '../../src/plugin/superpowers';
import type { PluginRecord } from '../../src/plugin/types';

function baseRecord(overrides: Partial<PluginRecord>): PluginRecord {
  return {
    id: 'superpowers',
    root: '/fake',
    source: 'local-path',
    enabled: true,
    state: 'ok',
    installedAt: '2026-05-25T09:00:00Z',
    recognizedFields: {},
    diagnostics: [],
    manifest: { name: 'superpowers', skills: ['/fake/skills'] },
    manifestKind: 'codex',
    manifestPath: '/fake/.codex-plugin/plugin.json',
    ...overrides,
  };
}

describe('applyCompatShims', () => {
  it('synthesizes a bootstrap for superpowers when manifest lacks one', () => {
    const result = applyCompatShims(baseRecord({}));
    expect(result.manifest?.bootstrap).toEqual({ skill: 'using-superpowers' });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'compat.bootstrap.synthesized' }),
    );
  });

  it('leaves a record alone when bootstrap is already declared', () => {
    const record = baseRecord({
      manifest: { name: 'superpowers', bootstrap: { skill: 'something-else' } },
    });
    const result = applyCompatShims(record);
    expect(result.manifest?.bootstrap?.skill).toBe('something-else');
    expect(result.diagnostics).not.toContainEqual(
      expect.objectContaining({ code: 'compat.bootstrap.synthesized' }),
    );
  });

  it('leaves non-superpowers plugins untouched', () => {
    const record = baseRecord({ id: 'other', manifest: { name: 'other' } });
    const result = applyCompatShims(record);
    expect(result.manifest?.bootstrap).toBeUndefined();
  });

  it('skips synthesis when the plugin is in error state', () => {
    const record = baseRecord({ state: 'error', manifest: undefined });
    const result = applyCompatShims(record);
    expect(result).toBe(record);
  });
});
