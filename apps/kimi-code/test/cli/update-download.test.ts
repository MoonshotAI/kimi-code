import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDownloadProgress, runUpdateDownloadCommand } from '#/cli/sub/update-download';

const mocks = vi.hoisted(() => ({
  detectNativeInstall: vi.fn(() => true),
  tryAcquireUpdateInstallLock: vi.fn(),
  readUpdateInstallLockVersion: vi.fn(),
  stageNativeUpdate: vi.fn(),
  readStagedNativeUpdate: vi.fn(),
  promoteStagedUpdateToManual: vi.fn(async () => true),
  hashFileSha256: vi.fn(),
  stagedExePath: vi.fn(() => '/tmp/staged-exe'),
}));

vi.mock('#/cli/update/source', () => ({
  detectNativeInstall: mocks.detectNativeInstall,
}));

vi.mock('#/cli/update/install-lock', () => ({
  tryAcquireUpdateInstallLock: mocks.tryAcquireUpdateInstallLock,
  readUpdateInstallLockVersion: mocks.readUpdateInstallLockVersion,
}));

vi.mock('#/cli/update/native-stage', () => ({
  stageNativeUpdate: mocks.stageNativeUpdate,
  readStagedNativeUpdate: mocks.readStagedNativeUpdate,
  promoteStagedUpdateToManual: mocks.promoteStagedUpdateToManual,
  hashFileSha256: mocks.hashFileSha256,
  stagedExePath: mocks.stagedExePath,
}));

vi.mock('@moonshot-ai/kimi-code-sdk', async () => {
  const actual = await vi.importActual<typeof import('@moonshot-ai/kimi-code-sdk')>(
    '@moonshot-ai/kimi-code-sdk',
  );
  return {
    ...actual,
    log: { ...actual.log, warn: vi.fn() },
  };
});

function fakeOut(isTTY: boolean): { readonly out: NodeJS.WriteStream; readonly chunks: string[] } {
  const chunks: string[] = [];
  const out = {
    isTTY,
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  return { out, chunks };
}

describe('createDownloadProgress', () => {
  it('renders a throttled in-place line on a TTY, with the final frame always shown', () => {
    const { out, chunks } = fakeOut(true);
    const progress = createDownloadProgress(out, 'Downloading…');
    const total = 100 * 1024 * 1024;

    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1_000);
    progress(10 * 1024 * 1024, total);
    nowSpy.mockReturnValue(1_050); // inside the 100 ms throttle window → skipped
    progress(20 * 1024 * 1024, total);
    nowSpy.mockReturnValue(1_200);
    progress(30 * 1024 * 1024, total);
    progress(total, total); // final frame is never throttled

    expect(chunks).toEqual([
      '\r\u001B[KDownloading… 10% (10/100 MB)',
      '\r\u001B[KDownloading… 30% (30/100 MB)',
      '\r\u001B[KDownloading… 100% (100/100 MB)',
    ]);
    nowSpy.mockRestore();
  });

  it('prints the label up front and one line per 32 MB when piped', () => {
    const { out, chunks } = fakeOut(false);
    const progress = createDownloadProgress(out, 'Downloading…');
    const total = 100 * 1024 * 1024;

    progress(10 * 1024 * 1024, total); // below the 32 MB line interval → skipped
    progress(40 * 1024 * 1024, total);
    progress(total, total);

    expect(chunks).toEqual([
      'Downloading…\n',
      'Downloading… 40% (40/100 MB)\n',
      'Downloading… 100% (100/100 MB)\n',
    ]);
  });

  it('degrades to plain MB counts when Content-Length is unknown', () => {
    const { out, chunks } = fakeOut(true);
    const progress = createDownloadProgress(out, 'Downloading…');
    progress(5 * 1024 * 1024, null);
    expect(chunks).toEqual(['\r\u001B[KDownloading… 5 MB']);
  });
});

