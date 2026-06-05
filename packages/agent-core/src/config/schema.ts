import { HOOK_EVENT_TYPES } from '../session/hooks/types';
import { parsePattern } from '#/agent/permission/matches-rule';
import { ErrorCodes, KimiError } from '#/errors';
import { FLAG_DEFINITIONS, type FlagId } from '#/flags/registry';
import { z } from 'zod';

export const ProviderTypeSchema = z.enum([
  'anthropic',
  'openai',
  'kimi',
  'google-genai',
  'openai_responses',
  'vertexai',
]);

export type ProviderType = z.infer<typeof ProviderTypeSchema>;

export const OAuthRefSchema = z.object({
  storage: z.enum(['file', 'keyring']),
  key: z.string().min(1),
  oauthHost: z.string().min(1).optional(),
});

export type OAuthRef = z.infer<typeof OAuthRefSchema>;

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
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export const ModelAliasSchema = z.object({
  provider: z.string(),
  model: z.string(),
  maxContextSize: z.number().int().min(1),
  maxOutputSize: z.number().int().min(1).optional(),
  capabilities: z.array(z.string()).optional(),
  displayName: z.string().optional(),
  reasoningKey: z.string().optional(),
  // Explicitly declare adaptive-thinking support, overriding the kosong
  // model-name version inference. Needed for custom-named Anthropic endpoints
  // whose model name does not encode a parseable Claude version.
  adaptiveThinking: z.boolean().optional(),
});

export type ModelAlias = z.infer<typeof ModelAliasSchema>;

export const ThinkingConfigSchema = z.object({
  mode: z.enum(['auto', 'on', 'off']).optional(),
  effort: z.string().optional(),
});

export type ThinkingConfig = z.infer<typeof ThinkingConfigSchema>;

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

export type PermissionConfig = z.infer<typeof PermissionConfigSchema>;

export const LoopControlSchema = z.object({
  maxStepsPerTurn: z.number().int().min(0).optional(),
  maxRetriesPerStep: z.number().int().min(0).optional(),
  maxRalphIterations: z.number().int().min(-1).optional(),
  reservedContextSize: z.number().int().min(0).optional(),
  compactionTriggerRatio: z.number().min(0.5).max(0.99).optional(),
});

export type LoopControl = z.infer<typeof LoopControlSchema>;

export const BackgroundConfigSchema = z.object({
  maxRunningTasks: z.number().int().min(1).optional(),
  keepAliveOnExit: z.boolean().optional(),
  killGracePeriodMs: z.number().int().min(0).optional(),
  printWaitCeilingS: z.number().int().min(1).optional(),
});

export type BackgroundConfig = z.infer<typeof BackgroundConfigSchema>;

const ExperimentalFlagIdSet = new Set<string>(FLAG_DEFINITIONS.map((def) => def.id));

export const ExperimentalConfigSchema = z
  .record(z.string(), z.boolean())
  .superRefine((config, ctx) => {
    for (const key of Object.keys(config)) {
      if (ExperimentalFlagIdSet.has(key)) continue;
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: `Unknown experimental feature "${key}".`,
      });
    }
  }) as z.ZodType<Partial<Record<FlagId, boolean>>>;

export type ExperimentalConfig = z.infer<typeof ExperimentalConfigSchema>;

export const HookDefSchema = z
  .object({
    event: z.enum(HOOK_EVENT_TYPES),
    matcher: z.string().optional(),
    command: z.string().min(1),
    timeout: z.number().int().min(1).max(600).optional(),
  })
  .strict();

export type HookDefConfig = z.infer<typeof HookDefSchema>;

export const MoonshotServiceConfigSchema = z.object({
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  oauth: OAuthRefSchema.optional(),
  customHeaders: StringRecordSchema.optional(),
});

export type MoonshotServiceConfig = z.infer<typeof MoonshotServiceConfigSchema>;

export const ServicesConfigSchema = z.object({
  moonshotSearch: MoonshotServiceConfigSchema.optional(),
  moonshotFetch: MoonshotServiceConfigSchema.optional(),
});

export type ServicesConfig = z.infer<typeof ServicesConfigSchema>;

const McpServerCommonFields = {
  enabled: z.boolean().optional(),
  startupTimeoutMs: z.number().int().min(1).optional(),
  toolTimeoutMs: z.number().int().min(1).optional(),
  enabledTools: z.array(z.string()).optional(),
  disabledTools: z.array(z.string()).optional(),
} as const;

export const McpServerStdioConfigSchema = z.object({
  transport: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: StringRecordSchema.optional(),
  cwd: z.string().optional(),
  // Reserved for future kaos-backed stdio launchers. `undefined` and `'local'`
  // both mean direct child_process spawn for now.
  executor: z.enum(['local', 'kaos']).optional(),
  ...McpServerCommonFields,
});

export type McpServerStdioConfig = z.infer<typeof McpServerStdioConfigSchema>;

export const McpServerHttpConfigSchema = z.object({
  transport: z.literal('http'),
  url: z.string().url(),
  headers: StringRecordSchema.optional(),
  // Indirect secret reference: the bearer token is looked up from
  // `process.env[bearerTokenEnvVar]` at connection time, never committed.
  bearerTokenEnvVar: z.string().min(1).optional(),
  ...McpServerCommonFields,
});

