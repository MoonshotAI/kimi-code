import { readApiErrorDetails } from './api-error';
import { parseKimiCodeCustomHeaders } from './identity';
import { kimiCodeBaseUrl } from './managed-usage';
import { parseManagedUserInfoPayload } from './managed-userinfo';
import { isRecord } from './utils';

export function kimiCodeWorkspacesUrl(): string {
  return `${kimiCodeBaseUrl()}/workspaces`;
}

export type WorkspaceTarget =
  | { readonly kind: 'personal' }
  | { readonly kind: 'business'; readonly businessId: string };

export type ManagedWorkspace =
  | {
      readonly kind: 'personal';
      readonly key: 'personal';
      readonly target: { readonly kind: 'personal' };
      readonly name: string;
      readonly kindLabel: 'Personal workspace';
      readonly current: boolean;
      readonly disabled: false;
      readonly switchable: true;
      readonly roles: readonly string[];
    }
  | {
      readonly kind: 'business';
      readonly key: `business:${string}`;
      readonly target: { readonly kind: 'business'; readonly businessId: string };
      readonly businessId: string;
      readonly name: string;
      readonly status: string;
      readonly kindLabel: 'Business workspace';
      readonly current: boolean;
      readonly disabled: boolean;
      readonly switchable: boolean;
      readonly nickname?: string;
      readonly roles: readonly string[];
    };

export interface ManagedAccountProfile {
  readonly userId: string;
  readonly nickname: string;
  readonly avatar?: string;
  readonly userLevelName: string;
  readonly workspaceName?: string;
  readonly workspaces: readonly ManagedWorkspace[];
  readonly hasBusinessWorkspace: boolean;
  readonly activeWorkspaceName: string;
  readonly statusWorkspaceLine?: string;
  readonly planLabel?: string;
}

export interface FetchManagedWorkspacesOk {
  readonly kind: 'ok';
  readonly workspaces: readonly ManagedWorkspace[];
}

export interface FetchManagedWorkspacesError {
  readonly kind: 'error';
  readonly status?: number;
  readonly errorCode?: string;
  readonly message: string;
}

export type ManagedWorkspacesResult = FetchManagedWorkspacesOk | FetchManagedWorkspacesError;

export interface FetchManagedAccountProfileOk {
  readonly kind: 'ok';
  readonly profile: ManagedAccountProfile;
}

