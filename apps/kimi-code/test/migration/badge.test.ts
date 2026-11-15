import { describe, expect, it } from 'vitest';

import { formatSessionLabel } from '#/migration/badge';

describe('formatSessionLabel', () => {
  it('prepends [imported] when metadata.imported_from_kimi_cli === true', () => {
    const label = formatSessionLabel({
      title: 'Refactor sessions list',
      metadata: { imported_from_kimi_cli: true },
    });
    expect(label).toBe('[imported] Refactor sessions list');
  });

  it('does not prepend [imported] when metadata is missing', () => {
    const label = formatSessionLabel({ title: 'Plain session' });
    expect(label).toBe('Plain session');
  });

  it('does not prepend [imported] when metadata is empty', () => {
    const label = formatSessionLabel({ title: 'Plain session', metadata: {} });
    expect(label).toBe('Plain session');
  });

  it('only triggers on the literal boolean true (not truthy values)', () => {
    const label = formatSessionLabel({
      title: 'truthy but not true',
      metadata: { imported_from_kimi_cli: 'yes' as unknown },
    });
    expect(label).toBe('truthy but not true');
  });

  it('does not prepend [imported] when flag is false', () => {
    const label = formatSessionLabel({
      title: 'native session',
      metadata: { imported_from_kimi_cli: false },
    });
    expect(label).toBe('native session');
  });

  it('preserves the title even when it is empty', () => {
    const label = formatSessionLabel({
      title: '',
      metadata: { imported_from_kimi_cli: true },
    });
    expect(label).toBe('[imported] ');
  });

  it('prepends the source tool for sessions imported from Claude Code or Codex', () => {
    expect(formatSessionLabel({ title: 'Fix login', metadata: { imported_from: 'claude-code' } })).toBe(
      '[Claude Code] Fix login',
    );
    expect(formatSessionLabel({ title: 'Add tests', metadata: { imported_from: 'codex' } })).toBe('[Codex] Add tests');
    expect(formatSessionLabel({ title: 'Unknown source', metadata: { imported_from: 'other' } })).toBe(
      'Unknown source',
    );
  });
});
