import { describe, expect, it } from 'vitest';

import {
  selectBannerState,
  selectDisplayableBanner,
  shouldDisplayBanner,
} from '#/tui/banner/banner-provider';
import type { BannerState } from '#/tui/types';

describe('selectBannerState', () => {
  const now = new Date('2026-06-15T12:00:00+08:00');

  function expectAlwaysBanner(
    result: BannerState | null,
    expected: Pick<BannerState, 'tag' | 'mainText' | 'subText'>,
  ): BannerState {
    expect(result).not.toBeNull();
    const banner = result!;
    expect(banner).toMatchObject({ ...expected, display: 'always' });
    expect(banner.key).toEqual(expect.any(String));
    expect(banner.ttlHours).toBeUndefined();
    return banner;
  }

  it('returns the active banner when enabled and no time window is set', () => {
    const result = selectBannerState(
      {
        banner_enabled: true,
        banner_title: 'New',
        banner_maintext: 'Active',
        banner_subtext: 'Details',
      },
      '0.14.0',
      now,
      () => 0,
    );
    expectAlwaysBanner(result, { tag: 'New', mainText: 'Active', subText: 'Details' });
  });

  it('returns null when the active banner is outside its time window', () => {
    const result = selectBannerState(
      {
        banner_enabled: true,
        banner_title: 'Old',
        banner_maintext: 'Expired',
        banner_start_time: '2026-05-01T00:00:00+08:00',
        banner_end_time: '2026-05-31T00:00:00+08:00',
      },
      '0.14.0',
      now,
      () => 0,
    );
    expect(result).toBeNull();
  });

  it('filters out the active banner when the client version is too low', () => {
    const result = selectBannerState(
      {
        banner_enabled: true,
        banner_maintext: 'New',
        banner_min_version: '0.15.0',
      },
      '0.14.0',
      now,
      () => 0,
    );
    expect(result).toBeNull();
  });

  it('picks a random enabled fallback when the active banner is not shown', () => {
    const result = selectBannerState(
      {
        banner_enabled: false,
        banner_fallback_enabled: true,
        banner_fallback_list: [
          { enabled: true, banner_title: 'Tip', banner_maintext: 'First' },
          { enabled: true, banner_title: 'Tip', banner_maintext: 'Second' },
        ],
      },
      '0.14.0',
      now,
      () => 0.75,
    );
    expectAlwaysBanner(result, { tag: 'Tip', mainText: 'Second', subText: null });
  });

  it('filters out fallback entries when the client version is too low', () => {
    const result = selectBannerState(
      {
        banner_enabled: false,
        banner_fallback_enabled: true,
        banner_fallback_list: [
          { enabled: true, banner_maintext: 'Old tip' },
          { enabled: true, banner_maintext: 'New tip', banner_min_version: '0.15.0' },
        ],
      },
      '0.14.0',
      now,
      () => 0,
    );
    expectAlwaysBanner(result, { tag: null, mainText: 'Old tip', subText: null });
  });

  it('returns null when no enabled fallback entries exist', () => {
    const result = selectBannerState(
      {
        banner_enabled: false,
        banner_fallback_enabled: true,
        banner_fallback_list: [{ enabled: false, banner_maintext: 'Hidden' }],
      },
      '0.14.0',
      now,
      () => 0,
    );
    expect(result).toBeNull();
  });

  it('returns null for malformed input fields', () => {
    expect(selectBannerState({ weird: true }, '0.14.0', now, () => 0)).toBeNull();
  });

  it('falls back to the fallback list when banner_enabled is missing', () => {
    const result = selectBannerState(
      {
        banner_fallback_enabled: true,
        banner_fallback_list: [{ enabled: true, banner_maintext: 'Fallback' }],
      },
      '0.14.0',
      now,
      () => 0,
    );
    expectAlwaysBanner(result, { tag: null, mainText: 'Fallback', subText: null });
  });

  it('treats an empty tag as null while still showing the banner', () => {
    const result = selectBannerState(
      {
        banner_enabled: true,
        banner_title: '',
        banner_maintext: 'No tag',
      },
      '0.14.0',
      now,
      () => 0,
    );
    expectAlwaysBanner(result, { tag: null, mainText: 'No tag', subText: null });
  });

  it('makes the active banner unavailable when mainText is empty', () => {
    const result = selectBannerState(
      {
        banner_enabled: true,
        banner_title: 'New',
        banner_maintext: '',
        banner_fallback_enabled: true,
        banner_fallback_list: [{ enabled: true, banner_maintext: 'Fallback' }],
      },
      '0.14.0',
      now,
      () => 0,
    );
    expectAlwaysBanner(result, { tag: null, mainText: 'Fallback', subText: null });
  });

  it('treats missing subtext as null', () => {
    const result = selectBannerState(
      {
        banner_enabled: true,
        banner_maintext: 'Main only',
      },
      '0.14.0',
      now,
      () => 0,
    );
    expectAlwaysBanner(result, { tag: null, mainText: 'Main only', subText: null });
  });

  it('treats empty time fields as always valid', () => {
    const result = selectBannerState(
      {
        banner_enabled: true,
        banner_maintext: 'Always on',
        banner_start_time: '',
        banner_end_time: null,
      },
      '0.14.0',
      now,
      () => 0,
    );
    expectAlwaysBanner(result, { tag: null, mainText: 'Always on', subText: null });
  });

  it('falls back to UTC when timestamps have no timezone', () => {
    const result = selectBannerState(
      {
        banner_enabled: true,
        banner_maintext: 'UTC fallback',
        banner_start_time: '2026-06-15T04:00:00',
        banner_end_time: '2026-06-15T20:00:00',
      },
      '0.14.0',
      now,
      () => 0,
    );
    expectAlwaysBanner(result, { tag: null, mainText: 'UTC fallback', subText: null });
  });

  it('returns null when the fallback list is empty', () => {
    const result = selectBannerState(
      {
        banner_enabled: false,
        banner_fallback_enabled: true,
        banner_fallback_list: [],
      },
      '0.14.0',
      now,
      () => 0,
    );
    expect(result).toBeNull();
  });

  it('returns null when the fallback list is missing', () => {
    const result = selectBannerState(
      {
        banner_enabled: false,
        banner_fallback_enabled: true,
      },
      '0.14.0',
      now,
      () => 0,
    );
    expect(result).toBeNull();
  });

  it('uses banner_id as the banner key when present', () => {
    const result = selectBannerState(
      {
        banner_enabled: true,
        banner_id: 'active-1',
        banner_maintext: 'Active',
      },
      '0.14.0',
      now,
      () => 0,
    );
    expect(result).toMatchObject({ key: 'active-1', display: 'always' });
  });

  it('generates a stable hash key when banner_id is missing', () => {
    const json = {
      banner_enabled: true,
      banner_title: 'New',
      banner_maintext: 'Active',
      banner_subtext: 'Details',
    };

    const first = selectBannerState(json, '0.14.0', now, () => 0);
    const second = selectBannerState(json, '0.14.0', now, () => 0);
    const changedDisplay = selectBannerState(
      {
        ...json,
        banner_display: 'cooldown',
        banner_display_ttl_hours: 72,
      },
      '0.14.0',
      now,
      () => 0,
    );

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(changedDisplay).not.toBeNull();
    expect(first!.key).toMatch(/^[0-9a-f]{32}$/);
    expect(second!.key).toBe(first!.key);
    expect(changedDisplay!.key).not.toBe(first!.key);
  });

  it('parses cooldown display and ttl hours', () => {
    const result = selectBannerState(
      {
        banner_enabled: true,
        banner_id: 'active-1',
        banner_maintext: 'Active',
        banner_display: 'cooldown',
        banner_display_ttl_hours: 72,
      },
      '0.14.0',
      now,
      () => 0,
    );
    expect(result).toMatchObject({
      key: 'active-1',
      display: 'cooldown',
      ttlHours: 72,
    });
  });

  it('falls back to 24 hours when cooldown ttl is invalid', () => {
    const result = selectBannerState(
      {
        banner_enabled: true,
        banner_id: 'active-1',
        banner_maintext: 'Active',
        banner_display: 'cooldown',
        banner_display_ttl_hours: 0,
      },
      '0.14.0',
      now,
      () => 0,
    );
    expect(result).toMatchObject({ display: 'cooldown', ttlHours: 24 });
  });

  it('falls back to always for unknown display values', () => {
    const result = selectBannerState(
      {
        banner_enabled: true,
        banner_id: 'active-1',
        banner_maintext: 'Active',
        banner_display: '24h',
      },
      '0.14.0',
      now,
      () => 0,
    );
    expect(result).toMatchObject({ display: 'always' });
    expect(result?.ttlHours).toBeUndefined();
  });

  it('supports fallback display and ttl fields', () => {
    const result = selectBannerState(
      {
        banner_enabled: false,
        banner_fallback_enabled: true,
        banner_fallback_list: [
          {
            enabled: true,
            banner_id: 'fallback-1',
            banner_maintext: 'Fallback',
            banner_display: 'cooldown',
            banner_display_ttl_hours: 168,
          },
        ],
      },
      '0.14.0',
      now,
      () => 0,
    );
    expect(result).toMatchObject({
      key: 'fallback-1',
      display: 'cooldown',
      ttlHours: 168,
    });
  });
});

