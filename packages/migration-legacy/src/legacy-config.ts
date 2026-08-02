/**
 * Local copies of config validation + transformation from the retired TS
 * engine package `@moonshot-ai/agent-core` (v1).
 *
 * `packages/migration-legacy` used to import these from
 * `@moonshot-ai/agent-core` (schemas) and `@moonshot-ai/agent-core/flags/registry`
 * (`FLAG_DEFINITIONS`). The engine package is being retired, so the subset
 * used by the migrator is copied here.
 *
 * Sources (frozen — the v1 engine no longer changes, so these copies stay in
 * sync by definition):
 *   - `packages/agent-core/src/config/schema.ts` — zod schemas
 *   - `packages/agent-core/src/config/toml.ts` — `transformTomlData` + helpers
 *   - `packages/agent-core/src/session/hooks/types.ts` — `HOOK_EVENT_TYPES`
 *   - `packages/agent-core/src/agent/permission/matches-rule.ts` — the TS
 *     pattern parser backing `isValidPermissionPattern`
 *   - `packages/agent-core/src/flags/registry.ts` — `FLAG_DEFINITIONS`
 *
 * Only the exported names the migrator actually consumes are reproduced;
 * `KimiError`/`validateConfig`/write-side toml helpers are deliberately not.
 */

import { z } from 'zod';

// ════════════════════════════════════════════════════════════════════════════
// Hook event types (copied from session/hooks/types.ts)
// ════════════════════════════════════════════════════════════════════════════

export const HOOK_EVENT_TYPES = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'PermissionResult',
  'UserPromptSubmit',
  'Stop',
  'StopFailure',
  'Interrupt',
  'SessionStart',
  'SessionEnd',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'Notification',
] as const;

// ════════════════════════════════════════════════════════════════════════════
// Permission-rule pattern validation (copied from agent/permission/
// matches-rule.ts). agent-core's `parsePattern` prefers a Rust-backed parser
// and falls back to this TS parser; only the TS grammar is reproduced here —
// it is the authoritative DSL and the native path is just an optimization.
// ════════════════════════════════════════════════════════════════════════════

/**
 * Parse a permission-rule DSL pattern. Throws on malformed input (missing
 * closing paren, empty tool name). Grammar: `toolName` or `toolName(argPattern)`.
 */
function parsePermissionPattern(pattern: string): unknown {
  const trimmed = pattern.trim();
  if (trimmed.length === 0) {
    throw new Error('permission pattern: empty string');
  }

  const openIdx = trimmed.indexOf('(');
  if (openIdx === -1) {
    return { toolName: trimmed };
  }

  if (!trimmed.endsWith(')')) {
    throw new Error(`permission pattern: missing closing paren in "${pattern}"`);
  }

  const toolName = trimmed.slice(0, openIdx);
  const argPattern = trimmed.slice(openIdx + 1, -1);
  if (toolName.length === 0) {
    throw new Error(`permission pattern: empty tool name in "${pattern}"`);
  }
  if (argPattern.length === 0) {
    return { toolName };
  }
  return { toolName, argPattern };
}

