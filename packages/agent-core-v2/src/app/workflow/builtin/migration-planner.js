export const meta = {
  name: 'migration-planner',
  description: 'Migration and upgrade planner — analyzes current dependency versions, identifies breaking changes, maps required code changes, and generates a phased migration plan with compatibility shims and rollback strategies.',
  whenToUse: 'Use when upgrading major framework/library versions, migrating between build tools, or planning large-scale dependency updates.',
  phases: ['Inventory', 'Diff', 'Map', 'Plan'],
};

// ── Tunables ──────────────────────────────────────────────────────
const MAX_FILES = 20; const MAX_LINES = 200;

// ── Structured output shapes ──────────────────────────────────────
const INVENTORY_SHAPE = {
  type: 'object', properties: {
    deps: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, current: { type: 'string' }, target: { type: 'string' }, type: { type: 'string', enum: ['prod', 'dev', 'peer'] }, changelog_url: { type: 'string' }, breaking: { type: 'boolean' } }, required: ['name', 'current', 'target', 'type', 'breaking'] }, minItems: 1 },
    migration_scope: { type: 'string', description: 'Overall scope of the migration.' },
    risk_level: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
  }, required: ['deps', 'migration_scope', 'risk_level'],
};

const BREAKING_CHANGES_SHAPE = {
  type: 'array', items: {
    type: 'object', properties: {
      dep: { type: 'string' }, change: { type: 'string', description: 'What changed in the new version.' },
      impact: { type: 'string', enum: ['low', 'medium', 'high'] },
      pattern: { type: 'string', description: 'Code pattern to search for (e.g. "oldApi(", "import from \'old-module\'").' },
      codemod: { type: 'string', description: 'How to update the code.' },
      files_affected: { type: 'array', items: { type: 'string' } },
    }, required: ['dep', 'change', 'impact', 'pattern', 'codemod', 'files_affected'],
  }, minItems: 1,
};

const MIGRATION_MAP_SHAPE = {
  type: 'object', properties: {
    files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, changes: { type: 'array', items: { type: 'object', properties: { lines: { type: 'string' }, original: { type: 'string' }, replacement: { type: 'string' }, reason: { type: 'string' } }, required: ['lines', 'original', 'replacement', 'reason'] } }, effort: { type: 'string', enum: ['trivial', 'small', 'medium', 'large'] } }, required: ['path', 'changes', 'effort'] }, minItems: 1 },
    untouched_files: { type: 'array', items: { type: 'string' } },
  }, required: ['files', 'untouched_files'],
};

const MIGRATION_PLAN_SHAPE = {
  type: 'object', properties: {
    phases: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, steps: { type: 'array', items: { type: 'string' }, minItems: 1 }, verification: { type: 'string' }, rollback: { type: 'string' }, estimated_time: { type: 'string' } }, required: ['name', 'steps', 'verification', 'rollback', 'estimated_time'] }, minItems: 1 },
    compatibility_shims: { type: 'array', items: { type: 'string' }, description: 'Temporary compatibility shims needed.' },
    test_strategy: { type: 'string' }, total_estimated_time: { type: 'string' },
    precautions: { type: 'array', items: { type: 'string' } },
  }, required: ['phases', 'compatibility_shims', 'test_strategy', 'total_estimated_time', 'precautions'],
};

function truncate(content, maxLines) {
  const lines = content.split('\n');
  if (lines.length <= maxLines) return content;
  return lines.slice(0, maxLines).join('\n') + `\n// ... [${lines.length - maxLines} more lines]`;
}

// ── Main ──────────────────────────────────────────────────────────
const input = typeof args === 'string' ? { deps: args.split(',').map(s => s.trim()).filter(Boolean) } : (args || {});
const depTargets = Array.isArray(input.deps) ? input.deps : [];
const targetVersions = input.targets || {};
const globPattern = input.glob || '**/*.{ts,js,tsx,jsx,mjs,cjs,mts,cts}';

if (depTargets.length === 0) {
  return { error: 'No migration targets specified. Pass dependency names as args, e.g. "react@19,vue@4" or {"deps":["react@19"],"targets":{"react":"19.0.0"}}.' };
}

// Phase 1: Inventory
phase('Inventory');

// Read current dependency manifests
let pkgContent = '';
try { pkgContent = await readFile('package.json'); } catch { log('No package.json found'); }
let cargoContent = '';
try { cargoContent = await readFile('Cargo.toml'); } catch {}

