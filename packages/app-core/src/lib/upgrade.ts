
import { isDesktop } from './desktopFlag';
import type { OAuthRegion } from '../api/types';

let cachedRegion: OAuthRegion | null = null;

export function setUpgradeRegion(region: OAuthRegion | null): void {
  if (region !== null) cachedRegion = region;
}

let refreshSeq = 0;

let latestProbe: { seq: number; promise: Promise<void> } | null = null;

export async function resolveUpgradeRegion(probe: () => Promise<OAuthRegion | null>): Promise<void> {
  const seq = ++refreshSeq;
  const run = (async (): Promise<void> => {
    const region = await probe();
    if (seq === refreshSeq) setUpgradeRegion(region);
  })();
  const wrapped = (async (): Promise<void> => {
    await run;
    if (latestProbe !== null && latestProbe.seq > seq) {
      await latestProbe.promise;
    }
  })();
  latestProbe = { seq, promise: wrapped };
  return wrapped;
}

let regionProbe: (() => Promise<OAuthRegion | null>) | null = null;

export function setUpgradeRegionProbe(probe: (() => Promise<OAuthRegion | null>) | null): void {
  regionProbe = probe;
}

const PROBE_TIMEOUT_MS = 5_000;

function probeWithTimeout(probe: () => Promise<OAuthRegion | null>): Promise<OAuthRegion | null> {
  return Promise.race([
    probe(),
    new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), PROBE_TIMEOUT_MS);
    }),
  ]);
}

export function getUpgradeUrl(): string {
  const siteBase = cachedRegion === 'global' ? 'https://www.kimi.ai' : 'https://www.kimi.com';
  return `${siteBase}/code?from=${isDesktop ? 'kimi_code_desktop' : 'kimi_code_web'}`;
}

export function openUpgrade(): void {
  const registered = regionProbe;
  if (registered === null) {
    window.open(getUpgradeUrl(), '_blank', 'noopener');
    return;
  }
  const probe = (): Promise<OAuthRegion | null> => probeWithTimeout(registered);
  if (isDesktop) {
    void resolveUpgradeRegion(probe).then(() => {
      window.open(getUpgradeUrl(), '_blank', 'noopener');
    });
    return;
  }
  const placeholder = window.open('', '_blank');
  if (placeholder === null) {
    window.open(getUpgradeUrl(), '_blank', 'noopener');
    return;
  }
  try { placeholder.opener = null; } catch {}
  void resolveUpgradeRegion(probe).then(() => {
    try {
      placeholder.location.href = getUpgradeUrl();
    } catch {}
  });
}
