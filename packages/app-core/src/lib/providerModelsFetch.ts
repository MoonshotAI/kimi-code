
export interface FetchedProviderModel {
  id: string;
  ownedBy?: string;
  displayName?: string;
  maxContextSize?: number;
  capabilities?: string[];
  supportEfforts?: string[];
}

export type FetchModelsErrorKind =
  | 'auth'
  | 'notFound'
  | 'network'
  | 'timeout'
  | 'parse'
  | 'http';

export type FetchProviderModelsResult =
  | { ok: true; models: FetchedProviderModel[] }
  | { ok: false; kind: FetchModelsErrorKind; status?: number; detail?: string };

export type ModelsFetchImpl = (req: {
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
}) => Promise<{ status: number; body: string }>;

export const FETCH_MODELS_TIMEOUT_MS = 15000;

const KNOWN_COMPAT_SUFFIXES = [
  '/api/claudecode',
  '/api/anthropic',
  '/apps/anthropic',
  '/api/coding',
  '/claudecode',
  '/anthropic',
  '/step_plan',
  '/coding',
  '/claude',
] as const;

function endsWithVersionSegment(url: string): boolean {
  const last = url.slice(url.lastIndexOf('/') + 1);
  return /^v\d+$/.test(last);
}

function stripCompatSuffix(baseUrl: string): string | null {
  for (const suffix of KNOWN_COMPAT_SUFFIXES) {
    if (baseUrl.endsWith(suffix)) return baseUrl.slice(0, baseUrl.length - suffix.length);
  }
  return null;
}

export function buildModelsUrlCandidates(baseUrl: string, type: string): string[] {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (trimmed === '' || type === 'vertexai') return [];
  if (type === 'google-genai') return [`${trimmed}/v1beta/models`];

  const candidates: string[] = [];
  if (endsWithVersionSegment(trimmed)) {
    candidates.push(`${trimmed}/models`);
    if (!trimmed.endsWith('/v1')) candidates.push(`${trimmed}/v1/models`);
  } else {
    candidates.push(`${trimmed}/v1/models`);
  }

  const stripped = stripCompatSuffix(trimmed);
  if (stripped !== null) {
    const root = stripped.replace(/\/+$/, '');
    if (root !== '' && root.includes('://')) {
      candidates.push(`${root}/v1/models`);
      candidates.push(`${root}/models`);
    }
  }

  return [...new Set(candidates)];
}

export function buildModelsRequestHeaders(
  type: string,
  apiKey: string,
): Record<string, string> {
  const key = apiKey.trim();
  if (type === 'anthropic') {
    return {
      ...(key === '' ? {} : { 'x-api-key': key }),
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    };
  }
  if (type === 'google-genai') {
    return key === '' ? {} : { 'x-goog-api-key': key };
  }
  return key === '' ? {} : { authorization: `Bearer ${key}` };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  return items.length > 0 ? items : undefined;
}

function parsePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function firstBoolean(...values: unknown[]): boolean | undefined {
  return values.find((value): value is boolean => typeof value === 'boolean');
}

