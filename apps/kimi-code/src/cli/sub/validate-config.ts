import { z } from 'zod';

import {
  camelToSnake,
  defaultFromToml,
  defaultModelConfigSection,
  describeTomlSyntaxError,
  isEnvBinding,
  modelCatalogConfigSection,
  modelsConfigSection,
  parseConfigText,
  providersConfigSection,
  thinkingConfigSection,
  type AnyEnvBindings,
  type ConfigKeyDeprecation,
  type EnvBinding,
} from '@moonshot-ai/agent-core';
import {
  builtinProductSkillsSection,
  cronConfigSection,
  defaultPlanModeSection,
  extraSkillDirsSection,
  hooksConfigSection,
  legacyBackgroundConfigSection,
  mcpConfigSection,
  mergeAllAvailableSkillsSection,
  readConfigSection,
  swarmConfigSection,
  taskConfigSection,
  tokenCountingConfigSection,
} from '@moonshot-ai/harness-core';
import { servicesConfigSection } from '@moonshot-ai/harness-core/features/kimi/web/configSection';
import { imageConfigSection } from '@moonshot-ai/harness-core/features/media/state/configSection';
import {
  defaultPermissionModeConfigSection,
  permissionConfigSection,
} from '@moonshot-ai/harness-core/features/permission/state/configSection';

interface DoctorConfigSection {
  readonly name: string;
  readonly schema: { parse(value: unknown): unknown };
  readonly fromToml?: (raw: unknown) => unknown;
  readonly deprecations?: readonly ConfigKeyDeprecation[];
  readonly envBindings?: unknown;
}

const REGISTERED_SECTIONS: readonly DoctorConfigSection[] = [
  providersConfigSection,
  modelsConfigSection,
  thinkingConfigSection,
  modelCatalogConfigSection,
  defaultModelConfigSection,
  permissionConfigSection,
  defaultPermissionModeConfigSection,
  cronConfigSection,
  hooksConfigSection,
  readConfigSection,
  taskConfigSection,
  legacyBackgroundConfigSection,
  defaultPlanModeSection,
  swarmConfigSection,
  tokenCountingConfigSection,
  mcpConfigSection,
  servicesConfigSection,
  imageConfigSection,
  extraSkillDirsSection,
  mergeAllAvailableSkillsSection,
  builtinProductSkillsSection,
];

const SCHEMALESS_DOMAINS: ReadonlySet<string> = new Set([
  'default_provider',
  'model_overrides',
  'telemetry',
]);

interface ConfigValidationIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

class ConfigValidationError extends Error {
  readonly details: { readonly validationIssues: readonly ConfigValidationIssue[] };

  constructor(issues: readonly ConfigValidationIssue[]) {
    super('config validation failed');
    this.details = { validationIssues: issues };
  }
}

export function validateConfigToml(
  text: string,
  filePath: string,
  getEnv: (name: string) => string | undefined = (name) => process.env[name],
): string | undefined {
  let data: Record<string, unknown> = {};
  if (text.trim().length > 0) {
    try {
      data = parseConfigText(text);
    } catch (error) {
      throw new Error(`Invalid TOML in ${filePath}: ${describeTomlSyntaxError(error)}`, {
        cause: error,
      });
    }
  }

  const issues: ConfigValidationIssue[] = [];
  const unknownKeys: string[] = [];
  const warnings: string[] = [];
  for (const [domain, value] of Object.entries(data)) {
    const section = REGISTERED_SECTIONS.find((candidate) => camelToSnake(candidate.name) === domain);
    if (section === undefined) {
      if (!SCHEMALESS_DOMAINS.has(domain)) unknownKeys.push(domain);
      continue;
    }
    try {
      const converted =
        section.fromToml === undefined ? defaultFromToml(value) : section.fromToml(value);
      section.schema.parse(converted);
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
    if (section.deprecations !== undefined && typeof value === 'object' && value !== null) {
      for (const deprecation of section.deprecations) {
        if ((value as Record<string, unknown>)[deprecation.key] === undefined) continue;
        warnings.push(
          `[${section.name}] '${deprecation.key}' is deprecated and no longer used; ` +
            `rename it to '${deprecation.replacement}'.` +
            (deprecation.message === undefined ? '' : ` ${deprecation.message}`),
        );
      }
    }
  }

  if (issues.length > 0) throw new ConfigValidationError(issues);

  for (const section of REGISTERED_SECTIONS) {
    if (section.envBindings === undefined) continue;
    warnings.push(...collectEnvDeprecations(section, getEnv));
  }
  if (unknownKeys.length > 0) {
    warnings.push(
      `Unknown top-level ${unknownKeys.length === 1 ? 'key' : 'keys'} ignored by the engine: ${unknownKeys.join(', ')}.`,
    );
  }
  return warnings.length > 0 ? [...new Set(warnings)].join('\n') : undefined;
}

function collectEnvDeprecations(
  section: DoctorConfigSection,
  getEnv: (name: string) => string | undefined,
): string[] {
  const warnings = new Set<string>();
  walkEnvBindings(section.envBindings as AnyEnvBindings, (binding) => {
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
  return [...warnings];
}

function walkEnvBindings(
  bindings: AnyEnvBindings | undefined,
  visit: (binding: EnvBinding) => void,
): void {
  if (bindings === undefined) return;
  if (isEnvBinding(bindings)) {
    visit(bindings);
    return;
  }
  for (const value of Object.values(bindings)) {
    if (value !== undefined) walkEnvBindings(value, visit);
  }
}
