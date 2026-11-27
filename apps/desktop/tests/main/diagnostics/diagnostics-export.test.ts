import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readdir, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import yauzl from 'yauzl';

const mocks = vi.hoisted(() => ({
  paths: { downloads: '', temp: '' },
  showMessageBox: vi.fn(async (..._args: unknown[]) => ({ response: 1, checkboxChecked: false })),
  showItemInFolder: vi.fn(),
  openPath: vi.fn(async (_path: string) => ''),
  collectDiagnosticsSnapshot: vi.fn(async () => ({ generatedAt: 'now', page: { appChildren: 0 } })),
  mainWindow: null as unknown,
  showMainWindow: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { getPath: (name: 'downloads' | 'temp') => mocks.paths[name], getLocale: () => 'en-US', getVersion: () => '1.2.3' },
  dialog: { showMessageBox: mocks.showMessageBox, showErrorBox: vi.fn() },
  shell: { showItemInFolder: mocks.showItemInFolder, openPath: mocks.openPath },
}));
vi.mock('../../../src/main/diagnostics/collector', () => ({ collectDiagnosticsSnapshot: mocks.collectDiagnosticsSnapshot }));
vi.mock('../../../src/main/window/window-registry', () => ({ getMainWindow: () => mocks.mainWindow }));
vi.mock('../../../src/main/window/main-window', () => ({ showMainWindow: mocks.showMainWindow }));

import {
  collectDiagnosticsEntries,
  collectFeedbackDiagnosticsArchive,
  diagnosticsFileName,
  exportDiagnostics,
  openLogsFolder,
  writeDiagnosticsZip,
} from '../../../src/main/diagnostics/diagnostics-export';
import { addDiagnosticRoot } from '../../../src/main/diagnostics/log';

const DAY_MS = 86_400_000;

async function put(path: string, content: string, ageDays = 0): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content);
  if (ageDays > 0) {
    const when = new Date(Date.now() - ageDays * DAY_MS);
    await utimes(path, when, when);
  }
}

