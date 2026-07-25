export const meta = {
  name: 'bug-triage',
  description: 'Automated bug triage — analyzes error logs, stack traces, and source code to identify root causes, assess severity, and suggest fixes with reproduction steps.',
  whenToUse: 'Use when encountering bugs, crashes, test failures, or error reports. Provide error messages, stack traces, or log files as input.',
  phases: ['Parse', 'Search', 'Analyze', 'Fix', 'Report'],
};

// ── Tunables ──────────────────────────────────────────────────────
const MAX_LOG_LINES = 400; const MAX_CODE_LINES = 200; const MAX_SUSPECT_FILES = 8;

// ── Structured output shapes ──────────────────────────────────────
const PARSE_SHAPE = {
  type: 'object', properties: {
    error_type: { type: 'string' }, error_message: { type: 'string' },
    stack_trace: { type: 'string' }, suspect_files: { type: 'array', items: { type: 'string' }, maxItems: MAX_SUSPECT_FILES },
    environment: { type: 'string' }, reproducible: { type: 'boolean' },
  }, required: ['error_type', 'error_message', 'stack_trace', 'suspect_files', 'reproducible'],
};

const ROOT_CAUSE_SHAPE = {
  type: 'object', properties: {
    root_cause: { type: 'string' }, category: { type: 'string', enum: ['null-ref', 'type-error', 'race-condition', 'resource-leak', 'config-error', 'logic-error', 'api-change', 'dependency', 'environment', 'other'] },
    code_snippet: { type: 'string' }, why_happens: { type: 'string' }, trigger_condition: { type: 'string' },
  }, required: ['root_cause', 'category', 'code_snippet', 'why_happens', 'trigger_condition'],
};

const FIX_SHAPE = {
  type: 'object', properties: {
    fix_description: { type: 'string' }, fix_code: { type: 'string' }, file: { type: 'string' },
    side_effects: { type: 'string' }, requires_test_update: { type: 'boolean' }, workaround: { type: 'string' },
  }, required: ['fix_description', 'fix_code', 'file', 'side_effects', 'requires_test_update'],
};

const REPORT_SHAPE = {
  type: 'object', properties: {
    severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    summary: { type: 'string' }, reproduction_steps: { type: 'array', items: { type: 'string' } },
    related_patterns: { type: 'array', items: { type: 'string' } },
  }, required: ['severity', 'confidence', 'summary', 'reproduction_steps'],
};

// ── Main ──────────────────────────────────────────────────────────
const input = typeof args === 'string' ? { error: args } : (args || {});
const errorInput = input.error || '';
let logContent = '';
if (input.log_file) {
  try { logContent = await readFile(input.log_file); } catch { return { error: `Could not read log file: ${input.log_file}` }; }
} else if (errorInput) { logContent = errorInput; } else { return { error: 'No error input provided. Pass error text, log_file path, or error string.' }; }

const truncatedLog = logContent.split('\n').slice(0, MAX_LOG_LINES).join('\n');
if (logContent.split('\n').length > MAX_LOG_LINES) log(`Log truncated to ${MAX_LOG_LINES} lines`);

phase('Parse');
const parsed = await agent(
  `You are a bug triage analyst. Parse this error report and extract the key information.\n\nError report:\n${truncatedLog}\n\nExtract the error type, message, stack trace, suspect files, and environment context.`,
  { schema: PARSE_SHAPE, label: 'parser', phase: 'Parse' }
);
if (!parsed) return { error: 'Failed to parse error report.' };
log(`Error: ${parsed.error_type} | Suspect files: ${parsed.suspect_files.length}`);

phase('Search');
const suspectCode = [];
for (const filePath of (parsed.suspect_files || []).slice(0, MAX_SUSPECT_FILES)) {
  try { const content = await readFile(filePath); suspectCode.push({ path: filePath, content: content.split('\n').slice(0, MAX_CODE_LINES).join('\n') }); } catch { log(`Could not read suspect file: ${filePath}`); }
}
const codeBlock = suspectCode.map(s => `--- ${s.path} ---\n${s.content}`).join('\n\n');

phase('Analyze');
const rootCause = await agent(
  `You are a root cause analyst. Analyze this error against the source code.\n\nError:\n${JSON.stringify(parsed, null, 2)}\n\nSource code:\n${codeBlock}\n\n${!suspectCode.length ? 'NOTE: No suspect files could be read. Analyze based on the error alone.\n' : ''}Identify the root cause with code snippet, category, why it happens, and trigger condition.`,
  { schema: ROOT_CAUSE_SHAPE, label: 'root-cause-analyst', phase: 'Analyze' }
);
if (!rootCause) return { error: 'Root cause analysis failed.', parsed };

phase('Fix');
const fix = await agent(
  `You are a fix engineer. Generate a fix for this bug.\n\nError:\n${JSON.stringify(parsed, null, 2)}\n\nRoot cause:\n${JSON.stringify(rootCause, null, 2)}\n\nSource code:\n${codeBlock}\n\n${!suspectCode.length ? 'NOTE: Source code unavailable. Provide a general fix strategy.' : ''}Produce a concrete fix: file path, corrected code, side effects, and workaround.`,
  { schema: FIX_SHAPE, label: 'fix-engineer', phase: 'Fix' }
);

phase('Report');
const report = await agent(
  `You are a bug report writer. Write a concise bug triage report.\n\nError: ${parsed.error_type}: ${parsed.error_message}\n\nRoot cause: ${rootCause.root_cause}\n\nCategory: ${rootCause.category}\n\nFix: ${fix ? fix.fix_description : 'No fix generated'}\n\nWrite a summary with severity, confidence, reproduction steps, and related patterns.`,
  { schema: REPORT_SHAPE, label: 'reporter', phase: 'Report' }
);

return {
  parsed: { error_type: parsed.error_type, error_message: parsed.error_message, suspect_files: parsed.suspect_files, reproducible: parsed.reproducible },
  root_cause: rootCause,
  fix: fix || { fix_description: 'Manual review required.', fix_code: '', file: '', side_effects: 'Unknown', requires_test_update: false, workaround: '' },
  report: report || { severity: 'medium', confidence: 'medium', summary: `Bug triage completed for ${parsed.error_type}.`, reproduction_steps: parsed.reproducible ? ['See stack trace.'] : ['Reproduction conditions unknown.'] },
  suspect_source: suspectCode.map(s => s.path),
};