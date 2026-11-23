import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, win32 } from 'node:path';

const WINDOWS_DAEMON_LAUNCH_SCRIPT = `
$ErrorActionPreference = 'Stop'
$command = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))
$environment = [Environment]::GetEnvironmentVariables()
$environment.Remove('SSH_AUTH_SOCK')
$entries = [string[]] @($environment.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" })
$startup = New-CimInstance -CimClass (Get-CimClass -ClassName Win32_ProcessStartup) -Property @{CreateFlags=16778240; ShowWindow=0; EnvironmentVariables=$entries} -ClientOnly
$result = Invoke-CimMethod -ClassName Win32_Process -Name Create -Arguments @{CommandLine=$command; CurrentDirectory=[Environment]::CurrentDirectory; ProcessStartupInformation=$startup}
if ($result.ReturnValue -ne 0) { throw "kimi server failed to start with CIM error $($result.ReturnValue)" }
`;

async function readValidKey(keyPath: string): Promise<Buffer | undefined> {
  const info = await lstat(keyPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (info === undefined) return undefined;
  if (!info.isFile()) throw new Error(`Invalid Windows IPC key file: ${keyPath}`);
  const key = await readFile(keyPath);
  if (key.length !== 32) throw new Error(`Invalid Windows IPC key length in ${keyPath}`);
  return key;
}

export async function loadWindowsIpcKey(homeDir: string): Promise<Buffer> {
  const serverDir = join(homeDir, 'server');
  const keyPath = join(serverDir, 'ipc.key');
  const existing = await readValidKey(keyPath);
  if (existing !== undefined) return existing;

  await mkdir(serverDir, { recursive: true, mode: 0o700 });
  if (!(await lstat(serverDir)).isDirectory()) {
    throw new Error(`Invalid Windows IPC key directory: ${serverDir}`);
  }
  const temp = join(serverDir, `ipc.key.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(temp, randomBytes(32), { flag: 'wx', mode: 0o600 });
    await copyFile(temp, keyPath, constants.COPYFILE_EXCL).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    });
  } finally {
    await rm(temp, { force: true });
  }
  const loaded = await readValidKey(keyPath);
  if (loaded === undefined) throw new Error(`Unable to load Windows IPC key from ${keyPath}`);
  return loaded;
}

export function windowsCommandLine(argv: readonly string[]): string {
  return argv
    .map((arg) => (arg.length > 0 && !/[\s"]/.test(arg) ? arg : `"${arg.replaceAll(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`))
    .join(' ');
}

export function spawnWindowsDaemon(argv: readonly string[]): Promise<void> {
  const ps = win32.join(process.env['SystemRoot'] ?? process.env['windir'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => {
    const child = execFile(
      ps,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_DAEMON_LAUNCH_SCRIPT, 'utf16le').toString('base64')],
      { timeout: 10_000, windowsHide: true, maxBuffer: 64 * 1024 },
      (error, _stdout, stderr) => {
        if (error !== null) reject(new Error(stderr.trim() || error.code?.toString() || 'PowerShell failed'));
        else resolve();
      },
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end(Buffer.from(windowsCommandLine(argv), 'utf16le').toString('base64'));
  });
}
