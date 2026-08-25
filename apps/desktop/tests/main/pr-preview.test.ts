import { describe, it, expect, vi, beforeEach } from 'vitest';

const { appMock } = vi.hoisted(() => ({
  appMock: {
    isPackaged: false,
    getVersion: vi.fn(() => '0.0.20'),
    getAppPath: vi.fn(() => '/repo'),
    getPath: vi.fn(() => '/tmp/userdata'),
  },
}));

// pr-preview.ts pulls in connect.ts / shell-env.ts only for the preview
// wiring; the gate + target helpers under test never reach them.
vi.mock('electron', () => ({ app: appMock }));
vi.mock('../../src/main/connect', () => ({ setPreviewDistRoot: vi.fn() }));
vi.mock('../../src/main/shell-env', () => ({ startShellEnvProbe: vi.fn().mockResolvedValue(undefined) }));

import { isPrPreviewAvailable, isValidPreviewRef, previewTargetLabel } from '../../src/main/pr-preview';

beforeEach(() => {
  appMock.isPackaged = false;
  appMock.getVersion.mockReturnValue('0.0.20');
});

describe('isPrPreviewAvailable', () => {
  it('is available in dev (unpackaged) builds regardless of channel', () => {
    appMock.isPackaged = false;
    expect(isPrPreviewAvailable()).toBe(true);
  });

  it('is available on Kimi Code Canary builds', () => {
    appMock.isPackaged = true;
    appMock.getVersion.mockReturnValue('0.0.20-canary.3');
    expect(isPrPreviewAvailable()).toBe(true);
  });

  it('is unavailable on stable packaged builds (release or alpha)', () => {
    appMock.isPackaged = true;
    appMock.getVersion.mockReturnValue('0.0.20');
    expect(isPrPreviewAvailable()).toBe(false);
    appMock.getVersion.mockReturnValue('0.0.21-alpha.2');
    expect(isPrPreviewAvailable()).toBe(false);
  });
});

describe('isValidPreviewRef', () => {
  it('accepts branches, tags and shas', () => {
    expect(isValidPreviewRef('main')).toBe(true);
    expect(isValidPreviewRef('feat/pr-preview-canary')).toBe(true);
    expect(isValidPreviewRef('v0.0.20-canary.3')).toBe(true);
    expect(isValidPreviewRef('1d59fe12b8bbe916ea41fa90ea474c127f09d24a')).toBe(true);
    expect(isValidPreviewRef('fix_a-thing.x')).toBe(true);
  });

  it('rejects shell-ish or git-protocol junk', () => {
    expect(isValidPreviewRef('')).toBe(false);
    expect(isValidPreviewRef('bad ref')).toBe(false);
    expect(isValidPreviewRef('-m')).toBe(false);
    expect(isValidPreviewRef('--upload-pack=x')).toBe(false);
    expect(isValidPreviewRef('a..b')).toBe(false);
    expect(isValidPreviewRef('refs/heads/main;rm -rf /')).toBe(false);
    expect(isValidPreviewRef('a'.repeat(201))).toBe(false);
  });
});

describe('previewTargetLabel', () => {
  it('labels PRs with # and refs verbatim', () => {
    expect(previewTargetLabel({ kind: 'pr', pr: 306 })).toBe('#306');
    expect(previewTargetLabel({ kind: 'ref', ref: 'feat-x'})).toBe('feat-x');
  });
});
