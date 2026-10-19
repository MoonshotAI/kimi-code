import { describe, expect, it } from 'vitest';

import type { BannerAudienceContext } from '#/tui/banner/audience';
import {
  selectBannerState,
  selectDisplayableBanner,
  shouldDisplayBanner,
} from '#/tui/banner/banner-provider';
import type { BannerState } from '#/tui/types';

const now = new Date('2026-06-15T12:00:00+08:00');

const audience: BannerAudienceContext = {
  login: 'logged_in',
  userLevel: 27,
  goodsVersion: 1,
  accountRegion: 'cn',
};

function tip(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { banner_id: 'test-banner', banner_enabled: true, banner_maintext: 'Main', ...overrides };
}

function select(json: unknown, random: () => number = () => 0): BannerState | null {
  return selectBannerState({ json, clientVersion: '0.14.0', now, random, audience, system: 'mac' });
}

function selectWithSystem(json: unknown, system: string): BannerState | null {
  return selectBannerState({ json, clientVersion: '0.14.0', now, random: () => 0, audience, system });
}

describe('selectBannerState', () => {
  it('returns null when banner_tips is missing, not an array, or empty', () => {
    expect(select({})).toBeNull();
    expect(select({ banner_tips: 'nope' })).toBeNull();
    expect(select({ banner_tips: [] })).toBeNull();
  });

  it('returns the single enabled tip with its fields mapped', () => {
    const result = select({
      banner_tips: [
        tip({
          banner_title: 'New',
          banner_maintext: 'Active',
          banner_subtext: 'Details',
        }),
      ],
    });
    expect(result).toMatchObject({
      tag: 'New',
      mainText: 'Active',
      subText: 'Details',
      display: 'always',
    });
    expect(result?.key).toEqual(expect.any(String));
    expect(result?.ttlHours).toBeUndefined();
  });

  it('skips entries that are not enabled or not objects', () => {
    const result = select({
      banner_tips: [
        'garbage',
        null,
        tip({ banner_enabled: false, banner_maintext: 'Hidden' }),
        tip({ banner_enabled: 'yes', banner_maintext: 'Not true' }),
        tip({ banner_maintext: 'Visible' }),
      ],
    });
    expect(result).toMatchObject({ mainText: 'Visible' });
  });

  it('keeps an entry with only a title and no main text', () => {
    const result = select({
      banner_tips: [tip({ banner_title: 'Title only', banner_maintext: '' })],
    });
    expect(result).toMatchObject({ tag: 'Title only', mainText: null });
  });

  it('skips entries when both title and main text are empty', () => {
    const result = select({
      banner_tips: [
        tip({ banner_title: '', banner_maintext: '' }),
        tip({ banner_title: null, banner_maintext: '  ' }),
        tip({ banner_maintext: 'Visible' }),
      ],
    });
    expect(result).toMatchObject({ mainText: 'Visible' });
  });

  it('filters entries by min, max, and exact version', () => {
    const result = select({
      banner_tips: [
        tip({ banner_maintext: 'Too new', banner_min_version: '0.15.0' }),
        tip({ banner_maintext: 'Too old', banner_max_version: '0.14.0' }),
        tip({ banner_maintext: 'Pinned elsewhere', banner_version: '0.13.0' }),
        tip({ banner_maintext: 'Matching', banner_min_version: '0.13.0', banner_max_version: '0.15.0' }),
      ],
    });
    expect(result).toMatchObject({ mainText: 'Matching' });
  });

  it('filters out entries with a non-semver version constraint', () => {
    expect(select({ banner_tips: [tip({ banner_max_version: 'not-a-version' })] })).toBeNull();
    expect(select({ banner_tips: [tip({ banner_version: 'not-a-version' })] })).toBeNull();
  });

  it('filters entries by platform', () => {
    const result = select({
      banner_tips: [
        tip({ banner_maintext: 'Desktop', banner_platform: 'desktop' }),
        tip({ banner_maintext: 'Web', banner_platform: 'web' }),
        tip({ banner_maintext: 'Cli', banner_platform: 'cli' }),
      ],
    });
    expect(result).toMatchObject({ mainText: 'Cli' });
  });

  it('matches any system when banner_system is missing, empty, or not an array', () => {
    for (const banner_system of [undefined, null, [], 'mac']) {
      const result = selectWithSystem({ banner_tips: [tip({ banner_system })] }, 'linux');
      expect(result, `banner_system=${String(banner_system)}`).not.toBeNull();
    }
  });

  it('matches only when the current system is in banner_system', () => {
    const json = { banner_tips: [tip({ banner_system: ['mac', 'linux'] })] };
    expect(selectWithSystem(json, 'mac')).not.toBeNull();
    expect(selectWithSystem(json, 'linux')).not.toBeNull();
    expect(selectWithSystem(json, 'win')).toBeNull();
  });

  it('normalizes case and whitespace of banner_system entries', () => {
    const json = { banner_tips: [tip({ banner_system: [' MAC '] })] };
    expect(selectWithSystem(json, 'mac')).not.toBeNull();
  });

  it('ignores non-string banner_system entries', () => {
    expect(selectWithSystem({ banner_tips: [tip({ banner_system: [42, 'mac'] })] }, 'mac')).not.toBeNull();
    expect(selectWithSystem({ banner_tips: [tip({ banner_system: [42] })] }, 'win')).not.toBeNull();
  });

  it('filters entries by system among multiple tips', () => {
    const result = selectWithSystem(
      {
        banner_tips: [
          tip({ banner_maintext: 'Mac only', banner_system: ['mac'] }),
          tip({ banner_maintext: 'Windows only', banner_system: ['win'] }),
        ],
      },
      'win',
    );
    expect(result).toMatchObject({ mainText: 'Windows only' });
  });

  it('shows entries when platform is missing, empty, all, or cli', () => {
    for (const banner_platform of [undefined, null, '', '  ', 'all', 'cli', 'ALL', ' CLI ']) {
      const result = select({ banner_tips: [tip({ banner_platform })] });
      expect(result, `platform=${String(banner_platform)}`).not.toBeNull();
    }
  });

  it('filters entries by their time window', () => {
    const result = select({
      banner_tips: [
        tip({ banner_maintext: 'Expired', banner_end_time: '2026-06-01T00:00:00+08:00' }),
        tip({ banner_maintext: 'Future', banner_start_time: '2026-07-01T00:00:00+08:00' }),
        tip({
          banner_maintext: 'Current',
          banner_start_time: '2026-06-01T00:00:00+08:00',
          banner_end_time: '2026-06-30T00:00:00+08:00',
        }),
      ],
    });
    expect(result).toMatchObject({ mainText: 'Current' });
  });

  it('treats missing or empty time fields as always valid', () => {
    const result = select({
      banner_tips: [tip({ banner_start_time: '', banner_end_time: null })],
    });
    expect(result).not.toBeNull();
  });

  it('falls back to UTC when timestamps have no timezone', () => {
    const result = select({
      banner_tips: [
        tip({
          banner_start_time: '2026-06-15T04:00:00',
          banner_end_time: '2026-06-15T20:00:00',
        }),
      ],
    });
    expect(result).not.toBeNull();
  });

  it('picks randomly among all matching entries', () => {
    const json = {
      banner_tips: [
        tip({ banner_maintext: 'First' }),
        tip({ banner_maintext: 'Second' }),
        tip({ banner_maintext: 'Third' }),
      ],
    };
    expect(select(json, () => 0)).toMatchObject({ mainText: 'First' });
    expect(select(json, () => 0.5)).toMatchObject({ mainText: 'Second' });
    expect(select(json, () => 0.99)).toMatchObject({ mainText: 'Third' });
  });

  it('skips entries whose audience does not match the context', () => {
    const result = select({
      banner_tips: [
        tip({ banner_maintext: 'Other tiers', kfc_audience: { login: 'all', tiers: [15, 20], region: 'all' } }),
        tip({ banner_maintext: 'Anonymous only', kfc_audience: { login: 'anonymous' } }),
        tip({ banner_maintext: 'Oversea only', kfc_audience: { region: 'oversea' } }),
        tip({ banner_maintext: 'Mine', kfc_audience: { login: 'logged_in', tiers: [27], region: 'cn' } }),
      ],
    });
    expect(result).toMatchObject({ mainText: 'Mine' });
  });

  it('uses banner_id as the banner key', () => {
    const result = select({ banner_tips: [tip({ banner_id: 'active-1' })] });
    expect(result).toMatchObject({ key: 'active-1' });
  });

  it('skips entries without a valid banner_id', () => {
    const result = select({
      banner_tips: [
        tip({ banner_id: '', banner_maintext: 'Empty id' }),
        tip({ banner_id: '  ', banner_maintext: 'Blank id' }),
        tip({ banner_id: null, banner_maintext: 'Missing id' }),
        tip({ banner_id: 'kept', banner_maintext: 'Kept' }),
      ],
    });
    expect(result).toMatchObject({ key: 'kept' });
  });

  it('parses cooldown display and ttl hours per entry', () => {
    const result = select({
      banner_tips: [
        tip({ banner_id: 'c', banner_display: 'cooldown', banner_display_ttl_hours: 72 }),
      ],
    });
    expect(result).toMatchObject({ key: 'c', display: 'cooldown', ttlHours: 72 });
  });

  it('falls back to 24 hours when cooldown ttl is invalid', () => {
    const result = select({
      banner_tips: [tip({ banner_display: 'cooldown', banner_display_ttl_hours: 0 })],
    });
    expect(result).toMatchObject({ display: 'cooldown', ttlHours: 24 });
  });

  it('falls back to always for unknown display values', () => {
    const result = select({ banner_tips: [tip({ banner_display: '24h' })] });
    expect(result).toMatchObject({ display: 'always' });
    expect(result?.ttlHours).toBeUndefined();
  });

  it('treats an empty tag as null and missing subtext as null', () => {
    const result = select({ banner_tips: [tip({ banner_title: '', banner_maintext: 'No tag' })] });
    expect(result).toMatchObject({ tag: null, mainText: 'No tag', subText: null });
  });
});