const manifestBlock = [pkgContent ? `package.json:\n${pkgContent}` : '', cargoContent ? `Cargo.toml:\n${cargoContent}` : ''].filter(Boolean).join('\n\n');

const inventory = await agent(
  `You are a migration analyst. Analyze the migration targets against the current dependency manifests.\n\nTargets: ${depTargets.join(', ')}\n\n${targetVersions ? `Target versions: ${JSON.stringify(targetVersions)}\n\n` : ''}Manifests:\n${manifestBlock}\n\nList each dependency to migrate, its current version, target version, whether it's breaking, and the overall migration scope and risk.`,
  { schema: INVENTORY_SHAPE, label: 'inventory-analyst', phase: 'Inventory' }
);
if (!inventory) return { error: 'Inventory analysis failed.' };
log(`Deps to migrate: ${inventory.deps.length} | Risk: ${inventory.risk_level}`);

// Attempt to find source files that use these dependencies
let candidateFiles;
try { candidateFiles = await glob(globPattern); } catch { candidateFiles = []; }
const relevantFiles = candidateFiles
  .filter(p => !p.startsWith('node_modules/') && !p.startsWith('.git/') && !p.startsWith('dist/') && !p.startsWith('build/') && !p.startsWith('target/'))
  .slice(0, MAX_FILES);

const sources = [];
for (const p of relevantFiles) { try { const content = await readFile(p); sources.push({ path: p, content: truncate(content, MAX_LINES) }); } catch {} }
const codeBlock = sources.map(s => `--- ${s.path} ---\n${s.content}`).join('\n\n');

// Phase 2: Identify breaking changes
phase('Diff');
const breakingChanges = await agent(
  `You are a migration expert. Identify breaking changes between current and target versions.\n\nMigration targets:\n${JSON.stringify(inventory.deps, null, 2)}\n\nSource code using these dependencies:\n${codeBlock}\n\nFor each dependency, identify specific breaking changes, the code pattern to search for, how to update it, and which files are affected.`,
  { schema: BREAKING_CHANGES_SHAPE, label: 'breaking-change-analyst', phase: 'Diff' }
);
const breakingList = Array.isArray(breakingChanges) ? breakingChanges : (breakingChanges || []);
log(`Breaking changes identified: ${breakingList.length}`);

// Phase 3: Code change map
phase('Map');
const migrationMap = await agent(
  `You are a migration engineer. Map concrete code changes needed for each file.\n\nMigration targets:\n${JSON.stringify(inventory.deps, null, 2)}\n\nBreaking changes:\n${JSON.stringify(breakingList, null, 2)}\n\nSource code:\n${codeBlock}\n\nFor each source file, list specific line changes: original code, replacement code, and reason. Mark files that need no changes.`,
  { schema: MIGRATION_MAP_SHAPE, label: 'migration-engineer', phase: 'Map' }
);

// Phase 4: Migration plan
phase('Plan');
const migrationPlan = await agent(
  `You are a migration planner. Create a detailed phased migration plan.\n\nScope: ${inventory.migration_scope}\nRisk: ${inventory.risk_level}\n\nTargets:\n${JSON.stringify(inventory.deps, null, 2)}\n\nBreaking changes:\n${JSON.stringify(breakingList, null, 2)}\n\nCode changes:\n${JSON.stringify(migrationMap || {}, null, 2)}\n\nCreate a phased plan: Phase 1 = preparation (backup, test infra), Phase 2 = safe changes (deprecation-shielded), Phase 3 = breaking changes, Phase 4 = cleanup (remove shims). Include compatibility shims, test strategy, and precautions.`,
  { schema: MIGRATION_PLAN_SHAPE, label: 'migration-planner', phase: 'Plan' }
);

return {
  inventory: { deps: inventory.deps, migration_scope: inventory.migration_scope, risk_level: inventory.risk_level },
  breaking_changes: breakingList,
  migration_map: migrationMap || { files: [], untouched_files: [] },
  plan: migrationPlan || { phases: [{ name: 'Manual', steps: ['Review breaking changes manually.'], verification: 'N/A', rollback: 'N/A', estimated_time: 'Unknown' }], compatibility_shims: [], test_strategy: 'Manual testing recommended.', total_estimated_time: 'Unknown', precautions: ['Back up your codebase before starting.'] },
  manifests: { has_package_json: !!pkgContent, has_cargo_toml: !!cargoContent },
};