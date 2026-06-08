/**
 * rg-locator — hybrid ripgrep binary resolution.
 *
 * Lookup order (first hit wins):
 *   1. System PATH (`which rg`) — fastest, respects developer setup
 *   2. Bundled vendor binary (hook; not wired yet — `getVendorRgPath` is a stub)
 *   3. `<KIMI_CODE_HOME>/bin/rg` — persistent cache for this app.
 *   4. CDN download to <KIMI_CODE_HOME>/bin/ — one-off bootstrap
 *
 * If steps 1-4 all fail, callers receive a structured error they can
 * turn into a user-facing "install ripgrep" hint instead of the naked
 * `spawn rg ENOENT`.
 */

import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'pathe';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { extract as extractTar } from 'tar';
import { type Entry, fromBuffer as yauzlFromBuffer } from 'yauzl';

import { abortable } from '../../utils/abort';

const RG_VERSION = '15.0.0';
const RG_BASE_URL = 'https://code.kimi.com/kimi-code/rg';
const DOWNLOAD_TIMEOUT_MS = 600_000;
const RG_ARCHIVE_SHA256: Record<string, string> = {
  'ripgrep-15.0.0-aarch64-apple-darwin.tar.gz':
    '98bb2e61e7277ba0ea72d2ae2592497fd8d2940934a16b122448d302a6637e3b',
  'ripgrep-15.0.0-aarch64-pc-windows-msvc.zip':
    '572709c8770cb7f9385d725cb06d2bcd9537ec24d4dd17b1be1d65a876f8b591',
  'ripgrep-15.0.0-aarch64-unknown-linux-gnu.tar.gz':
    '15f8cc2fab12d88491c54d49f38589922a9d6a7353c29b0a0856727bcdf80754',
  'ripgrep-15.0.0-x86_64-apple-darwin.tar.gz':
    '44128c733d127ddbda461e01225a68b5f9997cfe7635242a797f645ca674a71a',
  'ripgrep-15.0.0-x86_64-pc-windows-msvc.zip':
    '21a98bf42c4da97ca543c010e764cc6dec8b9b7538d05f8d21874016385e0860',
  'ripgrep-15.0.0-x86_64-unknown-linux-musl.tar.gz':
    '253ad0fd5fef0d64cba56c70dccdacc1916d4ed70ad057cc525fcdb0c3bbd2a7',
};

export type RgResolutionSource =
  | 'system-path'
  | 'vendor'
  | 'share-bin-cached'
  | 'share-bin-downloaded';

export interface RgResolution {
  readonly path: string;
  readonly source: RgResolutionSource;
}

export interface EnsureRgPathOptions {
  readonly shareDir?: string | undefined;
  /**
   * Cancels this caller's wait. A shared bootstrap download that is already in
   * progress may continue so other callers can still use the same result.
   */
  readonly signal?: AbortSignal | undefined;
}

/**
 * Resolve the absolute path to a usable `rg` binary, downloading it
 * into `<shareDir>/bin/` if necessary. Multiple concurrent callers are
 * serialized by a module-level lock so the download happens at most
 * once per process.
 */
export async function ensureRgPath(options: EnsureRgPathOptions = {}): Promise<RgResolution> {
  options.signal?.throwIfAborted();
  const resolution = resolveRgPath(options.shareDir ?? getShareDir(), options.signal);
  return options.signal === undefined ? resolution : abortable(resolution, options.signal);
}

async function resolveRgPath(
  shareDir: string,
  signal?: AbortSignal | undefined,
): Promise<RgResolution> {
  const existing = await findExistingRg(shareDir);
  if (existing) return existing;
  signal?.throwIfAborted();
  return downloadRgWithLock(shareDir);
}

/**
 * Pure-lookup variant for test harnesses that want to assert on the
 * resolution order without triggering a real download.
 */
export async function findExistingRg(shareDir: string): Promise<RgResolution | undefined> {
  const binName = rgBinaryName();
  const systemRg = await whichRg();
  if (systemRg !== undefined) return { path: systemRg, source: 'system-path' };
  const vendorPath = getVendorRgPath(binName);
  if (vendorPath !== undefined && (await isExecutableFile(vendorPath))) {
    return { path: vendorPath, source: 'vendor' };
  }
  const cachePath = join(shareDir, 'bin', binName);
  if (await isExecutableFile(cachePath)) {
    return { path: cachePath, source: 'share-bin-cached' };
  }
  return undefined;
}