function isValidPermissionPattern(pattern: string): boolean {
  try {
    parsePermissionPattern(pattern);
    return true;
  } catch {
    return false;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Config schemas (copied from config/schema.ts)
// ════════════════════════════════════════════════════════════════════════════

export const ProviderTypeSchema = z.enum([
  'anthropic',
  'openai',
  'kimi',
  'google-genai',
  'openai_responses',
  'vertexai',
  'astron',
]);

export type ProviderType = z.infer<typeof ProviderTypeSchema>;

export const OAuthRefSchema = z.object({
  storage: z.enum(['file', 'keyring']),
  key: z.string().min(1),
  oauthHost: z.string().min(1).optional(),
});

const StringRecordSchema = z.record(z.string(), z.string());

export const ProviderConfigSchema = z.object({
  type: ProviderTypeSchema,
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  defaultModel: z.string().optional(),
  oauth: OAuthRefSchema.optional(),
  env: StringRecordSchema.optional(),
  customHeaders: StringRecordSchema.optional(),
  source: z.record(z.string(), z.unknown()).optional(),
  stream: z.boolean().optional(),
  temperature: z.number().optional(),
  maxTokens: z.number().int().min(1).optional(),
  searchDisable: z.boolean().optional(),
  statefulResponses: z.boolean().optional(),
});

const ModelAliasBaseSchema = z.object({
  provider: z.string(),
  model: z.string(),
  maxContextSize: z.number().int().min(1),
  maxInputSize: z.number().int().min(1).optional(),
  maxOutputSize: z.number().int().min(1).optional(),
  capabilities: z.array(z.string()).optional(),
  displayName: z.string().optional(),
  reasoningKey: z.string().optional(),
  protocol: z.literal('anthropic').optional(),
  adaptiveThinking: z.boolean().optional(),
  supportEfforts: z.array(z.string()).optional(),
  defaultEffort: z.string().optional(),
  offEffort: z.string().optional(),
  betaApi: z.boolean().optional(),
  cacheTtl: z.enum(['5m', '1h']).optional(),
  baseUrl: z.string().optional(),
});

export const ModelAliasOverrideSchema = ModelAliasBaseSchema.omit({
  provider: true,
  model: true,
  protocol: true,
  betaApi: true,
  baseUrl: true,
}).partial();

export const ModelAliasSchema = ModelAliasBaseSchema.extend({
  overrides: ModelAliasOverrideSchema.optional(),
});

export const ThinkingConfigSchema = z.object({
  enabled: z.boolean().optional(),
  effort: z.string().optional(),
  keep: z.string().optional(),
});

export const PermissionModeSchema = z.enum(['yolo', 'manual', 'auto']);

export const PermissionRuleDecisionSchema = z.enum(['allow', 'deny', 'ask']);
export const PermissionRuleScopeSchema = z.enum([
  'turn-override',
  'session-runtime',
  'project',
  'user',
]);

export const PermissionRuleSchema = z.object({
  decision: PermissionRuleDecisionSchema,
  scope: PermissionRuleScopeSchema.default('user'),
  pattern: z.string().min(1).refine(isValidPermissionPattern, {
    message: 'Invalid permission rule pattern',
  }),
  reason: z.string().optional(),
});

export const PermissionConfigSchema = z.object({
  rules: z.array(PermissionRuleSchema).optional(),
});

export const LoopControlSchema = z.object({
  maxStepsPerTurn: z.number().int().min(0).optional(),
  maxRetriesPerStep: z.number().int().min(0).optional(),
  maxRalphIterations: z.number().int().min(-1).optional(),
  reservedContextSize: z.number().int().min(0).optional(),
  compactionTriggerRatio: z.number().min(0.5).max(0.99).optional(),
  earlyCompactionTriggerRatio: z.number().min(0.5).max(0.99).optional(),
});

export const BackgroundConfigSchema = z.object({
  maxRunningTasks: z.number().int().min(1).optional(),
  keepAliveOnExit: z.boolean().optional(),
  bashAutoBackgroundOnTimeout: z.boolean().optional(),
  bashTaskTimeoutS: z.number().int().min(0).optional(),
  killGracePeriodMs: z.number().int().min(0).optional(),
  printWaitCeilingS: z.number().int().min(1).optional(),
  printBackgroundMode: z.enum(['exit', 'drain', 'steer']).optional(),
  printMaxTurns: z.number().int().min(1).optional(),
});

export const SubagentConfigSchema = z.object({
  timeoutMs: z.number().int().min(0).optional(),
});

export const AgentConfigSchema = z.object({
  engine: z.enum(['rust']).default('rust'),
  multiLlm: z.array(z.string()).optional(),
  nativeLlmProvider: z.string().optional(),
  nativeTools: z.boolean().optional(),
});

export const MAX_MCP_TIMEOUT_MS = 2_147_483_647;
const McpTimeoutMsSchema = z.number().int().min(1).max(MAX_MCP_TIMEOUT_MS);

export const McpConfigSchema = z.object({
  startupTimeoutMs: McpTimeoutMsSchema.optional(),
  toolTimeoutMs: McpTimeoutMsSchema.optional(),
  trustProjectMcpConfig: z.boolean().optional(),
});

export const ImageConfigSchema = z.object({
  maxEdgePx: z.number().int().min(1).optional(),
  readByteBudget: z.number().int().min(1).optional(),
});

export const ModelCatalogConfigSchema = z.object({
  refreshIntervalMs: z.number().int().min(0).optional(),
  refreshOnStart: z.boolean().optional(),
});

export const ExperimentalConfigSchema = z.record(z.string(), z.union([z.boolean(), z.string()]));

export const HookDefSchema = z
  .object({
    event: z.enum(HOOK_EVENT_TYPES),
    matcher: z.string().optional(),
    command: z.string().min(1),
    timeout: z.number().int().min(1).max(600).optional(),
  })
  .strict();

export const MoonshotServiceConfigSchema = z.object({
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  oauth: OAuthRefSchema.optional(),
  customHeaders: StringRecordSchema.optional(),
});

export const ServicesConfigSchema = z.object({
  moonshotSearch: MoonshotServiceConfigSchema.optional(),
  moonshotFetch: MoonshotServiceConfigSchema.optional(),
});

const McpServerCommonFields = {
  enabled: z.boolean().optional(),
  startupTimeoutMs: McpTimeoutMsSchema.optional(),
  toolTimeoutMs: McpTimeoutMsSchema.optional(),
  enabledTools: z.array(z.string()).optional(),
  disabledTools: z.array(z.string()).optional(),
} as const;

export const McpServerStdioConfigSchema = z.object({
  transport: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: StringRecordSchema.optional(),
  cwd: z.string().optional(),
  executor: z.enum(['local', 'kaos']).optional(),
  ...McpServerCommonFields,
});

export const McpServerHttpConfigSchema = z.object({
  transport: z.literal('http'),
  url: z.string().url(),
  headers: StringRecordSchema.optional(),
  auth: z.literal('oauth').optional(),
  bearerTokenEnvVar: z.string().min(1).optional(),
  env: StringRecordSchema.optional(),
  ...McpServerCommonFields,
});

export const McpServerSseConfigSchema = z.object({
  transport: z.literal('sse'),
  url: z.string().url(),
  headers: StringRecordSchema.optional(),
  auth: z.literal('oauth').optional(),
  bearerTokenEnvVar: z.string().min(1).optional(),
  env: StringRecordSchema.optional(),
  ...McpServerCommonFields,
});

const McpServerConfigDiscriminatedSchema = z.discriminatedUnion('transport', [
  McpServerStdioConfigSchema,
  McpServerHttpConfigSchema,
  McpServerSseConfigSchema,
]);

export const McpServerConfigSchema = z.preprocess((raw) => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw;
  const obj = raw as Record<string, unknown>;
  if ('transport' in obj) return obj;
  if (typeof obj['command'] === 'string' && typeof obj['url'] === 'string') return obj;
  if (typeof obj['command'] === 'string') return { ...obj, transport: 'stdio' };
  if (typeof obj['url'] === 'string') return { ...obj, transport: 'http' };
  return obj;
}, McpServerConfigDiscriminatedSchema);

export const KimiConfigSchema = z.object({
  providers: z.record(z.string(), ProviderConfigSchema).default({}),
  defaultProvider: z.string().optional(),
  defaultModel: z.string().optional(),
  models: z.record(z.string(), ModelAliasSchema).optional(),
  thinking: ThinkingConfigSchema.optional(),
  planMode: z.boolean().optional(),
  yolo: z.boolean().optional(),
  defaultPermissionMode: PermissionModeSchema.optional(),
  defaultPlanMode: z.boolean().optional(),
  permission: PermissionConfigSchema.optional(),
  hooks: z.array(HookDefSchema).optional(),
  services: ServicesConfigSchema.optional(),
  mergeAllAvailableSkills: z.boolean().optional(),
  extraSkillDirs: z.array(z.string()).optional(),
  loopControl: LoopControlSchema.optional(),
  background: BackgroundConfigSchema.optional(),
  subagent: SubagentConfigSchema.optional(),
  agent: AgentConfigSchema.optional(),
  mcp: McpConfigSchema.optional(),
  image: ImageConfigSchema.optional(),
  modelCatalog: ModelCatalogConfigSchema.optional(),
  experimental: ExperimentalConfigSchema.optional(),
  telemetry: z.boolean().optional(),
  raw: z.record(z.string(), z.unknown()).optional(),
});

// ════════════════════════════════════════════════════════════════════════════
// Experimental flag definitions (copied from flags/registry.ts). Only the
// `id` fields are consumed by the migrator (to filter `[experimental]` keys);
// the i18n title/desc keys are preserved verbatim.
// ════════════════════════════════════════════════════════════════════════════

interface LocalFlagDefinition {
  readonly id: string;
  readonly title?: string;
  readonly description?: string;
  readonly titleKey?: string;
  readonly descKey?: string;
  readonly env: string;
  readonly default: boolean;
  readonly surface: 'core' | 'tui' | 'both';
}

export const FLAG_DEFINITIONS = [
  {
    id: 'tool-select',
    titleKey: 'flags.toolSelectTitle',
    descKey: 'flags.toolSelectDesc',
    env: 'KIMI_CODE_EXPERIMENTAL_TOOL_SELECT',
    default: false,
    surface: 'core',
  },
  {
    id: 'native_tools',
    titleKey: 'flags.nativeToolsTitle',
    descKey: 'flags.nativeToolsDesc',
    env: 'KIMI_CODE_EXPERIMENTAL_NATIVE_TOOLS',
    default: true,
    surface: 'core',
  },
  {
    id: 'rpc_microtask',
    titleKey: 'flags.rpcMicrotaskTitle',
    descKey: 'flags.rpcMicrotaskDesc',
    env: 'KIMI_CODE_EXPERIMENTAL_RPC_MICROTASK',
    default: false,
    surface: 'core',
  },
  {
    id: 'github_tools',
    title: 'GitHub tools',
    description:
      'Built-in GitHub REST tools (repos, files, issues, pull requests, search) backed by the native engine. Requires a GITHUB_TOKEN or GH_TOKEN environment variable, or set github_token in the [experimental] config section.',
    env: 'KIMI_CODE_EXPERIMENTAL_GITHUB_TOOLS',
    default: false,
    surface: 'core',
  },
  {
    id: 'goal_completion_verifier',
    title: 'Goal completion verifier',
    description:
      'Before a goal is marked complete, an isolated verifier agent independently checks the work against the objective and completion criterion, and rejects the completion if it is not verifiably done.',
    env: 'KIMI_CODE_EXPERIMENTAL_GOAL_COMPLETION_VERIFIER',
    default: true,
    surface: 'core',
  },
  {
    id: 'xunfei_coding_plan',
    title: 'Xunfei Coding Plan',
    description:
      'Enable iFlytek Astron Coding Plan as an API provider option. Requires an API key from xfyun.cn.',
    env: 'KIMI_CODE_EXPERIMENTAL_XUNFEI_CODING_PLAN',
    default: false,
    surface: 'both',
  },
] as const satisfies readonly LocalFlagDefinition[];

// ════════════════════════════════════════════════════════════════════════════
// transformTomlData (copied from config/toml.ts) — snake_case TOML data into
// the camelCase shape KimiConfigSchema validates.
// ════════════════════════════════════════════════════════════════════════════

function snakeToCamel(str: string): string {
  return str.replaceAll(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneUnknown<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneRecord(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) return {};
  return cloneUnknown(value);
}

function cloneObjectValue(value: unknown): unknown {
  return isPlainObject(value) ? cloneUnknown(value) : value;
}

function transformRecord(
  value: Record<string, unknown>,
  transformEntry: (entry: Record<string, unknown>) => Record<string, unknown>,
  transformName: (name: string) => string = (name) => name,
): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const [entryName, entryConfig] of Object.entries(value)) {
    record[transformName(entryName)] = isPlainObject(entryConfig)
      ? transformEntry(entryConfig)
      : entryConfig;
  }
  return record;
}

