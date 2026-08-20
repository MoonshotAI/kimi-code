import { describe, expect, it, vi } from 'vitest';
import { getUpgradeUrl, openUpgrade, resolveUpgradeRegion, setUpgradeRegion, setUpgradeRegionProbe } from '../src/lib/upgrade';

describe('resolveUpgradeRegion', () => {
  it('stores the probed region in the upgrade link', async () => {
    setUpgradeRegion('mainland-cn');
    await resolveUpgradeRegion(async () => 'global');
    expect(getUpgradeUrl()).toContain('https://www.kimi.ai/code');
    await resolveUpgradeRegion(async () => 'mainland-cn');
    expect(getUpgradeUrl()).toContain('https://www.kimi.com/code');
  });

  it('defers a superseded probe call to the newest outcome before returning', async () => {
    setUpgradeRegion('mainland-cn');
    let releaseFirst!: (region: 'global') => void;
    const first = resolveUpgradeRegion(
      () => new Promise<'global'>((resolve) => { releaseFirst = resolve; }),
    );
    // A second, newer probe answers 'global' first and wins the write.
    await resolveUpgradeRegion(async () => 'global');

    // The superseded call must not resolve while the cache is still
    // pre-refresh — it waits for the newest probe instead, so an openUpgrade
    // queued behind it never navigates with the old region.
    releaseFirst('global');
    await first;
    expect(getUpgradeUrl()).toContain('https://www.kimi.ai/code');
    setUpgradeRegion('mainland-cn');
  });

  it('a chain of overlapping probes lands on the true newest outcome', async () => {
    setUpgradeRegion('mainland-cn');
    let releaseFirst!: (region: 'global') => void;
    let releaseSecond!: (region: 'mainland-cn') => void;
    const first = resolveUpgradeRegion(
      () => new Promise<'global'>((resolve) => { releaseFirst = resolve; }),
    );
    const second = resolveUpgradeRegion(
      () => new Promise<'mainland-cn'>((resolve) => { releaseSecond = resolve; }),
    );
    const third = resolveUpgradeRegion(async () => 'global');
    await third;

    // The middle probe's write is suppressed by the third; both superseded
    // calls must defer through to the true newest outcome.
    releaseSecond('mainland-cn');
    releaseFirst('global');
    await Promise.all([first, second]);
    expect(getUpgradeUrl()).toContain('https://www.kimi.ai/code');
    setUpgradeRegion('mainland-cn');
  });

  it('lets only the newest overlapping probe write the cache', async () => {
    setUpgradeRegion('mainland-cn');
    // Older probe hangs until released; the newer one answers first.
    let releaseStale!: (region: 'mainland-cn') => void;
    const stale = resolveUpgradeRegion(
      () => new Promise<'mainland-cn'>((resolve) => { releaseStale = resolve; }),
    );
    await resolveUpgradeRegion(async () => 'global');
    expect(getUpgradeUrl()).toContain('https://www.kimi.ai/code');

    releaseStale('mainland-cn');
    await stale;
    // The stale answer must not resurrect the previous region.
    expect(getUpgradeUrl()).toContain('https://www.kimi.ai/code');
  });

  it('keeps the cached region when the probe answers null (older daemon)', async () => {
    setUpgradeRegion('mainland-cn');
    await resolveUpgradeRegion(async () => 'global');
    await resolveUpgradeRegion(async () => null);
    expect(getUpgradeUrl()).toContain('https://www.kimi.ai/code');
    setUpgradeRegion('mainland-cn');
  });

  it('openUpgrade falls back to the cached region when the probe hangs past the bound', async () => {
    vi.useFakeTimers();
    setUpgradeRegion('mainland-cn');
    const placeholder = { location: { href: '' }, closed: false };
    const originalWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      open: () => placeholder,
    };
    try {
      // A half-dead daemon: the probe never resolves. The placeholder must
      // not stay blank until the API client's generic timeout — it navigates
      // with the cached region after the interaction-level bound.
      setUpgradeRegionProbe(() => new Promise<null>(() => {}));
      openUpgrade();
      expect(placeholder.location.href).toBe('');
      await vi.advanceTimersByTimeAsync(5_000);
      expect(placeholder.location.href).toContain('https://www.kimi.com/code');
    } finally {
      setUpgradeRegionProbe(null);
      (globalThis as { window?: unknown }).window = originalWindow;
      setUpgradeRegion('mainland-cn');
      vi.useRealTimers();
    }
  });

  it('openUpgrade opens the placeholder in-gesture and navigates after the probe', async () => {
    setUpgradeRegion('mainland-cn');
    const opened: string[] = [];
    const placeholder = { location: { href: '' }, closed: false };
    const originalWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      open: (url: string) => { opened.push(url); return placeholder; },
    };
    try {
      setUpgradeRegionProbe(async () => 'global');
      openUpgrade();
      // The placeholder opens synchronously inside the gesture (popup-blocker
      // safe), and is navigated only once the fresh region resolves.
      expect(opened).toEqual(['']);
      expect(placeholder.location.href).toBe('');
      await new Promise((resolve) => setImmediate(resolve));
      expect(placeholder.location.href).toContain('https://www.kimi.ai/code');
    } finally {
      setUpgradeRegionProbe(null);
      (globalThis as { window?: unknown }).window = originalWindow;
      setUpgradeRegion('mainland-cn');
    }
  });
});
