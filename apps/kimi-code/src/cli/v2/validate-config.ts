import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';

import {
  ConfigRegistry,
  type AnyEnvBindings,
  type EnvBinding,
} from '@moonshot-ai/agent-core-v2';
import { collectKeyDeprecations } from '@moonshot-ai/agent-core-v2/app/config/deprecations';
import {
  camelToSnake,
  describeTomlSyntaxError,
  isPlainObject,
  transformTomlData,
} from '@moonshot-ai/agent-core-v2/app/config/toml';

const SCHEMALESS_DOMAINS: ReadonlySet<string> = new Set([
  'defaultModel',
  'defaultProvider',
  'modelOverrides',
  'telemetry',
]);

interface V2ConfigValidationIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

class V2ConfigValidationError extends Error {
  readonly details: { readonly validationIssues: readonly V2ConfigValidationIssue[] };

  constructor(issues: readonly V2ConfigValidationIssue[]) {
    super('v2 config validation failed');
    this.details = { validationIssues: issues };
  }
}

export function validateConfigTomlV2(
  text: string,
  filePath: string,
  getEnv: (name: string) => string | undefined = (name) => process.env[name],
): string | undefined {
  let data: Record<string, unknown> = {};
  if (text.trim().length > 0) {
    try {
      data = parseToml(text) as Record<string, unknown>;
    } catch (error) {
      throw new Error(`Invalid TOML in ${filePath}: ${describeTomlSyntaxError(error)}`, {
        cause: error,
      });
    }
  }

  const registry = new ConfigRegistry();
  const transformed = transformTomlData(data, registry);

  const issues: V2ConfigValidationIssue[] = [];
  const unknownKeys: string[] = [];
  for (const [domain, value] of Object.entries(transformed)) {
    if (registry.getSection(domain) === undefined) {
      if (!SCHEMALESS_DOMAINS.has(domain)) unknownKeys.push(camelToSnake(domain));
      continue;
    }
    try {
      registry.validate(domain, value);
    } catch (error) {
      if (!(error instanceof z.ZodError)) throw error;
      for (const issue of error.issues) {
        issues.push({
          path: [
            domain,
            ...issue.path.map((segment) =>
              typeof segment === 'number' ? segment : String(segment),
            ),
          ],
          message: issue.message,
        });
      }
    }
  }

  if (issues.length > 0) throw new V2ConfigValidationError(issues);

  const warnings: string[] = [];
  for (const diagnostic of collectKeyDeprecations(data, registry.listSections())) {
    warnings.push(diagnostic.message);
  }
  warnings.push(...collectEnvDeprecations(registry, getEnv));
  if (unknownKeys.length > 0) {
    warnings.push(
      `Unknown top-level ${unknownKeys.length === 1 ? 'key' : 'keys'} ignored by the v2 engine: ${unknownKeys.join(', ')}.`,
    );
  }
  return warnings.length > 0 ? warnings.join('\n') : undefined;
}

function collectEnvDeprecations(
  registry: ConfigRegistry,
  getEnv: (name: string) => string | undefined,
): string[] {
  const warnings = new Set<string>();
  for (const section of registry.listSections()) {
    if (section.env === undefined) continue;
    walkEnvBindings(section.env, (binding) => {
      if (typeof binding === 'string' || binding.deprecatedEnv === undefined) return;
      const primary = getEnv(binding.env);
      if (
        primary !== undefined &&
        (binding.parse === undefined || binding.parse(primary) !== undefined)
      ) {
        return;
      }
      const deprecated = getEnv(binding.deprecatedEnv);
      if (deprecated === undefined) return;
      if (binding.parse !== undefined && binding.parse(deprecated) === undefined) return;
      warnings.add(
        `Environment variable ${binding.deprecatedEnv} is deprecated; use ${binding.env} instead.`,
      );
    });
  }
  return [...warnings];
}

function isEnvBinding(value: AnyEnvBindings): value is EnvBinding {
  return typeof value === 'string' || (isPlainObject(value) && 'env' in value);
}

function walkEnvBindings(
  bindings: AnyEnvBindings,
  visit: (binding: EnvBinding) => void,
): void {
  if (isEnvBinding(bindings)) {
    visit(bindings);
    return;
  }
  for (const value of Object.values(bindings)) {
    if (value !== undefined) walkEnvBindings(value, visit);
  }
}
