/**
 * Generates `docs/config-manifest.toml` — the single place to see every config
 * section registered via `registerConfigSection(...)` plus every effective
 * overlay registered via `registerConfigOverlay(...)`.
 *
 * Two passes:
 *   1. Static scan of `src/**` maps each registered section domain (and each
 *      overlay) to the source file that registers it — the "owner".
 *   2. Runtime pass imports `src/index.ts` ("import = register") and drains the
 *      module-level contributions, capturing defaults, env bindings, and the
 *      registered hooks exactly as the running process sees them.
 *
 * The output is TOML in the on-disk shape (snake_case keys): one `[table]` per
 * section, uncommented assignments for registered defaults, and commented
 * `# field: type` lines for the remaining schema fields.
 *
 * Usage:
 *   pnpm --filter @moonshot-ai/agent-core-v2 gen:config-manifest          # write the file
 *   pnpm --filter @moonshot-ai/agent-core-v2 gen:config-manifest --check  # freshness check (CI-style)
 *
 * Freshness is also enforced by `test/app/config/configManifest.test.ts`.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

import { getConfigOverlayContributions } from '#/app/config/configOverlayContributions';
import type { ConfigSectionContribution } from '#/app/config/configSectionContributions';
import { getConfigSectionContributions } from '#/app/config/configSectionContributions';
import { camelToSnake } from '#/app/config/toml';

import {
  asJsonSchema,
  describeType,
  isRecord,
  resolveRef,
  toJsonSchema,
  truncate,
  type JsonSchema,
} from './lib/jsonSchema.mts';

const PKG = join(import.meta.dirname, '..');
const SRC = join(PKG, 'src');
export const MANIFEST_PATH = join(PKG, 'docs', 'config-manifest.toml');

// ---------------------------------------------------------------------------
// Static pass — domain/overlay → owner file
// ---------------------------------------------------------------------------

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (entry.endsWith('.ts')) out.push(p);
  }
  return out;
}

function constStringValue(source: string, ident: string): string | undefined {
  const re = new RegExp(`(?:export\\s+)?const\\s+${ident}\\s*(?::[^=;]+)?=\\s*'([^']+)'`);
  return re.exec(source)?.[1];
}

/** domain key → owner file (relative to the package root). */
function scanSectionOwners(): Map<string, string> {
  const owners = new Map<string, string>();
  for (const file of walk(SRC)) {
    const source = readFileSync(file, 'utf-8');
    if (!source.includes('registerConfigSection(')) continue;
    for (const match of source.matchAll(/registerConfigSection\(\s*(?:'([^']+)'|([A-Za-z0-9_$]+))/g)) {
      const ident = match[2];
      const domain = match[1] ?? (ident === undefined ? undefined : constStringValue(source, ident));
      if (domain !== undefined) owners.set(domain, relative(PKG, file));
    }
  }
  return owners;
}

/** overlay variable name → owner file (relative to the package root). */
function scanOverlayOwners(): Map<string, string> {
  const owners = new Map<string, string>();
  for (const file of walk(SRC)) {
    // Skip the collector module itself — its `registerConfigOverlay(overlay)`
    // function signature is not a registration.
    if (file.endsWith('configOverlayContributions.ts')) continue;
    const source = readFileSync(file, 'utf-8');
    if (!source.includes('registerConfigOverlay(')) continue;
    for (const match of source.matchAll(/registerConfigOverlay\(\s*([A-Za-z0-9_$]+)/g)) {
      const ident = match[1];
      if (ident !== undefined) owners.set(ident, relative(PKG, file));
    }
  }
  return owners;
}

// ---------------------------------------------------------------------------
// TOML-like rendering helpers
// ---------------------------------------------------------------------------

/** Serialize a small JSON value as an inline TOML value. */
function toTomlValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(toTomlValue).join(', ')}]`;
  if (isRecord(value)) {
    const entries = Object.entries(value).map(([k, v]) => `${camelToSnake(k)} = ${toTomlValue(v)}`);
    return `{ ${entries.join(', ')} }`;
  }
  return '""';
}

interface EnvRow {
  readonly field: string;
  readonly env: string;
  readonly detail: string;
}

/** Property access shape of an `EnvBinding` object (avoids index-signature access). */
interface EnvBindingFields {
  readonly env?: unknown;
  readonly parse?: unknown;
  readonly default?: unknown;
}

function flattenEnvBindings(bindings: unknown, path: string[] = []): EnvRow[] {
  if (typeof bindings === 'string') {
    return [{ field: path.join('.'), env: bindings, detail: '' }];
  }
  if (!isRecord(bindings)) return [];
  const binding = bindings as EnvBindingFields;
  if (typeof binding.env === 'string') {
    const detail: string[] = [];
    if (binding.parse !== undefined) detail.push('custom parse');
    if (binding.default !== undefined) detail.push(`default ${JSON.stringify(binding.default)}`);
    return [{ field: path.join('.'), env: binding.env, detail: detail.join('; ') }];
  }
  return Object.entries(bindings).flatMap(([key, value]) => flattenEnvBindings(value, [...path, key]));
}

function snakePath(field: string): string {
  return field.split('.').map(camelToSnake).join('.');
}

const RULE = `# ${'#'.repeat(74)}`;