function transformPlainObject(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    out[snakeToCamel(key)] = value;
  }
  return out;
}

function transformProviderData(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const targetKey = snakeToCamel(key);
    if (targetKey === 'oauth') {
      out[targetKey] = isPlainObject(value) ? transformPlainObject(value) : value;
    } else if (targetKey === 'env' || targetKey === 'customHeaders') {
      out[targetKey] = cloneObjectValue(value);
    } else {
      out[targetKey] = value;
    }
  }
  return out;
}

function transformModelData(data: Record<string, unknown>): Record<string, unknown> {
  const out = transformPlainObject(data);
  if (isPlainObject(out['overrides'])) {
    out['overrides'] = transformPlainObject(out['overrides']);
  }
  return out;
}

function transformPermissionData(data: Record<string, unknown>): Record<string, unknown> {
  const raw = transformPlainObject(data);
  const out: Record<string, unknown> = {};

  const rules: unknown[] = [];
  appendPermissionRules(rules, raw['rules']);
  appendPermissionRules(rules, raw['deny'], 'deny');
  appendPermissionRules(rules, raw['allow'], 'allow');
  appendPermissionRules(rules, raw['ask'], 'ask');
  if (rules.length > 0) {
    out['rules'] = rules;
  }
  return out;
}

function appendPermissionRules(
  target: unknown[],
  value: unknown,
  decision?: 'allow' | 'deny' | 'ask',
): void {
  if (value === undefined) return;
  const entries = Array.isArray(value) ? value : [value];
  for (const entry of entries) {
    target.push(transformPermissionRule(entry, decision));
  }
}

