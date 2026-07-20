import { describe, expect, it, vi } from 'vitest';

import { formatSessionLabel } from '#/migration/badge';

vi.mock('#/i18n', () => ({
  t: (key: string) => {
    const translations: Record<string, string> = {
      'migration.badgeImported': '[imported]',
    };
    return translations[key] ?? key;
  },
  setLocale: vi.fn(),
  getLocale: () => 'en',
}));

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
});
