
const DEVICE_PATH_PREFIX = '/devices/';

const RC_DEVICE_STORAGE_KEY = 'kimi-rc-device-id';

export function isRcLocation(loc: Pick<Location, 'search'>): boolean {
  return new URLSearchParams(loc.search).get('rc') === '1';
}

export function readDeviceIdFromLocation(loc: Pick<Location, 'pathname'>): string | undefined {
  const { pathname } = loc;
  if (!pathname.startsWith(DEVICE_PATH_PREFIX)) return undefined;
  const segment = pathname.slice(DEVICE_PATH_PREFIX.length).split('/')[0]!;
  if (!segment) return undefined;
  try {
    const id = decodeURIComponent(segment);
    return id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

export function stripRcDevicePrefix(pathname: string): string {
  if (readDeviceIdFromLocation({ pathname }) === undefined) return pathname;
  const rest = pathname.slice(DEVICE_PATH_PREFIX.length);
  const slash = rest.indexOf('/');
  return slash < 0 ? '/' : rest.slice(slash);
}

export function deviceUrl(deviceId: string): string {
  return `${DEVICE_PATH_PREFIX}${encodeURIComponent(deviceId)}/`;
}

export function withRcQuery(path: string, search: string): string {
  const params = new URLSearchParams(search);
  const rc = params.get('rc');
  const from = params.get('from');
  if (rc === null && from === null) return path;
  const out = new URLSearchParams();
  if (rc !== null) out.set('rc', rc);
  if (from !== null) out.set('from', from);
  return `${path}?${out.toString()}`;
}

export function readRcDeviceId(loc: Pick<Location, 'pathname'>): string | undefined {
  const fromPath = readDeviceIdFromLocation(loc);
  if (fromPath !== undefined) {
    storeRcDeviceId(fromPath);
    return fromPath;
  }
  return readStoredRcDeviceId();
}

function readStoredRcDeviceId(): string | undefined {
  try {
    return window.sessionStorage.getItem(RC_DEVICE_STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function storeRcDeviceId(deviceId: string): void {
  try {
    window.sessionStorage.setItem(RC_DEVICE_STORAGE_KEY, deviceId);
  } catch {}
}