// ---------------------------------------------------------------------------
// Section rendering
// ---------------------------------------------------------------------------

/** `# field: type (default: x)` comment lines for an object schema's properties. */
function renderFieldComments(
  properties: Record<string, unknown>,
  root: JsonSchema,
  indent: string,
  depth = 0,
): string[] {
  const lines: string[] = [];
  for (const [name, prop] of Object.entries(properties)) {
    const resolved = resolveRef(prop, root);
    const propDefault = asJsonSchema(resolved)?.default;
    const defNote = propDefault !== undefined ? ` (default: ${JSON.stringify(propDefault)})` : '';
    lines.push(`${indent}# ${camelToSnake(name)}: ${describeType(resolved)}${defNote}`);
    // Expand nested object fields one level at a time (depth-capped so a
    // recursive $ref cannot loop).
    const subProps = asJsonSchema(resolved)?.properties;
    if (depth < 3 && isRecord(subProps) && Object.keys(subProps).length > 0) {
      lines.push(...renderFieldComments(subProps, root, `${indent}  `, depth + 1));
    }
  }
  return lines;
}

function renderBody(section: ConfigSectionContribution): string[] {
  const { domain, schema, options } = section;
  const key = camelToSnake(domain);
  const jsonSchema = schema === undefined ? undefined : toJsonSchema(schema);

  if (jsonSchema === undefined) {
    // No schema (passthrough) or a schema that JSON Schema cannot represent.
    if (isRecord(options.defaultValue)) {
      return [
        `[${key}]`,
        `# (${schema === undefined ? 'no schema — passthrough' : 'schema uses transforms'}; fields below come from the registered default)`,
        ...Object.entries(options.defaultValue).map(
          ([k, v]) => `${camelToSnake(k)} = ${truncate(toTomlValue(v))}`,
        ),
      ];
    }
    if (options.defaultValue !== undefined) {
      return [`${key} = ${truncate(toTomlValue(options.defaultValue))}`];
    }
    return [`[${key}]`, `# (${schema === undefined ? 'no schema — passthrough' : 'schema uses transforms; see the owner file'})`];
  }

  // Object with named fields.
  if (isRecord(jsonSchema.properties) && Object.keys(jsonSchema.properties).length > 0) {
    const defaults = isRecord(options.defaultValue) ? options.defaultValue : {};
    const lines = [`[${key}]`];
    for (const [name, prop] of Object.entries(jsonSchema.properties)) {
      const fieldKey = camelToSnake(name);
      if (defaults[name] !== undefined) {
        lines.push(`${fieldKey} = ${truncate(toTomlValue(defaults[name]))}`);
        continue;
      }
      // A nested object field is an on-disk sub-table (`[section.field]`) —
      // render its own fields instead of a flat `field: object` comment.
      const resolved = resolveRef(prop, jsonSchema);
      const subProps = asJsonSchema(resolved)?.properties;
      if (isRecord(subProps) && Object.keys(subProps).length > 0) {
        lines.push('');
        lines.push(`# [${key}.${fieldKey}]`);
        lines.push(...renderFieldComments(subProps, jsonSchema, '  '));
        continue;
      }
      // An array-of-objects field carries its element fields inline.
      const itemProps = asJsonSchema(
        resolveRef(asJsonSchema(resolved)?.items, jsonSchema),
      )?.properties;
      if (isRecord(itemProps) && Object.keys(itemProps).length > 0) {
        lines.push(`# ${fieldKey}: object[] — one entry per item:`);
        lines.push(...renderFieldComments(itemProps, jsonSchema, '  '));
        continue;
      }
      lines.push(...renderFieldComments({ [name]: prop }, jsonSchema, ''));
    }
    return lines;
  }

  // Record section — one sub-table per entry.
  if (jsonSchema.additionalProperties !== undefined) {
    const valueSchema = resolveRef(jsonSchema.additionalProperties, jsonSchema);
    const valueProps = asJsonSchema(valueSchema)?.properties;
    const lines = [`[${key}]`];
    if (isRecord(valueProps) && Object.keys(valueProps).length > 0) {
      lines.push('');
      lines.push(`# one [${key}."<name>"] table per entry:`);
      lines.push(`# [${key}."<name>"]`);
      lines.push(...renderFieldComments(valueProps, jsonSchema, '  '));
    } else {
      lines.push(`# <name>: ${describeType(valueSchema)}`);
    }
    return lines;
  }

  // Array-of-tables section — one `[[section]]` entry per element. There is
  // no `[section]` parent table in TOML, so the whole shape stays commented;
  // emitting a bare `[${key}]` header would parse as a plain table, which
  // array sections (e.g. `hooks`) reject on load.
  if (jsonSchema.type === 'array') {
    const itemProps = asJsonSchema(resolveRef(jsonSchema.items, jsonSchema))?.properties;
    if (isRecord(itemProps) && Object.keys(itemProps).length > 0) {
      return [
        `# one [[${key}]] table per entry:`,
        `# [[${key}]]`,
        ...renderFieldComments(itemProps, jsonSchema, '  '),
      ];
    }
  }

  // Scalar / array section — a plain top-level key.
  if (options.defaultValue !== undefined) {
    return [`${key} = ${truncate(toTomlValue(options.defaultValue))}`];
  }
  return [`# ${key}: ${describeType(jsonSchema)}`];
}

