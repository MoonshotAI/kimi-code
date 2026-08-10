/**
 * Local config-rpc surface — ported (trimmed) from
 * `@moonshot-ai/kimi-code-sdk` `config-rpc.ts` (G-1 CLI consumption
 * cutover). The SDK's in-process RPC pair is dropped: the host only needs
 * config path resolution and TOML validation, with a minimal zod schema
 * covering the sections `doctor` reports on (providers / models plus a few
 * top-level scalars). Sections outside the schema are stripped rather than
 * rejected, so this is strictly more lenient than the SDK for config shapes
 * `doctor` does not surface.
 */

import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';

import { resolveConfigPath } from '#/cli/runtime-config';
import { KimiError } from '#/cli/sdk-errors';

export type KimiConfigValidationPathSegment = string | number;

export interface KimiConfigValidationIssue {
  readonly path: readonly KimiConfigValidationPathSegment[];
  readonly message: string;
}

export interface ResolveKimiConfigPathInput {
  readonly homeDir?: string | undefined;
  readonly configPath?: string | undefined;
}

export interface ValidateKimiConfigTomlInput {
  readonly text: string;
  readonly filePath?: string | undefined;
}

export interface KimiConfigRpc {
  resolveConfigPath(input?: ResolveKimiConfigPathInput): Promise<string>;
  validateConfigToml(input: ValidateKimiConfigTomlInput): Promise<void>;
}

/** SDK `ErrorCodes.CONFIG_INVALID` (kept inline, absent from the local table). */
const CONFIG_INVALID = 'config.invalid';

export function createKimiConfigRpc(): KimiConfigRpc {
  return {
    resolveConfigPath(input = {}) {
      return Promise.resolve(resolveConfigPath(input));
    },
    validateConfigToml(input) {
      return Promise.resolve(validateConfigTomlText(input.text, input.filePath));
    },
  };
}

const ProviderTypeSchema = z.enum([
  'anthropic',
  'openai',
  'kimi',
  'google-genai',
  'openai_responses',
  'vertexai',
  'astron',
]);

const StringRecordSchema = z.record(z.string(), z.string());

const ProviderConfigSchema = z.object({
  type: ProviderTypeSchema,
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  defaultModel: z.string().optional(),
  env: StringRecordSchema.optional(),
  customHeaders: StringRecordSchema.optional(),
  stream: z.boolean().optional(),
  temperature: z.number().optional(),
  maxTokens: z.number().int().min(1).optional(),
  searchDisable: z.boolean().optional(),
});

const ModelAliasSchema = z.object({
  provider: z.string(),
  model: z.string(),
  maxContextSize: z.number().int().min(1),
  maxInputSize: z.number().int().min(1).optional(),
  maxOutputSize: z.number().int().min(1).optional(),
  capabilities: z.array(z.string()).optional(),
  displayName: z.string().optional(),
  reasoningKey: z.string().optional(),
  baseUrl: z.string().optional(),
});

const ConfigTomlSchema = z.object({
  providers: z.record(z.string(), ProviderConfigSchema).default({}),
  defaultProvider: z.string().optional(),
  defaultModel: z.string().optional(),
  models: z.record(z.string(), ModelAliasSchema).optional(),
  telemetry: z.boolean().optional(),
});

function validateConfigTomlText(tomlText: string, filePath = 'config.toml'): void {
  if (tomlText.trim().length === 0) return;

  let data: Record<string, unknown>;
  try {
    data = parseToml(tomlText) as Record<string, unknown>;
  } catch (error) {
    throw new KimiError(
      CONFIG_INVALID,
      `Invalid TOML in ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  try {
    ConfigTomlSchema.parse(transformTomlData(data));
  } catch (error) {
    const validationIssues = extractValidationIssues(error);
    throw new KimiError(
      CONFIG_INVALID,
      `Invalid configuration in ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      {
        details: validationIssues === undefined ? undefined : { validationIssues },
        cause: error,
      },
    );
  }
}

function extractValidationIssues(
  error: unknown,
): readonly KimiConfigValidationIssue[] | undefined {
  const zodError = findZodError(error);
  if (zodError === undefined) return undefined;
  return zodError.issues.map((issue) => ({
    path: issue.path.map((segment) => (typeof segment === 'number' ? segment : String(segment))),
    message: issue.message,
  }));
}

function findZodError(error: unknown): z.ZodError | undefined {
  if (error instanceof z.ZodError) return error;
  if (error instanceof Error && error.cause instanceof z.ZodError) return error.cause;
  return undefined;
}

function transformTomlData(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    result[snakeToCamel(key)] = isPlainObject(value) ? transformTomlData(value) : value;
  }
  return result;
}

function snakeToCamel(str: string): string {
  return str.replaceAll(/_([a-z])/g, (_match, ch: string) => ch.toUpperCase());
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
