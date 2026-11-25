import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const DAEMON_SETTINGS_FILE = 'daemon-settings.json';

interface DaemonSettingsDisk {
  remote_control_enabled?: boolean;
}

export function daemonSettingsPath(homeDir: string): string {
  return join(homeDir, 'server', DAEMON_SETTINGS_FILE);
}

export async function readDaemonRemoteControlPreference(homeDir: string): Promise<boolean> {
  try {
    const raw = await readFile(daemonSettingsPath(homeDir), 'utf8');
    const parsed = JSON.parse(raw) as Partial<DaemonSettingsDisk>;
    return parsed.remote_control_enabled === true;
  } catch {
    return false;
  }
}

export async function writeDaemonRemoteControlPreference(
  homeDir: string,
  enabled: boolean,
): Promise<void> {
  const filePath = daemonSettingsPath(homeDir);
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => {});
  let existing: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    }
  } catch {
  }
  const next = JSON.stringify({ ...existing, remote_control_enabled: enabled }, null, 2);
  const tmpPath = `${filePath}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  let renamed = false;
  try {
    const fh = await open(tmpPath, 'w', 0o600);
    try {
      await fh.writeFile(`${next}\n`);
    } finally {
      await fh.close();
    }
    await rename(tmpPath, filePath);
    renamed = true;
  } finally {
    if (!renamed) {
      await unlink(tmpPath).catch(() => {});
    }
  }
}