let downloadPromise: Promise<RgResolution> | undefined;
async function downloadRgWithLock(shareDir: string): Promise<RgResolution> {
  if (downloadPromise !== undefined) return downloadPromise;
  downloadPromise = (async () => {
    try {
      const existing = await findExistingRg(shareDir);
      if (existing) return existing;
      const binPath = await downloadAndInstallRg(shareDir);
      return { path: binPath, source: 'share-bin-downloaded' };
    } finally {
      downloadPromise = undefined;
    }
  })();
  return downloadPromise;
}

function rgBinaryName(): string {
  return process.platform === 'win32' ? 'rg.exe' : 'rg';
}

function getShareDir(): string {
  const override = process.env['KIMI_CODE_HOME'];
  if (override !== undefined && override !== '') return override;
  return join(homedir(), '.kimi-code');
}

function getVendorRgPath(_binName: string): string | undefined {
  return undefined;
}

async function whichRg(): Promise<string | undefined> {
  const pathEnv = process.env['PATH'] ?? '';
  const sep = process.platform === 'win32' ? ';' : ':';
  const binName = rgBinaryName();
  for (const dir of pathEnv.split(sep)) {
    if (dir === '') continue;
    const candidate = join(dir, binName);
    try {
      const st = await stat(candidate);
      if (st.isFile()) return candidate;
    } catch {
      /* not here, try next */
    }
  }
  return undefined;
}

async function isExecutableFile(p: string): Promise<boolean> {
  try {
    const st = await stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

/** @internal for tests — rust-style `<arch>-<vendor>-<os>` target triple. */
export function detectTarget(): string | undefined {
  const arch = process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : undefined;
  if (arch === undefined) return undefined;

  if (process.platform === 'darwin') return `${arch}-apple-darwin`;
  if (process.platform === 'linux') {
    return arch === 'x86_64' ? 'x86_64-unknown-linux-musl' : 'aarch64-unknown-linux-gnu';
  }
  if (process.platform === 'win32') return `${arch}-pc-windows-msvc`;
  return undefined;
}

async function downloadAndInstallRg(shareDir: string): Promise<string> {
  const target = detectTarget();
  if (target === undefined) {
    throw new Error(
      `Unsupported platform/arch for ripgrep download: ${process.platform}/${process.arch}`,
    );
  }

  // Windows ripgrep releases ship as `.zip`; macOS / Linux as `.tar.gz`.
  // The extraction branch inside the try block handles the format-specific
  // unpack; the fetch + download-to-tmp pipeline is identical.
  const isWindows = target.includes('windows');
  const archiveExt = isWindows ? 'zip' : 'tar.gz';
  const archiveName = `ripgrep-${RG_VERSION}-${target}.${archiveExt}`;
  const expectedSha256 = RG_ARCHIVE_SHA256[archiveName];
  if (expectedSha256 === undefined) {
    throw new Error(`No pinned SHA-256 is configured for ripgrep archive ${archiveName}`);
  }
  const url = `${RG_BASE_URL}/${archiveName}`;

  const binDir = join(shareDir, 'bin');
  await mkdir(binDir, { recursive: true });
  const destination = join(binDir, rgBinaryName());

  const tmp = await mkdtemp(join(tmpdir(), 'kimi-rg-'));
  try {
    const archivePath = join(tmp, archiveName);

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => {
      controller.abort();
    }, DOWNLOAD_TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timeoutHandle);
    }
    if (!resp.ok || resp.body === null) {
      throw new Error(`Failed to download ripgrep: HTTP ${String(resp.status)} ${resp.statusText}`);
    }
    const write = createWriteStream(archivePath);
    // Readable.fromWeb is typed as accepting a web ReadableStream; the
    // undici/fetch body matches that shape at runtime.
    await pipeline(Readable.fromWeb(resp.body as never), write);
    await verifyArchiveChecksum(archivePath, archiveName, expectedSha256);

    if (isWindows) {
      await extractRgFromZip(archivePath, destination);
      // Windows does not need `chmod +x`: execution is gated by the
      // `.exe` extension + NTFS ACLs, which are already correct.
    } else {
      const extractDir = join(tmp, 'extract');
      await mkdir(extractDir, { recursive: true });
      // tar.gz uses hard-coded prefix because the CDN's tar.gz layout is stable
      // and known from upstream releases; zip branch uses basename matching as
      // a looser contract so a CDN prefix change doesn't silently fall through.
      await extractTar({
        file: archivePath,
        cwd: extractDir,
        gzip: true,
        filter: (entryPath: string) => entryPath.endsWith(`/${rgBinaryName()}`),
      });
      const extracted = join(extractDir, `ripgrep-${RG_VERSION}-${target}`, rgBinaryName());
      if (!existsSync(extracted)) {
        throw new Error(
          `Ripgrep archive did not contain expected binary at ${extracted}. ` +
            'CDN content may have changed.',
        );
      }
      const installDir = await mkdtemp(join(binDir, '.rg-install-'));
      const staged = join(installDir, rgBinaryName());
      try {
        await copyFile(extracted, staged);
        await chmod(staged, 0o755);
        await rename(staged, destination);
      } finally {
        await rm(installDir, { recursive: true, force: true });
      }
    }
    return destination;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** @internal for tests — fail closed before extracting downloaded bytes. */
export async function verifyArchiveChecksum(
  archivePath: string,
  archiveName: string,
  expectedSha256: string,
): Promise<void> {
  const actualSha256 = createHash('sha256')
    .update(await readFile(archivePath))
    .digest('hex');
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      `Ripgrep archive checksum mismatch for ${archiveName}: expected ${expectedSha256}, ` +
        `got ${actualSha256}. CDN content may have changed.`,
    );
  }
}