function transformPermissionRule(value: unknown, decision?: 'allow' | 'deny' | 'ask'): unknown {
  if (!isPlainObject(value)) return value;

  const rule = transformPlainObject(value);
  const tool = rule['tool'];
  const match = rule['match'];
  const pattern = rule['pattern'];
  const out: Record<string, unknown> = {};

  if (decision !== undefined) {
    out['decision'] = decision;
  } else {
    out['decision'] = rule['decision'];
  }
  out['scope'] = rule['scope'];
  out['reason'] = rule['reason'];

  if (typeof tool === 'string') {
    const argPattern = typeof match === 'string' ? match : pattern;
    out['pattern'] = typeof argPattern === 'string' ? `${tool}(${argPattern})` : tool;
  } else {
    out['pattern'] = pattern;
  }

  return out;
}

function transformServiceData(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const targetKey = snakeToCamel(key);
    if (targetKey === 'oauth') {
      out[targetKey] = isPlainObject(value) ? transformPlainObject(value) : value;
    } else if (targetKey === 'customHeaders') {
      out[targetKey] = cloneObjectValue(value);
    } else {
      out[targetKey] = value;
    }
  }
  return out;
}

function transformLoopControlData(data: Record<string, unknown>): Record<string, unknown> {
  const out = transformPlainObject(data);
  if (out['maxStepsPerTurn'] === undefined && out['maxStepsPerRun'] !== undefined) {
    out['maxStepsPerTurn'] = out['maxStepsPerRun'];
  }
  delete out['maxStepsPerRun'];
  return out;
}