describe('shouldDisplayBanner', () => {
  const now = new Date('2026-06-16T12:00:00.000Z');

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
        now,
      ),
    ).toBe(true);
  });

  it('returns true for once banners without a shown record', () => {
    expect(shouldDisplayBanner({ ...banner, key: 'once', display: 'once' }, { version: 1, shown: {} }, now)).toBe(
      true,
    );
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
        now,
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
        now,
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
        now,
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
        now,
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
        now,
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
        now,
      ),
    ).toBe(false);
  });
});

describe('selectDisplayableBanner', () => {
  const now = new Date('2026-06-16T12:00:00.000Z');

  it('falls back when the active once banner was already shown', () => {
    const result = selectDisplayableBanner({
      json: {
        banner_enabled: true,
        banner_id: 'active',
        banner_maintext: 'Active',
        banner_display: 'once',
        banner_fallback_enabled: true,
        banner_fallback_list: [
          {
            enabled: true,
            banner_id: 'fallback',
            banner_maintext: 'Fallback',
            banner_display: 'once',
          },
        ],
      },
      clientVersion: '0.14.0',
      now,
      random: () => 0,
      state: {
        version: 1,
        shown: {
          active: { lastShownAt: '2026-06-16T00:00:00.000Z' },
        },
      },
    });

    expect(result).toMatchObject({ key: 'fallback', display: 'once' });
  });

  it('falls back when active cooldown is within ttl', () => {
    const result = selectDisplayableBanner({
      json: {
        banner_enabled: true,
        banner_id: 'active',
        banner_maintext: 'Active',
        banner_display: 'cooldown',
        banner_display_ttl_hours: 1,
        banner_fallback_enabled: true,
        banner_fallback_list: [
          {
            enabled: true,
            banner_id: 'fallback',
            banner_maintext: 'Fallback',
          },
        ],
      },
      clientVersion: '0.14.0',
      now,
      random: () => 0,
      state: {
        version: 1,
        shown: {
          active: { lastShownAt: '2026-06-16T11:30:00.000Z' },
        },
      },
    });

    expect(result).toMatchObject({ key: 'fallback', display: 'always' });
  });

  it('returns active cooldown after ttl instead of fallback', () => {
    const result = selectDisplayableBanner({
      json: {
        banner_enabled: true,
        banner_id: 'active',
        banner_maintext: 'Active',
        banner_display: 'cooldown',
        banner_display_ttl_hours: 24,
        banner_fallback_enabled: true,
        banner_fallback_list: [
          {
            enabled: true,
            banner_id: 'fallback',
            banner_maintext: 'Fallback',
          },
        ],
      },
      clientVersion: '0.14.0',
      now,
      random: () => 0,
      state: {
        version: 1,
        shown: {
          active: { lastShownAt: '2026-06-15T12:00:00.000Z' },
        },
      },
    });

    expect(result).toMatchObject({ key: 'active', display: 'cooldown', ttlHours: 24 });
  });

  it('randomly chooses only displayable fallback candidates', () => {
    const result = selectDisplayableBanner({
      json: {
        banner_enabled: false,
        banner_fallback_enabled: true,
        banner_fallback_list: [
          {
            enabled: true,
            banner_id: 'fallback-once',
            banner_maintext: 'Fallback once',
            banner_display: 'once',
          },
          {
            enabled: true,
            banner_id: 'fallback-always',
            banner_maintext: 'Fallback always',
          },
        ],
      },
      clientVersion: '0.14.0',
      now,
      random: () => 0,
      state: {
        version: 1,
        shown: {
          'fallback-once': { lastShownAt: '2026-06-16T00:00:00.000Z' },
        },
      },
    });

    expect(result).toMatchObject({ key: 'fallback-always', display: 'always' });
  });
});
