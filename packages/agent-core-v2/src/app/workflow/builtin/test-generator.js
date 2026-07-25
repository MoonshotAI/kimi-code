export const meta = {
  name: 'test-generator',
  description: 'Automated test generation — analyzes source files, identifies testworthy boundaries and edge cases, generates unit/integration test files, and writes them to disk.',
  whenToUse: 'Use when the user wants to generate tests for existing code, improve coverage, or add tests for a specific module.',
  phases: ['Analyze', 'Plan', 'Generate', 'Validate'],
};

// ── Tunables ──────────────────────────────────────────────────────
const MAX_SOURCES = 6; const MAX_LINES = 300; const COVERAGE_TARGET = 80;

// ── Structured output shapes ──────────────────────────────────────
const ANALYSIS_SHAPE = {
  type: 'object',
  properties: {
    test_framework: { type: 'string', description: 'Detected or recommended test framework (vitest, jest, mocha, pytest, etc.).' },
    source_files: { type: 'array', items: { type: 'string' }, description: 'Source files that need tests.', minItems: 1 },
    functions: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, type: { type: 'string', enum: ['function', 'method', 'arrow', 'async', 'generator'] }, complexity: { type: 'string', enum: ['simple', 'moderate', 'complex'] }, has_tests: { type: 'boolean' }, risk: { type: 'string', enum: ['low', 'medium', 'high'] } }, required: ['name', 'type', 'complexity', 'has_tests', 'risk'] } },
  },
  required: ['test_framework', 'source_files', 'functions'],
};

const PLAN_SHAPE = {
  type: 'object',
  properties: {
    test_file_map: { type: 'object', additionalProperties: { type: 'string' }, description: 'Map of source path -> test file path.' },
    test_cases: { type: 'array', items: { type: 'object', properties: { target: { type: 'string' }, type: { type: 'string', enum: ['unit', 'integration'] }, scenarios: { type: 'array', items: { type: 'string' }, minItems: 2 }, edge_cases: { type: 'array', items: { type: 'string' }, minItems: 1 } }, required: ['target', 'type', 'scenarios', 'edge_cases'] }, minItems: 1 },
  },
  required: ['test_file_map', 'test_cases'],
};

const TEST_OUTPUT_SHAPE = {
  type: 'object', properties: { files: { type: 'object', additionalProperties: { type: 'string' }, description: 'Map of test file path -> full file content.' }, warnings: { type: 'array', items: { type: 'string' } } }, required: ['files', 'warnings'],
};

const VALIDATION_SHAPE = {
  type: 'object', properties: { issues: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, issue: { type: 'string' }, severity: { type: 'string', enum: ['error', 'warning', 'info'] } }, required: ['file', 'issue', 'severity'] } }, coverage_estimate: { type: 'string' }, ready: { type: 'boolean' }, summary: { type: 'string' } }, required: ['issues', 'coverage_estimate', 'ready', 'summary'],
};

function truncateSource(content, maxLines) {
  const lines = content.split('\n');
  if (lines.length <= maxLines) return content;
  return lines.slice(0, maxLines).join('\n') + `\n// ... [${lines.length - maxLines} more lines]`;
}

// ── Main ──────────────────────────────────────────────────────────
const input = typeof args === 'string' ? { paths: args.split(',').map(s => s.trim()).filter(Boolean) } : (args || {});
const userPaths = Array.isArray(input.paths) ? input.paths : [];
const framework = input.framework || '';
if (userPaths.length === 0) return { error: 'No source files specified. Pass file paths as args, e.g. "src/utils.ts,src/api.ts".' };

phase('Analyze');
const sources = [];
for (const p of userPaths.slice(0, MAX_SOURCES)) {
  try { const content = await readFile(p); sources.push({ path: p, content: truncateSource(content, MAX_LINES) }); } catch { log(`Skipping unreadable: ${p}`); }
}
if (sources.length === 0) return { error: 'None of the specified source files could be read.' };
const codeBlock = sources.map(s => `--- ${s.path} ---\n${s.content}`).join('\n\n');

const analysis = await agent(
  `You are a test analyst. Analyze these source files and identify: 1. Which test framework is used or should be used (${framework ? `prefer: ${framework}` : 'detect from imports'}) 2. Each exported function/method, its complexity, and whether it already has tests 3. Risk level based on complexity and dependencies\n\nSource files:\n${codeBlock}`,
  { schema: ANALYSIS_SHAPE, label: 'analyzer', phase: 'Analyze' }
);
if (!analysis) return { error: 'Analysis failed.' };
log(`Framework: ${analysis.test_framework} | Functions: ${analysis.functions.length} | Untested: ${analysis.functions.filter(f => !f.has_tests).length}`);

phase('Plan');
const plan = await agent(
  `You are a test planner. Based on this analysis, create a test plan.\n\nFramework: ${analysis.test_framework}\n\nFunctions:\n${JSON.stringify(analysis.functions, null, 2)}\n\nFor each source file, decide the test file path, test cases (happy path, error, edge). Aim for ${COVERAGE_TARGET}%+ coverage on high-risk functions.`,
  { schema: PLAN_SHAPE, label: 'planner', phase: 'Plan' }
);
if (!plan || !plan.test_cases || plan.test_cases.length === 0) return { error: 'Test planning failed.', analysis };

phase('Generate');
const testGen = await agent(
  `You are a test code generator. Generate complete, working test files.\n\nFramework: ${analysis.test_framework}\n\nSource files:\n${codeBlock}\n\nTest plan:\n${JSON.stringify(plan, null, 2)}\n\nFor each test file: write proper describe/it blocks, cover happy paths, error cases, and edge cases. Use proper mocks where needed. Return a map of test file paths to full file content.`,
  { schema: TEST_OUTPUT_SHAPE, label: 'generator', phase: 'Generate' }
);
if (!testGen || !testGen.files || Object.keys(testGen.files).length === 0) return { error: 'Test generation failed.', analysis, plan };

const written = [];
for (const [testPath, content] of Object.entries(testGen.files)) {
  try { await writeFile(testPath, content); written.push(testPath); } catch (e) { log(`Failed to write ${testPath}: ${e}`); }
}
log(`Written: ${written.length} test files`);

phase('Validate');
const validation = await agent(
  `You are a test validator. Review these generated tests.\n\nSource files:\n${codeBlock}\n\nTests:\n${JSON.stringify(testGen.files, null, 2)}\n\nCheck: imports reference real exports? Edge cases covered? Any syntax/logic errors? Estimated coverage ${COVERAGE_TARGET}%+?`,
  { schema: VALIDATION_SHAPE, label: 'validator', phase: 'Validate' }
);

return { analysis: { framework: analysis.test_framework, functions: analysis.functions }, plan: { test_file_map: plan.test_file_map, test_cases: plan.test_cases }, generated: { files: Object.keys(testGen.files), warnings: testGen.warnings || [] }, written, validation: validation || { issues: [], coverage_estimate: 'unknown', ready: true, summary: 'Validation skipped.' } };