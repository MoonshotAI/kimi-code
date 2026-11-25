const STRIPPED_PREFIXES = ['KIMI_'];

const STRIPPED_KEYS = new Set([
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_ORG_ID',
  'OPENAI_PROJECT_ID',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_GENAI_USE_VERTEXAI',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  'MOONSHOT_API_KEY',
  'MOONSHOT_BASE_URL',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_PROFILE',
  'AWS_REGION',
  'AWS_BEARER_TOKEN_BEDROCK',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
]);

export const UNIT_TEST_SWITCHES: Readonly<Record<string, string>> = {
  KIMI_CODE_SEARCH_WORKER: 'false',
  KIMI_CODE_PERSISTENCE_MINIDB_READMODEL: 'false',
};

export const TEST_ENV_DEFAULTS: Readonly<Record<string, string>> = {
  KIMI_DISABLE_TELEMETRY: '1',
  ...UNIT_TEST_SWITCHES,
  KIMI_CODE_MODEL_CATALOG_REFRESH_ON_START: '0',
  KIMI_CODE_MODEL_CATALOG_REFRESH_INTERVAL_MS: '0',
};

export interface TestEnvOptions {
  readonly base?: NodeJS.ProcessEnv;
  readonly keep?: readonly string[];
  readonly set?: Readonly<Record<string, string | undefined>>;
}

export function testEnv(options: TestEnvOptions = {}): Record<string, string> {
  const keep = new Set(options.keep);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.base ?? process.env)) {
    if (value === undefined) continue;
    if (!keep.has(key) && isStripped(key)) continue;
    env[key] = value;
  }
  Object.assign(env, TEST_ENV_DEFAULTS);
  for (const [key, value] of Object.entries(options.set ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

export function isolateProcessEnv(options: Omit<TestEnvOptions, 'base'> = {}): () => void {
  const snapshot = { ...process.env };
  const isolated = testEnv({ ...options, base: snapshot });
  replaceProcessEnv(isolated);
  return () => replaceProcessEnv(snapshot);
}

function isStripped(key: string): boolean {
  return STRIPPED_KEYS.has(key) || STRIPPED_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function replaceProcessEnv(next: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in next)) Reflect.deleteProperty(process.env, key);
  }
  for (const [key, value] of Object.entries(next)) {
    if (value !== undefined) process.env[key] = value;
  }
}
