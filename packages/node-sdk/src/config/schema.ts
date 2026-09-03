import { parsePattern } from '@moonshot-ai/agent-core-v2/agent/permissionRules/matchesRule';
import { z } from 'zod';

import { ErrorCodes, KimiError } from '#/errors';

const HOOK_EVENT_TYPES = [
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

const ModelAliasBaseSchema = z.object({
  provider: z.string(),
  model: z.string(),
  maxContextSize: z.number().int().min(1),
  maxInputSize: z.number().int().min(1).optional(),
  maxOutputSize: z.number().int().min(1).optional(),
  capabilities: z.array(z.string()).optional(),
  displayName: z.string().optional(),
  reasoningKey: z.string().optional(),
  protocol: z.enum(['anthropic', 'openai_responses']).optional(),
  adaptiveThinking: z.boolean().optional(),
  supportEfforts: z.array(z.string()).optional(),
  defaultEffort: z.string().optional(),
  offEffort: z.string().optional(),
  betaApi: z.boolean().optional(),
  baseUrl: z.string().optional(),
});

export const ModelAliasOverrideSchema = ModelAliasBaseSchema.omit({
  provider: true,
  model: true,
  protocol: true,
  betaApi: true,
  baseUrl: true,
}).partial();

export type ModelAliasOverrides = z.infer<typeof ModelAliasOverrideSchema>;

export const ModelAliasSchema = ModelAliasBaseSchema.extend({
  overrides: ModelAliasOverrideSchema.optional(),
});

export type ModelAlias = z.infer<typeof ModelAliasSchema>;

export const SecondaryModelConfigSchema = ModelAliasOverrideSchema.extend({
  model: z.string().min(1).optional(),
  defaultModel: z.string().min(1).optional(),
  models: z.record(z.string(), z.string()).optional(),
  force: z.boolean().optional(),
});

export type SecondaryModelConfig = z.infer<typeof SecondaryModelConfigSchema>;

export const ThinkingConfigSchema = z.object({
  enabled: z.boolean().optional(),
  effort: z.string().optional(),
  keep: z.string().optional(),
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
  bashAutoBackgroundOnTimeout: z.boolean().optional(),
  bashTaskTimeoutS: z.number().int().min(0).optional(),
  killGracePeriodMs: z.number().int().min(0).optional(),
  printWaitCeilingS: z.number().int().min(1).optional(),
  printBackgroundMode: z.enum(['exit', 'drain', 'steer']).optional(),
  printMaxTurns: z.number().int().min(1).optional(),
});

export type BackgroundConfig = z.infer<typeof BackgroundConfigSchema>;

export const SubagentConfigSchema = z.object({
  timeoutMs: z.number().int().min(0).optional(),
});

export type SubagentConfig = z.infer<typeof SubagentConfigSchema>;

export const MAX_MCP_TIMEOUT_MS = 2_147_483_647;
const McpTimeoutMsSchema = z.number().int().min(1).max(MAX_MCP_TIMEOUT_MS);

export const McpConfigSchema = z.object({
  startupTimeoutMs: McpTimeoutMsSchema.optional(),
  toolTimeoutMs: McpTimeoutMsSchema.optional(),
});

export type McpConfig = z.infer<typeof McpConfigSchema>;

export const ImageConfigSchema = z.object({
  maxEdgePx: z.number().int().min(1).optional(),
  readByteBudget: z.number().int().min(1).optional(),
});

export type ImageConfig = z.infer<typeof ImageConfigSchema>;

export const ModelCatalogConfigSchema = z.object({
  refreshIntervalMs: z.number().int().min(0).optional(),
  refreshOnStart: z.boolean().optional(),
});

export type ModelCatalogConfig = z.infer<typeof ModelCatalogConfigSchema>;

export const ExperimentalConfigSchema = z.record(z.string(), z.boolean());

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

export type McpServerStdioConfig = z.infer<typeof McpServerStdioConfigSchema>;

export const McpServerHttpConfigSchema = z.object({
  transport: z.literal('http'),
  url: z.string().url(),
  headers: StringRecordSchema.optional(),
  auth: z.literal('oauth').optional(),
  bearerTokenEnvVar: z.string().min(1).optional(),
  ...McpServerCommonFields,
});

export type McpServerHttpConfig = z.infer<typeof McpServerHttpConfigSchema>;

export const McpServerSseConfigSchema = z.object({
  transport: z.literal('sse'),
  url: z.string().url(),
  headers: StringRecordSchema.optional(),
  auth: z.literal('oauth').optional(),
  bearerTokenEnvVar: z.string().min(1).optional(),
  ...McpServerCommonFields,
});

export type McpServerSseConfig = z.infer<typeof McpServerSseConfigSchema>;

export type McpRemoteServerConfig = McpServerHttpConfig | McpServerSseConfig;

const McpServerConfigDiscriminatedSchema = z.discriminatedUnion('transport', [
  McpServerStdioConfigSchema,
  McpServerHttpConfigSchema,
  McpServerSseConfigSchema,
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
  defaultPermissionMode: PermissionModeSchema.optional(),
  defaultPlanMode: z.boolean().optional(),
  permission: PermissionConfigSchema.optional(),
  hooks: z.array(HookDefSchema).optional(),
  services: ServicesConfigSchema.optional(),
  mergeAllAvailableSkills: z.boolean().optional(),
  extraSkillDirs: z.array(z.string()).optional(),
  extraAgentDirs: z.array(z.string()).optional(),
  loopControl: LoopControlSchema.optional(),
  background: BackgroundConfigSchema.optional(),
  subagent: SubagentConfigSchema.optional(),
  secondaryModel: SecondaryModelConfigSchema.optional(),
  mcp: McpConfigSchema.optional(),
  image: ImageConfigSchema.optional(),
  modelCatalog: ModelCatalogConfigSchema.optional(),
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
const SubagentConfigPatchSchema = SubagentConfigSchema.partial();
const SecondaryModelConfigPatchSchema = SecondaryModelConfigSchema.partial();
const McpConfigPatchSchema = McpConfigSchema.partial();
const ImageConfigPatchSchema = ImageConfigSchema.partial();
const ModelCatalogConfigPatchSchema = ModelCatalogConfigSchema.partial();
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
    defaultPermissionMode: PermissionModeSchema.optional(),
    defaultPlanMode: z.boolean().optional(),
    permission: PermissionConfigPatchSchema.optional(),
    hooks: z.array(HookDefSchema).optional(),
    services: ServicesConfigPatchSchema.optional(),
    mergeAllAvailableSkills: z.boolean().optional(),
    extraSkillDirs: z.array(z.string()).optional(),
    extraAgentDirs: z.array(z.string()).optional(),
    loopControl: LoopControlPatchSchema.optional(),
    background: BackgroundConfigPatchSchema.optional(),
    subagent: SubagentConfigPatchSchema.optional(),
    secondaryModel: SecondaryModelConfigPatchSchema.optional(),
    mcp: McpConfigPatchSchema.optional(),
    image: ImageConfigPatchSchema.optional(),
    modelCatalog: ModelCatalogConfigPatchSchema.optional(),
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
