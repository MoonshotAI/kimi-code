export const meta = {
  name: 'refactor-planner',
  description: 'Refactoring impact analysis and step-by-step migration planner — analyzes code structure, identifies improvement opportunities, assesses risk, and generates a phased refactoring plan with rollback steps.',
  whenToUse: 'Use when the user wants to refactor a codebase, improve code structure, reduce technical debt, or prepare for a larger migration.',
  phases: ['Analyze', 'Identify', 'Assess', 'Plan'],
};

// ── Tunables ──────────────────────────────────────────────────────
const MAX_FILES = 20; const MAX_LINES = 250; const MAX_OPPORTUNITIES = 15;

// ── Structured output shapes ──────────────────────────────────────
const STRUCTURE_SHAPE = {
  type: 'object', properties: {
    modules: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, responsibilities: { type: 'string' }, loc: { type: 'number' }, dependencies: { type: 'array', items: { type: 'string' } } }, required: ['name', 'responsibilities', 'loc', 'dependencies'] } },
    patterns: { type: 'string' }, tech_debt: { type: 'string' },
  }, required: ['modules', 'patterns', 'tech_debt'],
};

const OPPORTUNITY_SHAPE = {
  type: 'array', items: {
    type: 'object', properties: {
      title: { type: 'string' }, category: { type: 'string', enum: ['extract-method', 'extract-module', 'rename', 'simplify', 'decouple', 'migrate-pattern', 'remove-dead', 'other'] },
      file: { type: 'string' }, lines: { type: 'string' }, current: { type: 'string' }, target: { type: 'string' },
      motivation: { type: 'string' }, effort: { type: 'string', enum: ['trivial', 'small', 'medium', 'large'] }, risk: { type: 'string', enum: ['low', 'medium', 'high'] },
    }, required: ['title', 'category', 'file', 'current', 'target', 'motivation', 'effort', 'risk'],
  }, minItems: 1, maxItems: MAX_OPPORTUNITIES,
};

const ASSESSMENT_SHAPE = {
  type: 'object', properties: {
    breaking_changes: { type: 'array', items: { type: 'object', properties: { description: { type: 'string' }, impact: { type: 'string', enum: ['low', 'medium', 'high'] }, affected_callers: { type: 'array', items: { type: 'string' } }, mitigation: { type: 'string' } }, required: ['description', 'impact', 'affected_callers', 'mitigation'] } },
    test_gap: { type: 'string' }, requires_migration: { type: 'boolean' }, risk_summary: { type: 'string' },
  }, required: ['breaking_changes', 'test_gap', 'requires_migration', 'risk_summary'],
};

const PLAN_SHAPE = {
  type: 'object', properties: {
    phases: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, steps: { type: 'array', items: { type: 'string' }, minItems: 1 }, verification: { type: 'string' }, rollback: { type: 'string' } }, required: ['name', 'steps', 'verification', 'rollback'] }, minItems: 1 },
    estimated_total_effort: { type: 'string' }, dependencies: { type: 'array', items: { type: 'string' } },
  }, required: ['phases', 'estimated_total_effort', 'dependencies'],
};

function truncate(content, maxLines) {
  const lines = content.split('\n');
  if (lines.length <= maxLines) return content;
  return lines.slice(0, maxLines).join('\n') + `\n// ... [${lines.length - maxLines} more lines]`;
}

// ── Main ──────────────────────────────────────────────────────────
const input = typeof args === 'string' ? { paths: args.split(',').map(s => s.trim()).filter(Boolean) } : (args || {});
const userPaths = Array.isArray(input.paths) ? input.paths : [];
const goal = input.goal || '';
if (userPaths.length === 0) return { error: 'No files specified. Pass file paths or a directory path as args.' };

phase('Analyze');
const sources = [];
for (const p of userPaths.slice(0, MAX_FILES)) { try { const content = await readFile(p); sources.push({ path: p, content: truncate(content, MAX_LINES) }); } catch { log(`Cannot read: ${p}`); } }
if (sources.length === 0) return { error: 'No files could be read.' };
const codeBlock = sources.map(s => `--- ${s.path} ---\n${s.content}`).join('\n\n');

const structure = await agent(
  `You are a software architect. Analyze these files and produce a structural overview.\n\n${goal ? `Refactoring goal: ${goal}\n\n` : ''}Files:\n${codeBlock}\n\nIdentify each module's responsibilities, dependencies, architectural patterns, and technical debt.`,
  { schema: STRUCTURE_SHAPE, label: 'architect', phase: 'Analyze' }
);
if (!structure) return { error: 'Structure analysis failed.' };
log(`Modules: ${structure.modules.length} | Tech debt: ${structure.tech_debt}`);

phase('Identify');
const opportunities = await agent(
  `You are a refactoring expert. Identify specific, concrete refactoring opportunities.\n\n${goal ? `Goal: ${goal}\n\n` : ''}Structure:\n${JSON.stringify(structure, null, 2)}\n\nSource code:\n${codeBlock}\n\nList specific, actionable refactoring opportunities with current code, target code, effort, and risk. Prioritize high-value, low-risk changes.`,
  { schema: OPPORTUNITY_SHAPE, label: 'refactoring-expert', phase: 'Identify' }
);
const opps = Array.isArray(opportunities) ? opportunities : (opportunities || []);
log(`Opportunities: ${opps.length}`);

phase('Assess');
const assessment = await agent(
  `You are a risk analyst. Assess the impact of these proposed changes.\n\nStructure:\n${JSON.stringify(structure, null, 2)}\n\nProposed changes:\n${JSON.stringify(opps, null, 2)}\n\nIdentify breaking changes, affected callers, test gaps, and overall risk.`,
  { schema: ASSESSMENT_SHAPE, label: 'risk-analyst', phase: 'Assess' }
);

phase('Plan');
const plan = await agent(
  `You are a migration planner. Create a phased refactoring plan.\n\n${goal ? `Goal: ${goal}\n\n` : ''}Structure:\n${JSON.stringify(structure, null, 2)}\n\nOpportunities:\n${JSON.stringify(opps.sort((a, b) => { const r = { low: 0, medium: 1, high: 2 }; const e = { trivial: 0, small: 1, medium: 2, large: 3 }; return (r[a.risk] - r[b.risk]) || (e[a.effort] - e[b.effort]); }), null, 2)}\n\nRisk assessment:\n${JSON.stringify(assessment || {}, null, 2)}\n\nCreate a phased plan: Phase 1 = safe low-risk, Phase 2 = medium-risk, Phase 3 = high-risk structural. Each phase must have verification and rollback.`,
  { schema: PLAN_SHAPE, label: 'planner', phase: 'Plan' }
);

return { structure, opportunities: opps, assessment: assessment || { breaking_changes: [], test_gap: 'Unknown', requires_migration: false, risk_summary: 'Assessment not available.' }, plan: plan || { phases: [{ name: 'Manual', steps: ['Review opportunities manually.'], verification: 'N/A', rollback: 'N/A' }], estimated_total_effort: 'Unknown', dependencies: [] } };