function renderSection(section: ConfigSectionContribution, owner: string | undefined): string[] {
  const { domain, options } = section;
  const key = camelToSnake(domain);
  const lines: string[] = [RULE];
  lines.push(`# ${domain}${key === domain ? '' : ` (config.toml: ${key})`}`);
  lines.push(`#   owner: ${owner ?? '(unresolved)'}`);
  lines.push(`#   scope: ${options.scope ?? 'core'}`);
  const hooks: string[] = [];
  if (options.merge !== undefined) hooks.push('custom merge');
  if (options.fromToml !== undefined) hooks.push('custom fromToml');
  if (options.toToml !== undefined) hooks.push('custom toToml');
  if (options.stripEnv !== undefined) hooks.push('stripEnv');
  if (hooks.length > 0) lines.push(`#   hooks: ${hooks.join(' · ')}`);
  const envRows = flattenEnvBindings(options.env);
  if (envRows.length > 0) {
    lines.push('#   env:');
    for (const row of envRows) {
      lines.push(`#     ${snakePath(row.field)} <- ${row.env}${row.detail === '' ? '' : ` (${row.detail})`}`);
    }
  }
  lines.push(RULE);
  lines.push('');
  lines.push(...renderBody(section));
  return lines;
}

// ---------------------------------------------------------------------------
// Manifest rendering
// ---------------------------------------------------------------------------

export async function buildConfigManifest(): Promise<string> {
  // "import = register": loading the package root fills the contribution bags.
  await import('../src/index.ts');
  const sections = getConfigSectionContributions().toSorted((a, b) =>
    a.domain.localeCompare(b.domain),
  );
  const overlays = getConfigOverlayContributions();
  const sectionOwners = scanSectionOwners();
  const overlayOwners = scanOverlayOwners();

  const out: string[] = [
    '# Config Section Manifest',
    '#',
    '# Generated by scripts/gen-config-manifest.mts — do not edit by hand.',
    '# Regenerate with: pnpm --filter @moonshot-ai/agent-core-v2 gen:config-manifest',
    '#',
    '# One [table] per registered config section, in the on-disk config.toml shape',
    '# (snake_case keys). Un-commented assignments are registered defaults;',
    '# commented "# field: type" lines describe the remaining schema fields.',
    '# Values resolve as: default -> config.toml -> env overlay -> memory.',
    '',
    `# Index (${sections.length} sections · ${overlays.length} overlay(s))`,
  ];
  const width = Math.max(...sections.map((s) => s.domain.length));
  for (const { domain } of sections) {
    out.push(`#   ${domain.padEnd(width)}  ${sectionOwners.get(domain) ?? '(unresolved)'}`);
  }
  for (const [ident, file] of overlayOwners) {
    out.push(`#   ${'(overlay) ' + ident}  ${file}`);
  }
  out.push('');

  for (const section of sections) {
    out.push(...renderSection(section, sectionOwners.get(section.domain)));
    out.push('');
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const manifest = await buildConfigManifest();
  if (check) {
    let current: string | undefined;
    try {
      current = readFileSync(MANIFEST_PATH, 'utf-8');
    } catch {
      current = undefined;
    }
    if (current !== manifest) {
      console.error(
        `[gen-config-manifest] ${relative(process.cwd(), MANIFEST_PATH)} is stale. ` +
          'Regenerate with `pnpm --filter @moonshot-ai/agent-core-v2 gen:config-manifest`.',
      );
      process.exit(1);
    }
    console.log('[gen-config-manifest] up to date');
    return;
  }
  writeFileSync(MANIFEST_PATH, manifest);
  console.log(`[gen-config-manifest] wrote ${relative(process.cwd(), MANIFEST_PATH)}`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