describe('runUpdateDownloadCommand', () => {
  const STAGED_HASH = 'a'.repeat(64);

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.detectNativeInstall.mockReturnValue(true);
    mocks.tryAcquireUpdateInstallLock.mockResolvedValue({
      filePath: '/tmp/install.lock',
      release: vi.fn(async () => {}),
    });
    mocks.stageNativeUpdate.mockResolvedValue({ status: 'staged', staged: {} });
    mocks.hashFileSha256.mockResolvedValue(STAGED_HASH);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refuses on non-native installs', async () => {
    mocks.detectNativeInstall.mockReturnValue(false);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(runUpdateDownloadCommand('0.7.0')).resolves.toBe(1);
    expect(mocks.stageNativeUpdate).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('native build'));
  });

  it('waits for and adopts the result when another instance downloads the same version', async () => {
    mocks.tryAcquireUpdateInstallLock.mockResolvedValue(null);
    mocks.readUpdateInstallLockVersion.mockResolvedValue('0.7.0');
    // The other worker's staged update is verified on disk on the first poll.
    mocks.readStagedNativeUpdate.mockResolvedValue({ version: '0.7.0', sha256: STAGED_HASH });
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await expect(runUpdateDownloadCommand('0.7.0')).resolves.toBe(0);
    expect(mocks.stageNativeUpdate).not.toHaveBeenCalled();
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('already in progress'));
    // A background waiter's adoption keeps the auto marker.
    expect(mocks.promoteStagedUpdateToManual).not.toHaveBeenCalled();
  });

  it('promotes the adopted stage to manual when an explicit upgrade waited for it', async () => {
    mocks.tryAcquireUpdateInstallLock.mockResolvedValue(null);
    mocks.readUpdateInstallLockVersion.mockResolvedValue('0.7.0');
    mocks.readStagedNativeUpdate.mockResolvedValue({ version: '0.7.0', sha256: STAGED_HASH });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await expect(runUpdateDownloadCommand('0.7.0', true)).resolves.toBe(0);
    expect(mocks.stageNativeUpdate).not.toHaveBeenCalled();
    expect(mocks.promoteStagedUpdateToManual).toHaveBeenCalledTimes(1);
  });

  it('keeps waiting until the manual promotion is confirmed persisted', async () => {
    // The first promotion attempt loses a race with a concurrent swap's
    // claim/restore cycle; the loop must not report adoption until the
    // marker is confirmed.
    mocks.tryAcquireUpdateInstallLock.mockResolvedValue(null);
    mocks.readUpdateInstallLockVersion.mockResolvedValue('0.7.0');
    mocks.readStagedNativeUpdate.mockResolvedValue({ version: '0.7.0', sha256: STAGED_HASH });
    mocks.promoteStagedUpdateToManual
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await expect(runUpdateDownloadCommand('0.7.0', true)).resolves.toBe(0);
    expect(mocks.stageNativeUpdate).not.toHaveBeenCalled();
    expect(mocks.promoteStagedUpdateToManual).toHaveBeenCalledTimes(2);
  });

  it('waits instead of adopting when the recorded payload fails the checksum', async () => {
    mocks.tryAcquireUpdateInstallLock.mockResolvedValue(null);
    mocks.readUpdateInstallLockVersion.mockResolvedValue('0.7.0');
    mocks.readStagedNativeUpdate.mockResolvedValue({ version: '0.7.0', sha256: STAGED_HASH });
    // First poll: the recorded payload is corrupt (the holder is re-staging
    // it — its metadata is only replaced when the repaired generation
    // publishes); second poll: the repaired generation verifies.
    mocks.hashFileSha256.mockResolvedValueOnce('corrupt').mockResolvedValue(STAGED_HASH);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await expect(runUpdateDownloadCommand('0.7.0')).resolves.toBe(0);
    expect(mocks.stageNativeUpdate).not.toHaveBeenCalled();
    expect(mocks.hashFileSha256).toHaveBeenCalledTimes(2);
  });

  it('takes over when the holder dies leaving a corrupt stage behind', async () => {
    const release = vi.fn(async () => {});
    mocks.tryAcquireUpdateInstallLock
      .mockResolvedValueOnce(null) // initial acquire: held
      .mockResolvedValue({ filePath: '/tmp/install.lock', release }); // in-loop takeover
    mocks.readUpdateInstallLockVersion.mockResolvedValueOnce('0.7.0');
    mocks.readStagedNativeUpdate.mockResolvedValue({ version: '0.7.0', sha256: STAGED_HASH });
    // The recorded payload never verifies: the lock poll takes over and
    // stageNativeUpdate's own adoption check re-stages it.
    mocks.hashFileSha256.mockResolvedValue('corrupt');
    await expect(runUpdateDownloadCommand('0.7.0')).resolves.toBe(0);
    expect(mocks.stageNativeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ version: '0.7.0' }),
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('takes over when the same-version holder finishes without staging', async () => {
    const release = vi.fn(async () => {});
    mocks.tryAcquireUpdateInstallLock
      .mockResolvedValueOnce(null) // held by the other worker…
      .mockResolvedValueOnce({ filePath: '/tmp/install.lock', release }); // …won inside the wait loop
    mocks.readUpdateInstallLockVersion.mockResolvedValueOnce('0.7.0'); // the initial holder check
    mocks.readStagedNativeUpdate.mockResolvedValue(null);
    await expect(runUpdateDownloadCommand('0.7.0')).resolves.toBe(0);
    expect(mocks.stageNativeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ version: '0.7.0' }),
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('fails instead of a false success when the lock holder stages another version', async () => {
    mocks.tryAcquireUpdateInstallLock.mockResolvedValue(null);
    mocks.readUpdateInstallLockVersion.mockResolvedValue('0.8.0');
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(runUpdateDownloadCommand('0.7.0')).resolves.toBe(1);
    expect(mocks.stageNativeUpdate).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('0.8.0'));
  });

  it('retries the acquire when the lock vanished between the two reads', async () => {
    const release = vi.fn(async () => {});
    mocks.tryAcquireUpdateInstallLock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ filePath: '/tmp/install.lock', release });
    mocks.readUpdateInstallLockVersion.mockResolvedValue(undefined);
    await expect(runUpdateDownloadCommand('0.7.0')).resolves.toBe(0);
    expect(mocks.stageNativeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ version: '0.7.0' }),
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('stages against the running exe and releases the lock', async () => {
    const release = vi.fn(async () => {});
    mocks.tryAcquireUpdateInstallLock.mockResolvedValue({ filePath: '/tmp/install.lock', release });
    await expect(runUpdateDownloadCommand('0.7.0')).resolves.toBe(0);
    expect(mocks.stageNativeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ version: '0.7.0', exePath: process.execPath }),
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('marks the stage as manual when the download answers an explicit upgrade', async () => {
    mocks.tryAcquireUpdateInstallLock.mockResolvedValue({
      filePath: '/tmp/install.lock',
      release: vi.fn(async () => {}),
    });
    await expect(runUpdateDownloadCommand('0.7.0', true)).resolves.toBe(0);
    expect(mocks.stageNativeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ version: '0.7.0', manual: true }),
    );
  });

  it('reports staging failures with a non-zero exit code', async () => {
    mocks.stageNativeUpdate.mockRejectedValue(new Error('sha256 mismatch'));
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(runUpdateDownloadCommand('0.7.0')).resolves.toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('sha256 mismatch'));
  });
});