export function transformTomlData(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const targetKey = snakeToCamel(key);

    if (targetKey === 'providers' && isPlainObject(value)) {
      result[targetKey] = transformRecord(value, transformProviderData);
    } else if (targetKey === 'models' && isPlainObject(value)) {
      result[targetKey] = transformRecord(value, transformModelData);
    } else if (targetKey === 'thinking' && isPlainObject(value)) {
      result[targetKey] = transformPlainObject(value);
    } else if (targetKey === 'permission' && isPlainObject(value)) {
      result[targetKey] = transformPermissionData(value);
    } else if (targetKey === 'services' && isPlainObject(value)) {
      result[targetKey] = transformRecord(value, transformServiceData, snakeToCamel);
    } else if (targetKey === 'loopControl' && isPlainObject(value)) {
      result[targetKey] = transformLoopControlData(value);
    } else if (targetKey === 'background' && isPlainObject(value)) {
      result[targetKey] = transformPlainObject(value);
    } else if (targetKey === 'image' && isPlainObject(value)) {
      result[targetKey] = transformPlainObject(value);
    } else if (targetKey === 'experimental' && isPlainObject(value)) {
      result[targetKey] = cloneRecord(value);
    } else if (targetKey === 'subagent' && isPlainObject(value)) {
      result[targetKey] = transformPlainObject(value);
    } else if (targetKey === 'agent' && isPlainObject(value)) {
      result[targetKey] = transformPlainObject(value);
    } else if (targetKey === 'mcp' && isPlainObject(value)) {
      result[targetKey] = transformPlainObject(value);
    } else if (targetKey === 'modelCatalog' && isPlainObject(value)) {
      result[targetKey] = transformPlainObject(value);
    } else if (!isPlainObject(value)) {
      result[targetKey] = value;
    }
  }
  return result;
}
