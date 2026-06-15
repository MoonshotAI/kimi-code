import { describe, expect, it } from 'vitest';

import { selectBannerState } from '#/tui/banner/banner-provider';

describe('selectBannerState', () => {
  const now = new Date('2026-06-15T12:00:00+08:00');

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
    expect(result).toEqual({ tag: 'New', mainText: 'Active', subText: 'Details' });
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
    expect(result).toEqual({ tag: 'Tip', mainText: 'Second', subText: null });
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
    expect(result).toEqual({ tag: null, mainText: 'Old tip', subText: null });
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
    expect(result).toEqual({ tag: null, mainText: 'Fallback', subText: null });
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
    expect(result).toEqual({ tag: null, mainText: 'No tag', subText: null });
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
    expect(result).toEqual({ tag: null, mainText: 'Fallback', subText: null });
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
    expect(result).toEqual({ tag: null, mainText: 'Main only', subText: null });
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
    expect(result).toEqual({ tag: null, mainText: 'Always on', subText: null });
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
    expect(result).toEqual({ tag: null, mainText: 'UTC fallback', subText: null });
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
});