function capabilitiesFromEntry(record: Record<string, unknown>): string[] | undefined {
  const rawModalities = record['modalities'];
  const rawCapabilities = record['capabilities'];
  const rawReasoning = record['reasoning'];
  const rawTools = record['tools'];
  if (
    !isRecord(rawModalities) &&
    !isRecord(rawCapabilities) &&
    !isRecord(rawReasoning) &&
    typeof rawReasoning !== 'boolean' &&
    !isRecord(rawTools) &&
    !isRecord(record['think_efforts']) &&
    typeof record['tool_call'] !== 'boolean' &&
    typeof record['supports_tool_use'] !== 'boolean' &&
    typeof record['supports_image_in'] !== 'boolean' &&
    typeof record['supports_video_in'] !== 'boolean' &&
    typeof record['supports_reasoning'] !== 'boolean' &&
    typeof record['supports_thinking_type'] !== 'string' &&
    typeof record['dynamically_loaded_tools'] !== 'boolean'
  ) {
    return undefined;
  }

  const modalities = isRecord(rawModalities) ? rawModalities : undefined;
  const nested = isRecord(rawCapabilities) ? rawCapabilities : undefined;
  const reasoning = isRecord(rawReasoning) ? rawReasoning : undefined;
  const tools = isRecord(rawTools) ? rawTools : undefined;
  const inputModalities =
    parseStringList(modalities?.['input']) ?? parseStringList(nested?.['input_modalities']);
  const reasoningType = reasoning?.['type'];
  const flatThinkingType = record['supports_thinking_type'];
  const thinkingType =
    reasoningType === 'only' || reasoningType === 'both' || reasoningType === 'none'
      ? reasoningType
      : flatThinkingType === 'only' || flatThinkingType === 'both' || flatThinkingType === 'no'
        ? flatThinkingType
        : undefined;
  const supportsReasoning =
    thinkingType === 'none' || thinkingType === 'no'
      ? false
      : (firstBoolean(
          rawReasoning,
          reasoning?.['support'],
          nested?.['reasoning'],
          record['supports_reasoning'],
        ) ?? false);
  const toolUse =
    firstBoolean(
      record['tool_call'],
      tools?.['support'],
      nested?.['tool_call'],
      record['supports_tool_use'],
    ) ?? true;
  const supportsImageIn =
    inputModalities !== undefined
      ? inputModalities.includes('image')
      : record['supports_image_in'] === true;
  const supportsVideoIn =
    inputModalities !== undefined
      ? inputModalities.includes('video')
      : record['supports_video_in'] === true;

  const caps = new Set<string>();
  if (thinkingType === 'only') {
    caps.add('thinking');
    caps.add('always_thinking');
  } else if (thinkingType === 'both' || supportsReasoning) {
    caps.add('thinking');
  }
  if (supportsImageIn) caps.add('image_in');
  if (supportsVideoIn) caps.add('video_in');
  if (inputModalities?.includes('audio') === true) caps.add('audio_in');
  if (toolUse) caps.add('tool_use');
  if (tools?.['dynamic_load'] === true || record['dynamically_loaded_tools'] === true) {
    caps.add('dynamically_loaded_tools');
  }
  return [...caps];
}

function supportEffortsFromEntry(record: Record<string, unknown>): string[] | undefined {
  const rawReasoning = record['reasoning'];
  const reasoning = isRecord(rawReasoning) ? rawReasoning : undefined;
  const rawEffort = reasoning?.['effort'];
  const effort = isRecord(rawEffort) ? rawEffort : undefined;
  const rawThinkEfforts = record['think_efforts'];
  const thinkEfforts = isRecord(rawThinkEfforts) ? rawThinkEfforts : undefined;
  const rawCapabilities = record['capabilities'];
  const nested = isRecord(rawCapabilities) ? rawCapabilities : undefined;
  return (
    parseStringList(effort?.['valid']) ??
    (thinkEfforts?.['support'] === true
      ? parseStringList(thinkEfforts['valid_efforts'])
      : undefined) ??
    parseStringList(nested?.['support_efforts']) ??
    parseStringList(record['support_efforts'])
  );
}

function modelFromEntry(entry: unknown): FetchedProviderModel | null {
  if (!isRecord(entry)) return null;
  const raw = entry['slug'] ?? entry['id'] ?? entry['name'];
  if (typeof raw !== 'string') return null;
  const stripped = raw.startsWith('models/') ? raw.slice('models/'.length) : raw;
  const id = stripped.trim();
  if (id === '') return null;

  const ownedBy = entry['owned_by'];
  const rawDisplayName = entry['display_name'];
  const displayName =
    typeof rawDisplayName === 'string' && rawDisplayName.trim() !== '' ? rawDisplayName : undefined;
  const rawLimit = entry['limit'];
  const limit = isRecord(rawLimit) ? rawLimit : undefined;
  const maxContextSize =
    parsePositiveInteger(limit?.['context']) ??
    parsePositiveInteger(entry['context_length']) ??
    parsePositiveInteger(entry['context_tokens']);
  const capabilities = capabilitiesFromEntry(entry);
  const supportEfforts = supportEffortsFromEntry(entry);

  return {
    id,
    ...(typeof ownedBy === 'string' ? { ownedBy } : {}),
    ...(displayName !== undefined ? { displayName } : {}),
    ...(maxContextSize !== undefined ? { maxContextSize } : {}),
    ...(capabilities !== undefined ? { capabilities } : {}),
    ...(supportEfforts !== undefined ? { supportEfforts } : {}),
  };
}

