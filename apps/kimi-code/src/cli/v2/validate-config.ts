/**
 * Experimental v2 config.toml validation for `kimi doctor`.
 *
 * Loaded lazily (dynamic import) by the doctor command only when the
 * agent-core-v2 master switch (`KIMI_CODE_EXPERIMENTAL_FLAG`) is on, so the
 * v2 module graph stays off the default (v1) doctor path. Validation uses the
 * engine's own section registry instead of v1's whole-document strict schema:
 * importing the package root runs every built-in section's side-effect
 * registration ("import = register"), and `ConfigRegistry` is then
 * constructed directly — no DI container, no `ConfigService`, no file IO.
 *
 * Semantics deliberately mirror the v2 engine rather than v1:
 *  - a registered section that fails schema validation is an error (the
 *    engine would silently ignore that section at runtime; surfacing it is
 *    doctor's job);
 *  - a top-level key with no registered section passes through the engine
 *    untouched, so it is reported as a non-fatal warning — except the known
 *    schema-less domains the engine consumes directly (`default_model`, …);
 *  - section-declared key renames (`deprecations`) and renamed env vars
 *    (`deprecatedEnv` bindings actually supplying a value) surface as
 *    non-fatal warnings, reusing the engine's own detection
 *    (`collectKeyDeprecations`) and mirroring `ConfigService`'s env-fallback
 *    warning rule.
 */

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

/**
 * Top-level domains the v2 engine reads via `IConfigService.get` / `inspect`
 * without registering a schema (free-form values, structurally validated
 * nowhere): `defaultModel` / `defaultProvider` (`kosongConfig` default
 * pointers), `modelOverrides` (`llmRequester` / `profile`), and `telemetry`
 * (read by the CLI itself).
 */
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

/**
 * Matches the shape `handleDoctor` extracts from `error.details` (the SDK's
 * `KimiConfigValidationIssue` list), so the doctor formatter renders v2
 * issues exactly like v1 ones.
 */
class V2ConfigValidationError extends Error {
  readonly details: { readonly validationIssues: readonly V2ConfigValidationIssue[] };

  constructor(issues: readonly V2ConfigValidationIssue[]) {
    super('v2 config validation failed');
    this.details = { validationIssues: issues };
  }
}

/**
 * Validate `text` as config.toml against the v2 engine's section registry.
 * Throws on TOML syntax errors and on any registered section failing its
 * schema; returns non-fatal warnings (one per line) for unknown top-level
 * keys, deprecated config keys, and deprecated env vars in use.
 */
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

/**
 * Warn about renamed env vars that actually supply a value, mirroring
 * `ConfigService`'s `resolveBinding`: the deprecated name only resolves (and
 * thus only warns) when the primary var is absent or fails to parse.
 */
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
