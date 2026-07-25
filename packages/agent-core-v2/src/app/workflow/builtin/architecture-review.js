export const meta = {
  name: 'architecture-review',
  description: 'Architecture review and dependency analysis — scans module structure, detects circular dependencies, measures coupling/cohesion, identifies layer violations, and generates architecture documentation.',
  whenToUse: 'Use when evaluating system architecture, detecting design decay, planning modularization, or onboarding new team members to the codebase.',
  phases: ['Scan', 'Dependency', 'Analyze', 'Document'],
};

// ── Tunables ──────────────────────────────────────────────────────
const MAX_FILES = 40; const MAX_LINES = 200; const MAX_DEPTH = 6;

// ── Structured output shapes ──────────────────────────────────────
const MODULE_MAP_SHAPE = {
  type: 'object', properties: {
    modules: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, type: { type: 'string', enum: ['entry', 'module', 'util', 'config', 'type', 'test', 'other'] }, exports_count: { type: 'number' }, imports: { type: 'array', items: { type: 'string' } }, loc: { type: 'number' } }, required: ['path', 'type', 'exports_count', 'imports', 'loc'] }, minItems: 1 },
    entry_points: { type: 'array', items: { type: 'string' } },
    layer_suggestion: { type: 'string' },
  }, required: ['modules', 'entry_points', 'layer_suggestion'],
};

const DEP_ANALYSIS_SHAPE = {
  type: 'object', properties: {
    circular_dependencies: { type: 'array', items: { type: 'array', items: { type: 'string' }, minItems: 2 } },
    hub_modules: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, fan_in: { type: 'number' }, fan_out: { type: 'number' }, instability: { type: 'number' } }, required: ['path', 'fan_in', 'fan_out', 'instability'] }, maxItems: 10 },
    layer_violations: { type: 'array', items: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, violation: { type: 'string' }, fix: { type: 'string' } }, required: ['from', 'to', 'violation', 'fix'] } },
  }, required: ['circular_dependencies', 'hub_modules', 'layer_violations'],
};

const ARCH_REVIEW_SHAPE = {
  type: 'object', properties: {
    rating: { type: 'string', enum: ['good', 'fair', 'needs-work', 'poor'] },
    strengths: { type: 'array', items: { type: 'string' } }, weaknesses: { type: 'array', items: { type: 'string' } },
    recommendations: { type: 'array', items: { type: 'string' } }, tech_debt_estimate: { type: 'string' },
    modularization_score: { type: 'number', description: '0-100, higher is better.' },
  }, required: ['rating', 'strengths', 'weaknesses', 'recommendations', 'tech_debt_estimate', 'modularization_score'],
};

const DOC_SHAPE = {
  type: 'object', properties: {
    title: { type: 'string' }, overview: { type: 'string' },
    layers: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, purpose: { type: 'string' }, modules: { type: 'array', items: { type: 'string' } }, rules: { type: 'array', items: { type: 'string' } } }, required: ['name', 'purpose', 'modules', 'rules'] } },
    data_flow: { type: 'string' }, decisions: { type: 'string' },
  }, required: ['title', 'overview', 'layers', 'data_flow', 'decisions'],
};

function truncate(content, maxLines) {
  const lines = content.split('\n');
  if (lines.length <= maxLines) return content;
  return lines.slice(0, maxLines).join('\n') + `\n// ... [${lines.length - maxLines} more lines]`;
}

// ── Main ──────────────────────────────────────────────────────────
const input = typeof args === 'string' ? { root: args } : (args || {});
const rootDir = input.root || '.';
const globPattern = input.glob || '**/*.{ts,js,tsx,jsx,mjs,cjs}';

phase('Scan');
let fileList;
try { fileList = await glob(globPattern); } catch { return { error: `Glob failed for pattern: ${globPattern}` }; }
if (!fileList || fileList.length === 0) return { error: `No files found matching: ${globPattern}` };

const selectedFiles = fileList.slice(0, MAX_FILES);
log(`Found ${fileList.length} files, analyzing ${selectedFiles.length}`);

const sources = [];
for (const p of selectedFiles) { try { const content = await readFile(p); sources.push({ path: p, content: truncate(content, MAX_LINES) }); } catch { log(`Cannot read: ${p}`); } }
const codeBlock = sources.map(s => `--- ${s.path} ---\n${s.content}`).join('\n\n');

const moduleMap = await agent(
  `You are a codebase mapper. Analyze these files and produce a module map.\n\nFiles:\n${codeBlock}\n\nFor each file: determine type (entry/module/util/config/type/test/other), exports count, imports, LOC. Identify entry points and suggest a layering.`,
  { schema: MODULE_MAP_SHAPE, label: 'mapper', phase: 'Scan' }
);
if (!moduleMap) return { error: 'Module mapping failed.' };
log(`Modules mapped: ${moduleMap.modules.length}`);

phase('Dependency');
const depAnalysis = await agent(
  `You are a dependency analyst. Analyze this module map for architectural issues.\n\nModule map:\n${JSON.stringify(moduleMap, null, 2)}\n\nSource:\n${codeBlock}\n\nIdentify circular dependencies, hub modules (fan-in/fan-out, instability), and layer violations based on: ${moduleMap.layer_suggestion}.`,
  { schema: DEP_ANALYSIS_SHAPE, label: 'dependency-analyst', phase: 'Dependency' }
);
log(`Circular deps: ${(depAnalysis && depAnalysis.circular_dependencies && depAnalysis.circular_dependencies.length) || 0}`);

phase('Analyze');
const archReview = await agent(
  `You are an architecture reviewer. Evaluate the overall architecture.\n\nModule map:\n${JSON.stringify(moduleMap, null, 2)}\n\nDependency analysis:\n${JSON.stringify(depAnalysis || {}, null, 2)}\n\nSource:\n${codeBlock}\n\nRate (good/fair/needs-work/poor), list strengths/weaknesses, recommendations, and modularization score (0-100).`,
  { schema: ARCH_REVIEW_SHAPE, label: 'architecture-reviewer', phase: 'Analyze' }
);

phase('Document');
const docs = await agent(
  `You are a technical writer. Generate architecture documentation.\n\nModule map:\n${JSON.stringify(moduleMap, null, 2)}\n\nDependency analysis:\n${JSON.stringify(depAnalysis || {}, null, 2)}\n\nArchitecture review:\n${JSON.stringify(archReview || {}, null, 2)}\n\nWrite: overview, layers with modules and rules, data flow, and architectural decisions.`,
  { schema: DOC_SHAPE, label: 'technical-writer', phase: 'Document' }
);

return {
  stats: { total_files: fileList.length, analyzed: sources.length, modules_mapped: moduleMap.modules.length, entry_points: moduleMap.entry_points, layer_suggestion: moduleMap.layer_suggestion },
  module_map: moduleMap.modules,
  dependency_analysis: depAnalysis || { circular_dependencies: [], hub_modules: [], layer_violations: [] },
  architecture_review: archReview || { rating: 'fair', strengths: [], weaknesses: [], recommendations: ['Run a full architecture review with human experts.'], tech_debt_estimate: 'Unknown', modularization_score: 50 },
  documentation: docs || { title: 'Architecture Overview', overview: 'Generated from automated analysis.', layers: [], data_flow: 'See architecture review.', decisions: 'See architecture review.' },
};