export type McpServerHttpConfig = z.infer<typeof McpServerHttpConfigSchema>;

const McpServerConfigDiscriminatedSchema = z.discriminatedUnion('transport', [
  McpServerStdioConfigSchema,
  McpServerHttpConfigSchema,
]);

export const McpServerConfigSchema = z.preprocess((raw) => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw;
  const obj = raw as Record<string, unknown>;
  if ('transport' in obj) return obj;
  if (typeof obj['command'] === 'string') return { ...obj, transport: 'stdio' };
  if (typeof obj['url'] === 'string') return { ...obj, transport: 'http' };
  return obj;
}, McpServerConfigDiscriminatedSchema);

export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

export const KimiConfigSchema = z.object({
  providers: z.record(z.string(), ProviderConfigSchema).default({}),
  defaultProvider: z.string().optional(),
  defaultModel: z.string().optional(),
  models: z.record(z.string(), ModelAliasSchema).optional(),
  thinking: ThinkingConfigSchema.optional(),
  planMode: z.boolean().optional(),
  yolo: z.boolean().optional(),
  defaultThinking: z.boolean().optional(),
  defaultPermissionMode: PermissionModeSchema.optional(),
  defaultPlanMode: z.boolean().optional(),
  permission: PermissionConfigSchema.optional(),
  hooks: z.array(HookDefSchema).optional(),
  services: ServicesConfigSchema.optional(),
  mergeAllAvailableSkills: z.boolean().optional(),
  extraSkillDirs: z.array(z.string()).optional(),
  loopControl: LoopControlSchema.optional(),
  background: BackgroundConfigSchema.optional(),
  experimental: ExperimentalConfigSchema.optional(),
  telemetry: z.boolean().optional(),
  raw: z.record(z.string(), z.unknown()).optional(),
});

export type KimiConfig = z.infer<typeof KimiConfigSchema>;

const ProviderConfigPatchSchema = ProviderConfigSchema.partial();
const ModelAliasPatchSchema = ModelAliasSchema.partial();
const ThinkingConfigPatchSchema = ThinkingConfigSchema.partial();
const PermissionConfigPatchSchema = PermissionConfigSchema.partial();
const LoopControlPatchSchema = LoopControlSchema.partial();
const BackgroundConfigPatchSchema = BackgroundConfigSchema.partial();
const ExperimentalConfigPatchSchema = ExperimentalConfigSchema;
const MoonshotServiceConfigPatchSchema = MoonshotServiceConfigSchema.partial();
const ServicesConfigPatchSchema = z.object({
  moonshotSearch: MoonshotServiceConfigPatchSchema.optional(),
  moonshotFetch: MoonshotServiceConfigPatchSchema.optional(),
});

export const KimiConfigPatchSchema = z
  .object({
    providers: z.record(z.string(), ProviderConfigPatchSchema).optional(),
    defaultProvider: z.string().optional(),
    defaultModel: z.string().optional(),
    models: z.record(z.string(), ModelAliasPatchSchema).optional(),
    thinking: ThinkingConfigPatchSchema.optional(),
    planMode: z.boolean().optional(),
    yolo: z.boolean().optional(),
    defaultThinking: z.boolean().optional(),
    defaultPermissionMode: PermissionModeSchema.optional(),
    defaultPlanMode: z.boolean().optional(),
    permission: PermissionConfigPatchSchema.optional(),
    hooks: z.array(HookDefSchema).optional(),
    services: ServicesConfigPatchSchema.optional(),
    mergeAllAvailableSkills: z.boolean().optional(),
    extraSkillDirs: z.array(z.string()).optional(),
    loopControl: LoopControlPatchSchema.optional(),
    background: BackgroundConfigPatchSchema.optional(),
    experimental: ExperimentalConfigPatchSchema.optional(),
    telemetry: z.boolean().optional(),
  })
  .strict();

export type KimiConfigPatch = z.infer<typeof KimiConfigPatchSchema>;

export function getDefaultConfig(): KimiConfig {
  return {
    providers: {},
  };
}

export function validateConfig(config: unknown): KimiConfig {
  try {
    return KimiConfigSchema.parse(config);
  } catch (error) {
    throw new KimiError(ErrorCodes.CONFIG_INVALID, `Invalid configuration: ${formatConfigValidationError(error)}`, {
      cause: error,
    });
  }
}

export function formatConfigValidationError(error: unknown): string {
  const missingModelContextSize = missingModelContextSizeMessage(error);
  if (missingModelContextSize !== undefined) return missingModelContextSize;
  return error instanceof Error ? error.message : String(error);
}

function missingModelContextSizeMessage(error: unknown): string | undefined {
  if (!(error instanceof z.ZodError)) return undefined;
  for (const issue of error.issues) {
    const [section, modelName, field] = issue.path;
    if (section === 'models' && typeof modelName === 'string' && field === 'maxContextSize') {
      return `Model "${modelName}" must define a positive max_context_size in config.toml.`;
    }
  }
  return undefined;
}

function isValidPermissionPattern(pattern: string): boolean {
  try {
    parsePattern(pattern);
    return true;
  } catch {
    return false;
  }
}