/**
 * Read the downloaded `.zip` at `archivePath`, find the `rg.exe` entry
 * (basename match), and stream it out to `destination`. Throws with
 * the shared "CDN content may have
 * changed" sentinel when the archive holds no matching entry — same
 * failure semantics as the tar.gz path's `existsSync(extracted)` gate
 * so callers see a single actionable message.
 */
export async function extractRgFromZip(archivePath: string, destination: string): Promise<void> {
  const buf = await readFile(archivePath);
  const binName = rgBinaryName(); // 'rg.exe' on win32
  await new Promise<void>((resolve, reject) => {
    yauzlFromBuffer(buf, { lazyEntries: true }, (openErr, zipfile) => {
      if (openErr !== null || zipfile === undefined) {
        reject(new Error(`Failed to open ripgrep archive: ${openErr?.message ?? 'unknown error'}`));
        return;
      }
      let found = false;
      const onEntry = (entry: Entry): void => {
        // Match on basename (not full path) — keeps the matcher robust
        // against CDN repackaging tweaks (e.g. an unexpected
        // `ripgrep-X.Y.Z-TARGET/` prefix change).
        if (basename(entry.fileName) !== binName) {
          zipfile.readEntry();
          return;
        }
        found = true;
        zipfile.openReadStream(entry, (streamErr, stream) => {
          if (streamErr !== null) {
            reject(
              new Error(`Failed to read ${entry.fileName} from archive: ${streamErr.message}`),
            );
            zipfile.close();
            return;
          }
          const out = createWriteStream(destination);
          void (async () => {
            try {
              await pipeline(stream, out);
              zipfile.close();
              resolve();
            } catch (error) {
              zipfile.close();
              reject(error instanceof Error ? error : new Error(String(error)));
            }
          })();
        });
      };
      zipfile.on('entry', onEntry);
      zipfile.on('end', () => {
        // With lazyEntries:true, `end` fires only after readEntry() is called
        // for every central-directory entry. We stop calling readEntry() once
        // `found` becomes true, so `end` only reaches this branch on the
        // not-found path.
        if (!found) {
          reject(
            new Error(
              `Ripgrep archive did not contain expected binary '${binName}'. ` +
                'CDN content may have changed.',
            ),
          );
        }
      });
      zipfile.on('error', (err: Error) => {
        reject(err);
      });
      zipfile.readEntry();
    });
  });
}

/**
 * User-facing error message to show when `ensureRgPath` throws. Kept
 * in one place so the Grep / Glob / Bash plumbing can reuse it.
 */
export function rgUnavailableMessage(cause: unknown): string {
  const detail =
    cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : 'unknown error';
  const shareBin = join(getShareDir(), 'bin', rgBinaryName());
  return (
    `ripgrep (rg) is not available and the automatic bootstrap failed.\n` +
    `\n` +
    `Error: ${detail}\n` +
    `\n` +
    `Fix options:\n` +
    `  macOS:   brew install ripgrep\n` +
    `  Ubuntu:  sudo apt-get install ripgrep\n` +
    `  Other:   https://github.com/BurntSushi/ripgrep#installation\n` +
    `\n` +
    `Alternatively, drop a static rg binary at ${shareBin}`
  );
}