describe('shouldDisplayBanner', () => {
  const boundaryNow = new Date('2026-06-16T12:00:00.000Z');

  const banner: BannerState = {
    key: 'always',
    tag: null,
    mainText: 'Always',
    subText: null,
    display: 'always',
  };

  it('returns true for always banners even when they were shown before', () => {
    expect(
      shouldDisplayBanner(
        banner,
        {
          version: 1,
          shown: {
            always: { lastShownAt: '2026-06-16T11:59:59.000Z' },
          },
        },
        boundaryNow,
      ),
    ).toBe(true);
  });

  it('returns true for once banners without a shown record', () => {
    expect(
      shouldDisplayBanner(
        { ...banner, key: 'once', display: 'once' },
        { version: 1, shown: {} },
        boundaryNow,
      ),
    ).toBe(true);
  });

  it('returns false for once banners with a shown record', () => {
    expect(
      shouldDisplayBanner(
        { ...banner, key: 'once', display: 'once' },
        {
          version: 1,
          shown: {
            once: { lastShownAt: '2026-06-16T11:59:59.000Z' },
          },
        },
        boundaryNow,
      ),
    ).toBe(false);
  });

  it('treats an invalid shown record as not shown', () => {
    expect(
      shouldDisplayBanner(
        { ...banner, key: 'once', display: 'once' },
        {
          version: 1,
          shown: {
            once: { lastShownAt: 'not-a-date' },
          },
        },
        boundaryNow,
      ),
    ).toBe(true);
  });

  it('returns false during cooldown ttl', () => {
    expect(
      shouldDisplayBanner(
        { ...banner, key: 'cooldown', display: 'cooldown', ttlHours: 24 },
        {
          version: 1,
          shown: {
            cooldown: { lastShownAt: '2026-06-16T00:00:00.000Z' },
          },
        },
        boundaryNow,
      ),
    ).toBe(false);
  });

  it('returns true at the cooldown ttl boundary', () => {
    expect(
      shouldDisplayBanner(
        { ...banner, key: 'cooldown', display: 'cooldown', ttlHours: 24 },
        {
          version: 1,
          shown: {
            cooldown: { lastShownAt: '2026-06-15T12:00:00.000Z' },
          },
        },
        boundaryNow,
      ),
    ).toBe(true);
  });

  it('supports custom cooldown ttl values', () => {
    expect(
      shouldDisplayBanner(
        { ...banner, key: 'cooldown', display: 'cooldown', ttlHours: 1 },
        {
          version: 1,
          shown: {
            cooldown: { lastShownAt: '2026-06-16T11:30:00.000Z' },
          },
        },
        boundaryNow,
      ),
    ).toBe(false);
    expect(
      shouldDisplayBanner(
        { ...banner, key: 'cooldown', display: 'cooldown', ttlHours: 168 },
        {
          version: 1,
          shown: {
            cooldown: { lastShownAt: '2026-06-09T12:00:01.000Z' },
          },
        },
        boundaryNow,
      ),
    ).toBe(false);
  });
});

