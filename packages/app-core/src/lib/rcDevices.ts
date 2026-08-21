// packages/app-core/src/lib/rcDevices.ts
//
// Remote-control (rc) device switching. An rc session is entered through a
// relay URL of the shape
//
//   /devices/<deviceId>/?rc=1&from=<source>
//
// The relay owns routing API traffic to the device; the SPA only needs to
// (a) know the current device id for the switcher UI, and (b) keep the rc
// query params alive across in-site navigation so a refresh stays in rc
// mode. Switching devices is a full-page navigation to deviceUrl() — state
// does not carry over, so nothing else needs to know the device changed.
//
// Everything here is web-rc-only: desktop never sees rc params or /devices
// paths, so all helpers are no-ops there. This module is pure: the relay
// fetch lives in apps/web/src/lib/rcDevicesApi.ts.

const DEVICE_PATH_PREFIX = '/devices/';

/** sessionStorage key remembering the current device id. In-site navigation
    rewrites the path to /sessions/<id> etc., so after the initial landing on
    /devices/<id>/ the id only survives here (and a device switch overwrites
    it on the fresh page load). */
const RC_DEVICE_STORAGE_KEY = 'kimi-rc-device-id';

/** True when the location carries the rc-mode marker (`?rc=1`). */
export function isRcLocation(loc: Pick<Location, 'search'>): boolean {
  return new URLSearchParams(loc.search).get('rc') === '1';
}

/** Parse the device id out of a `/devices/<id>/…` location: the id is the
    first path segment after /devices/. Deeper paths are the norm, not the
    exception — the relay prefixes every in-site navigation (e.g.
    /devices/<id>/sessions/<sid>). Returns undefined when there is no id
    segment or it is undecodable (never throws). */
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

/** Strip a leading `/devices/<id>/` relay prefix from a pathname so the
    session/admin route parsers (which only know the bare shapes) work under
    rc. `/devices/<id>` with nothing after it maps to '/'; anything without a
    device prefix is returned unchanged. */
export function stripRcDevicePrefix(pathname: string): string {
  if (readDeviceIdFromLocation({ pathname }) === undefined) return pathname;
  const rest = pathname.slice(DEVICE_PATH_PREFIX.length);
  const slash = rest.indexOf('/');
  return slash < 0 ? '/' : rest.slice(slash);
}

/** Build the canonical device-switch path ('/devices/<id>/'). */
export function deviceUrl(deviceId: string): string {
  return `${DEVICE_PATH_PREFIX}${encodeURIComponent(deviceId)}/`;
}

/** Append the rc params (`rc`, `from`) found in `search` to a query-less
    path, preserving their values. Returns the path unchanged when neither
    param is present — the common case outside rc mode. */
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

/** The current rc device id: from the path when on a /devices/<id>/ page,
    otherwise the stored one. A path hit is persisted for later navigations. */
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
  } catch {
    // sessionStorage unavailable — the switcher just falls back to the path
  }
}