export function parseModelsResponseBody(body: string): FetchedProviderModel[] | null {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  if (json === null || typeof json !== 'object') return null;
  const record = json as Record<string, unknown>;
  const entries = Array.isArray(record['data'])
    ? record['data']
    : Array.isArray(record['models'])
      ? record['models']
      : null;
  if (entries === null) return null;
  const models: FetchedProviderModel[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const parsed = modelFromEntry(entry);
    if (parsed === null || seen.has(parsed.id)) continue;
    seen.add(parsed.id);
    models.push(parsed);
  }
  return models.sort((a, b) => a.id.localeCompare(b.id));
}

interface ProviderModelsFetchBridge {
  fetchProviderModels: (req: {
    url: string;
    headers: Record<string, string>;
    timeoutMs: number;
  }) => Promise<
    { ok: true; status: number; body: string } | { ok: false; kind: 'timeout' | 'network' } | null
  >;
}

function desktopBridgeImpl(): ModelsFetchImpl | undefined {
  if (typeof window === 'undefined') return undefined;
  const bridge = (window as { kimiDesktop?: ProviderModelsFetchBridge }).kimiDesktop;
  if (typeof bridge?.fetchProviderModels !== 'function') return undefined;
  const fetchProviderModels = bridge.fetchProviderModels.bind(bridge);
  return async (req) => {
    const res = await fetchProviderModels(req);
    if (res !== null && res.ok) return { status: res.status, body: res.body };
    if (res !== null && res.kind === 'timeout') {
      throw new DOMException('desktop bridge fetch timed out', 'TimeoutError');
    }
    throw new Error('desktop bridge fetch failed');
  };
}

export function createWebModelsFetchImpl(): ModelsFetchImpl {
  return async ({ url, headers, timeoutMs }) => {
    const res = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: res.status, body: await res.text() };
  };
}

export function defaultModelsFetchImpl(): ModelsFetchImpl {
  return desktopBridgeImpl() ?? createWebModelsFetchImpl();
}

function isTimeoutError(err: unknown): boolean {
  if (err === null || typeof err !== 'object' || !('name' in err)) return false;
  const name = (err as { name: unknown }).name;
  return name === 'TimeoutError' || name === 'AbortError';
}

export async function fetchProviderModels(input: {
  type: string;
  baseUrl: string;
  apiKey: string;
  impl?: ModelsFetchImpl;
  timeoutMs?: number;
}): Promise<FetchProviderModelsResult> {
  const candidates = buildModelsUrlCandidates(input.baseUrl, input.type);
  if (candidates.length === 0) return { ok: false, kind: 'notFound' };
  const headers = buildModelsRequestHeaders(input.type, input.apiKey);
  const impl = input.impl ?? defaultModelsFetchImpl();
  const timeoutMs = input.timeoutMs ?? FETCH_MODELS_TIMEOUT_MS;

  for (const url of candidates) {
    let res: { status: number; body: string };
    try {
      res = await impl({ url, headers, timeoutMs });
    } catch (err) {
      return {
        ok: false,
        kind: isTimeoutError(err) ? 'timeout' : 'network',
        detail: err instanceof Error ? err.message : String(err),
      };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, kind: 'auth', status: res.status };
    }
    if (res.status === 404 || res.status === 405) continue;
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, kind: 'http', status: res.status, detail: res.body.slice(0, 512) };
    }
    const models = parseModelsResponseBody(res.body);
    if (models === null) return { ok: false, kind: 'parse' };
    return { ok: true, models };
  }
  return { ok: false, kind: 'notFound' };
}