describe('selectDisplayableBanner', () => {
  const boundaryNow = new Date('2026-06-16T12:00:00.000Z');

  function selectDisplayable(
    json: unknown,
    state: { version: 1; shown: Record<string, { lastShownAt: string }> },
    random: () => number = () => 0,
  ): BannerState | null {
    return selectDisplayableBanner({
      json,
      clientVersion: '0.14.0',
      now: boundaryNow,
      random,
      audience,
      system: 'mac',
      state,
    });
  }

  it('skips entries that were already shown and picks a displayable one', () => {
    const result = selectDisplayable(
      {
        banner_tips: [
          tip({ banner_id: 'shown-once', banner_maintext: 'Shown', banner_display: 'once' }),
          tip({ banner_id: 'fresh', banner_maintext: 'Fresh' }),
        ],
      },
      {
        version: 1,
        shown: {
          'shown-once': { lastShownAt: '2026-06-16T00:00:00.000Z' },
        },
      },
    );
    expect(result).toMatchObject({ key: 'fresh', display: 'always' });
  });

  it('keeps a cooldown entry once its ttl elapsed', () => {
    const result = selectDisplayable(
      {
        banner_tips: [
          tip({
            banner_id: 'cool',
            banner_maintext: 'Cooldown',
            banner_display: 'cooldown',
            banner_display_ttl_hours: 24,
          }),
        ],
      },
      {
        version: 1,
        shown: {
          cool: { lastShownAt: '2026-06-15T12:00:00.000Z' },
        },
      },
    );
    expect(result).toMatchObject({ key: 'cool', display: 'cooldown', ttlHours: 24 });
  });

  it('returns null when every matching entry was already shown', () => {
    const result = selectDisplayable(
      {
        banner_tips: [tip({ banner_id: 'shown-once', banner_maintext: 'Shown', banner_display: 'once' })],
      },
      {
        version: 1,
        shown: {
          'shown-once': { lastShownAt: '2026-06-16T00:00:00.000Z' },
        },
      },
    );
    expect(result).toBeNull();
  });

  it('randomly chooses only among displayable candidates', () => {
    const result = selectDisplayable(
      {
        banner_tips: [
          tip({ banner_id: 'shown-once', banner_maintext: 'Shown', banner_display: 'once' }),
          tip({ banner_id: 'fresh-a', banner_maintext: 'Fresh A' }),
          tip({ banner_id: 'fresh-b', banner_maintext: 'Fresh B' }),
        ],
      },
      {
        version: 1,
        shown: {
          'shown-once': { lastShownAt: '2026-06-16T00:00:00.000Z' },
        },
      },
      () => 0.99,
    );
    expect(result).toMatchObject({ key: 'fresh-b' });
  });
});