export type ManagedAccountProfileResult =
  | FetchManagedAccountProfileOk
  | FetchManagedWorkspacesError;

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parseRoles(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

export function parseManagedWorkspacesPayload(
  payload: unknown,
  fallbackNickname = '',
): ManagedWorkspace[] | null {
  if (!isRecord(payload) || !Array.isArray(payload['workspaces'])) return null;

  const out: ManagedWorkspace[] = [];
  const seenBusinessIds = new Set<string>();
  let seenPersonal = false;
  let currentCount = 0;

  for (const rawEntry of payload['workspaces']) {
    if (!isRecord(rawEntry)) return null;
    const rawBusiness = rawEntry['business'];
    const rawType = rawEntry['type'];
    const rawUser = isRecord(rawEntry['user']) ? rawEntry['user'] : undefined;
    const entryNickname = nonEmptyString(rawUser?.['nickname']);
    const current = rawEntry['current'] === true;
    if (current) currentCount += 1;
    if (currentCount > 1) return null;

    const roles = parseRoles(rawEntry['roles']);
    const isBusiness = rawType === 'business' || isRecord(rawBusiness);
    const isPersonal =
      rawType === 'personal' || (!isBusiness && (rawBusiness === null || rawBusiness === undefined));

    if (isBusiness) {
      if (!isRecord(rawBusiness)) return null;
      const businessId = nonEmptyString(rawBusiness['id']);
      const name = nonEmptyString(rawBusiness['name']);
      if (businessId === undefined || name === undefined) return null;
      if (seenBusinessIds.has(businessId)) return null;
      seenBusinessIds.add(businessId);
      const status = nonEmptyString(rawBusiness['status']) ?? 'STATUS_ACTIVE';
      const disabled = status === 'STATUS_DISABLED';
      out.push({
        kind: 'business',
        key: `business:${businessId}`,
        target: { kind: 'business', businessId },
        businessId,
        name,
        status,
        kindLabel: 'Business workspace',
        current,
        disabled,
        switchable: !disabled,
        ...(entryNickname !== undefined ? { nickname: entryNickname } : {}),
        roles,
      });
      continue;
    }

    if (isPersonal) {
      if (seenPersonal) return null;
      seenPersonal = true;
      out.push({
        kind: 'personal',
        key: 'personal',
        target: { kind: 'personal' },
        name: entryNickname ?? (fallbackNickname.length > 0 ? fallbackNickname : 'Personal'),
        kindLabel: 'Personal workspace',
        current,
        disabled: false,
        switchable: true,
        roles,
      });
      continue;
    }

    return null;
  }

  return out;
}

export function buildManagedAccountProfile(
  mePayload: unknown,
  workspaces: readonly ManagedWorkspace[],
): ManagedAccountProfile | null {
  const me = parseManagedUserInfoPayload(mePayload);
  if (me === null) return null;
  const workspaceName = isRecord(mePayload)
    ? nonEmptyString(mePayload['workspace_name'])
    : undefined;

  const normalizedWorkspaces = workspaces.map((entry) =>
    entry.kind === 'personal' && entry.name === 'Personal' && me.nickname.length > 0
      ? { ...entry, name: me.nickname }
      : entry,
  );
  const hasBusinessWorkspace = normalizedWorkspaces.some((entry) => entry.kind === 'business');
  const currentEntry = normalizedWorkspaces.find((entry) => entry.current);

  let activeWorkspaceName: string;
  if (currentEntry?.kind === 'business') {
    activeWorkspaceName = workspaceName ?? currentEntry.name;
  } else if (currentEntry?.kind === 'personal') {
    activeWorkspaceName = 'Personal workspace';
  } else if (workspaceName !== undefined) {
    activeWorkspaceName = workspaceName;
  } else {
    activeWorkspaceName = 'Personal workspace';
  }

  const trimmedPlan = me.userLevelName.trim();
  const statusWorkspaceLine = hasBusinessWorkspace
    ? me.nickname.length > 0
      ? `${me.nickname} · ${activeWorkspaceName}`
      : activeWorkspaceName
    : undefined;
  const planLabel = hasBusinessWorkspace && trimmedPlan.length > 0 ? trimmedPlan : undefined;

  return {
    userId: me.userId,
    nickname: me.nickname,
    ...(me.avatar !== undefined ? { avatar: me.avatar } : {}),
    userLevelName: me.userLevelName,
    ...(workspaceName !== undefined ? { workspaceName } : {}),
    workspaces: normalizedWorkspaces,
    hasBusinessWorkspace,
    activeWorkspaceName,
    ...(statusWorkspaceLine !== undefined ? { statusWorkspaceLine } : {}),
    ...(planLabel !== undefined ? { planLabel } : {}),
  };
}

export interface ManagedEndpointFetchOptions {
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly headers?: Record<string, string>;
}

async function fetchManagedJson(
  url: string,
  accessToken: string,
  resourceLabel: string,
  opts: ManagedEndpointFetchOptions = {},
): Promise<{ readonly kind: 'ok'; readonly payload: unknown } | FetchManagedWorkspacesError> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, opts.timeoutMs ?? 8000);
  try {
    const res = await fetchImpl(url, {
      headers: {
        ...parseKimiCodeCustomHeaders(),
        ...opts.headers,
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      const status = res.status;
      const fallback =
        status === 401
          ? 'Authorization failed. Please check your API key (try /login).'
          : `Failed to fetch ${resourceLabel}: HTTP ${String(status)}`;
      const details = await readApiErrorDetails(res, fallback);
      return {
        kind: 'error',
        status,
        ...(details.code !== undefined ? { errorCode: details.code } : {}),
        message: details.message,
      };
    }
    const json: unknown = await res.json();
    return { kind: 'ok', payload: json };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { kind: 'error', message: `Failed to fetch ${resourceLabel}: request timed out.` };
    }
    const msg = error instanceof Error ? error.message : String(error);
    return { kind: 'error', message: `Failed to fetch ${resourceLabel}: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchManagedWorkspaces(
  url: string,
  accessToken: string,
  opts: ManagedEndpointFetchOptions = {},
): Promise<ManagedWorkspacesResult> {
  const response = await fetchManagedJson(url, accessToken, 'workspaces', opts);
  if (response.kind === 'error') return response;
  const workspaces = parseManagedWorkspacesPayload(response.payload);
  if (workspaces === null) {
    return { kind: 'error', message: 'Failed to fetch workspaces: malformed response.' };
  }
  return { kind: 'ok', workspaces };
}

export async function fetchManagedAccountProfile(
  options: ManagedEndpointFetchOptions & {
    readonly userInfoUrl: string;
    readonly workspacesUrl: string;
    readonly accessToken: string;
  },
): Promise<ManagedAccountProfileResult> {
  const fetchOpts: ManagedEndpointFetchOptions = {
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.headers !== undefined ? { headers: options.headers } : {}),
  };
  const [meRes, wsRes] = await Promise.all([
    fetchManagedJson(options.userInfoUrl, options.accessToken, 'profile', fetchOpts),
    fetchManagedJson(options.workspacesUrl, options.accessToken, 'workspaces', fetchOpts),
  ]);

  if (meRes.kind === 'error' && meRes.errorCode !== undefined) return meRes;
  if (wsRes.kind === 'error' && wsRes.errorCode !== undefined) return wsRes;
  if (meRes.kind === 'error') return meRes;
  if (wsRes.kind === 'error') return wsRes;

  const workspaces = parseManagedWorkspacesPayload(wsRes.payload);
  if (workspaces === null) {
    return { kind: 'error', message: 'Failed to fetch workspaces: malformed response.' };
  }
  const profile = buildManagedAccountProfile(meRes.payload, workspaces);
  if (profile === null) {
    return { kind: 'error', message: 'Failed to fetch profile: malformed response.' };
  }
  return { kind: 'ok', profile };
}