function readZip(path: string): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    const contents = new Map<string, string>();
    yauzl.open(path, { lazyEntries: true }, (openError, zip) => {
      if (openError !== null || zip === undefined) {
        reject(openError ?? new Error('no zip'));
        return;
      }
      zip.on('error', reject);
      zip.on('end', () => resolve(contents));
      zip.on('entry', (entry: yauzl.Entry) => {
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError !== null || stream === undefined) {
            reject(streamError ?? new Error('no stream'));
            return;
          }
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.on('end', () => {
            contents.set(entry.fileName, Buffer.concat(chunks).toString('utf-8'));
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

async function seedHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'kimi-export-home-'));
  const logs = join(home, 'logs');
  await put(join(logs, 'kimi-code-desktop.log'), 'desktop current\n');
  await put(join(logs, 'kimi-code-desktop.log.1'), 'desktop rotated\n');
  await put(join(logs, 'kimi-code.log'), 'core current\n');
  await put(join(logs, 'kimi-code.log.2'), 'core rotated\n');
  await put(join(logs, 'feedback-upload.log'), 'unrelated\n');
  await put(join(logs, 'desktop-launch-stable.json'), '{"stage":"ui-ready"}');
  await put(join(logs, 'desktop-incidents', 'white-screen.json'), '{"kind":"not-mounted"}');
  await put(join(logs, 'desktop-crashes', 'stable', 'completed', 'recent.dmp'), 'MDMP recent');
  await put(join(logs, 'desktop-crashes', 'stable', 'completed', 'ancient.dmp'), 'MDMP ancient', 45);
  return home;
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.paths.downloads = await mkdtemp(join(tmpdir(), 'kimi-export-downloads-'));
  mocks.paths.temp = await mkdtemp(join(tmpdir(), 'kimi-export-temp-'));
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('collectDiagnosticsEntries', () => {
  it('picks desktop and core logs, incidents and recent crash dumps only', async () => {
    const home = await seedHome();
    const entries = await collectDiagnosticsEntries([join(home, 'logs')]);
    expect(entries.map((entry) => entry.name)).toEqual([
      'logs/desktop-launch-stable.json',
      'logs/kimi-code-desktop.log',
      'logs/kimi-code-desktop.log.1',
      'logs/kimi-code.log',
      'logs/kimi-code.log.2',
      'incidents/white-screen.json',
      'crashes/stable/completed/recent.dmp',
    ]);
  });

  it('prefixes extra log folders and skips duplicates', async () => {
    const first = await seedHome();
    const second = await mkdtemp(join(tmpdir(), 'kimi-export-other-'));
    await put(join(second, 'kimi-code-desktop.log'), 'before re-target\n');
    const entries = await collectDiagnosticsEntries([join(first, 'logs'), second, join(first, 'logs')]);
    expect(entries.at(-1)?.name).toBe('extra-1/logs/kimi-code-desktop.log');
    expect(entries.filter((entry) => entry.name === 'logs/kimi-code-desktop.log')).toHaveLength(1);
  });
});

describe('writeDiagnosticsZip', () => {
  it('writes copies of the files plus the snapshot and skips files that vanished', async () => {
    const home = await seedHome();
    const scratch = await mkdtemp(join(tmpdir(), 'kimi-export-scratch-'));
    const target = join(mocks.paths.downloads, 'out.zip');
    const result = await writeDiagnosticsZip(
      target,
      [
        { source: join(home, 'logs', 'kimi-code-desktop.log'), name: 'logs/kimi-code-desktop.log' },
        { source: join(home, 'logs', 'missing.log'), name: 'logs/missing.log' },
      ],
      { generatedAt: 'now' },
      scratch,
    );
    expect(result.files).toBe(1);
    const zip = await readZip(target);
    expect([...zip.keys()]).toEqual(['logs/kimi-code-desktop.log', 'diagnostics.json']);
    expect(zip.get('logs/kimi-code-desktop.log')).toBe('desktop current\n');
    expect(JSON.parse(zip.get('diagnostics.json') ?? '')).toEqual({ generatedAt: 'now' });
  });
});

describe('diagnosticsFileName', () => {
  it('stamps the archive with the local time', () => {
    expect(diagnosticsFileName(new Date(2026, 9, 29, 8, 5, 9))).toBe('kimi-code-diagnostics-20261029-080509.zip');
  });
});

it('collects only the selected feedback diagnostic scope and cleans the temporary archive', async () => {
  const home = await seedHome();
  vi.stubEnv('KIMI_CODE_HOME', home);
  const logs = join(home, 'logs');
  await symlink(join(logs, 'feedback-upload.log'), join(logs, 'kimi-code.log.3'), 'file');
  await mkdir(join(logs, 'kimi-code.log.4'));

  const archive = await collectFeedbackDiagnosticsArchive();
  expect(await readdir(mocks.paths.temp)).toEqual([]);
  const path = join(mocks.paths.downloads, archive.fileName);
  await writeFile(path, new Uint8Array(archive.bytes));
  const zip = await readZip(path);

  expect([...zip.keys()]).toEqual([
    'logs/kimi-code-desktop.log', 'logs/kimi-code-desktop.log.1', 'logs/kimi-code.log', 'logs/kimi-code.log.2', 'diagnostics.json',
  ]);
  expect(JSON.parse(zip.get('diagnostics.json') ?? '')).toMatchObject({ version: '1.2.3', platform: process.platform });
});

it('omits logs when the feedback log directory is a symbolic link', async () => {
  const home = await mkdtemp(join(tmpdir(), 'kimi-export-home-'));
  const source = join(home, 'sample-logs');
  await put(join(source, 'kimi-code.log'), 'local sample');
  await symlink(source, join(home, 'logs'), 'junction');
  vi.stubEnv('KIMI_CODE_HOME', home);

  const archive = await collectFeedbackDiagnosticsArchive();
  const path = join(mocks.paths.downloads, archive.fileName);
  await writeFile(path, new Uint8Array(archive.bytes));
  expect([...(await readZip(path)).keys()]).toEqual(['diagnostics.json']);
});

describe('exportDiagnostics', () => {
  it('writes the archive to Downloads, cleans up its scratch copies and offers to reveal it', async () => {
    const home = await seedHome();
    vi.stubEnv('KIMI_CODE_HOME', home);
    mocks.showMessageBox.mockResolvedValueOnce({ response: 0, checkboxChecked: false });

    await exportDiagnostics('zh');

    const [archive] = await readdir(mocks.paths.downloads);
    expect(archive).toMatch(/^kimi-code-diagnostics-\d{8}-\d{6}\.zip$/);
    const zip = await readZip(join(mocks.paths.downloads, archive!));
    expect(zip.get('logs/kimi-code.log')).toBe('core current\n');
    expect(zip.get('crashes/stable/completed/recent.dmp')).toBe('MDMP recent');
    expect(JSON.parse(zip.get('diagnostics.json') ?? '')).toEqual({ generatedAt: 'now', page: { appChildren: 0 } });
    expect(await readdir(mocks.paths.temp)).toEqual([]);
    const options = mocks.showMessageBox.mock.calls[0]?.[0] as { message: string; detail: string };
    expect(options.message).toBe('诊断信息已导出');
    expect(options.detail).toContain(archive);
    expect(mocks.showItemInFolder).toHaveBeenCalledWith(join(mocks.paths.downloads, archive!));
  });

  it('points at the logs folder when the archive cannot be written', async () => {
    const home = await seedHome();
    vi.stubEnv('KIMI_CODE_HOME', home);
    mocks.paths.downloads = join(home, 'no', 'such', 'folder');
    mocks.showMessageBox.mockResolvedValueOnce({ response: 0, checkboxChecked: false });

    await exportDiagnostics('en');

    const options = mocks.showMessageBox.mock.calls[0]?.[0] as { type: string; message: string; detail: string };
    expect(options.type).toBe('warning');
    expect(options.message).toBe('Could not export diagnostics');
    expect(options.detail).toContain(join(home, 'logs'));
    expect(mocks.openPath).toHaveBeenCalledWith(join(home, 'logs'));
  });

  it('lists every diagnostic folder in the failure dialog once there is more than one', async () => {
    const home = await seedHome();
    const startupLogs = await mkdtemp(join(tmpdir(), 'kimi-export-startup-'));
    vi.stubEnv('KIMI_CODE_HOME', home);
    addDiagnosticRoot(startupLogs);
    mocks.paths.downloads = join(home, 'missing');

    await exportDiagnostics('zh');

    const options = mocks.showMessageBox.mock.calls[0]?.[0] as { detail: string };
    expect(options.detail).toContain(`也可以直接把下面这些文件夹压缩后发给我们：\n${join(home, 'logs')}\n${startupLogs}`);
  });

  it('attaches the result dialog to the main window so the main process keeps running', async () => {
    const home = await seedHome();
    vi.stubEnv('KIMI_CODE_HOME', home);
    const win = { isDestroyed: () => false };
    mocks.mainWindow = win;
    try {
      await exportDiagnostics('en');
    } finally {
      mocks.mainWindow = null;
    }
    expect(mocks.showMainWindow).toHaveBeenCalledOnce();
    expect(mocks.showMessageBox).toHaveBeenCalledWith(win, expect.objectContaining({ message: 'Diagnostics exported' }));
  });

  it('ignores a second request while an export is running', async () => {
    const home = await seedHome();
    vi.stubEnv('KIMI_CODE_HOME', home);
    await Promise.all([exportDiagnostics('en'), exportDiagnostics('en')]);
    expect(mocks.collectDiagnosticsSnapshot).toHaveBeenCalledOnce();
    expect(await readdir(mocks.paths.downloads)).toHaveLength(1);
  });
});

describe('openLogsFolder', () => {
  it('creates and opens the fixed logs folder', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kimi-export-empty-'));
    vi.stubEnv('KIMI_CODE_HOME', home);
    await openLogsFolder();
    expect(mocks.openPath).toHaveBeenCalledWith(join(home, 'logs'));
    expect(await readdir(home)).toEqual(['logs']);
  });
});
