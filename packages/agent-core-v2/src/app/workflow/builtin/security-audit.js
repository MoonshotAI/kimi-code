export const meta = {
  name: 'security-audit',
  description: 'Security vulnerability audit — scans source files for OWASP Top 10 categories, hardcoded secrets, injection points, auth flaws, and dependency risks, producing a prioritized remediation plan.',
  whenToUse: 'Use when auditing code for security vulnerabilities, before deploying to production, or when onboarding a security review process.',
  phases: ['Identify', 'Inspect', 'Analyze', 'Report'],
};

// ── Tunables ──────────────────────────────────────────────────────
const MAX_FILES = 20; const MAX_LINES = 250;

// ── Structured output shapes ──────────────────────────────────────
const INVENTORY_SHAPE = {
  type: 'object', properties: {
    target_files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, risk_exposure: { type: 'string', enum: ['high', 'medium', 'low', 'none'] }, reasons: { type: 'array', items: { type: 'string' } } }, required: ['path', 'risk_exposure', 'reasons'] }, minItems: 1 },
    dependencies: { type: 'array', items: { type: 'string' } },
  }, required: ['target_files', 'dependencies'],
};

const FINDING_SHAPE = {
  type: 'array', items: {
    type: 'object', properties: {
      owasp_category: { type: 'string', enum: ['A01-broken-access-control', 'A02-cryptographic-failure', 'A03-injection', 'A04-insecure-design', 'A05-security-misconfiguration', 'A06-vulnerable-components', 'A07-auth-failure', 'A08-integrity-failure', 'A09-logging-monitoring', 'A10-ssrf', 'secret-leak', 'supply-chain', 'other'] },
      file: { type: 'string' }, line: { type: 'number' },
      severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
      title: { type: 'string' }, description: { type: 'string' },
      vulnerable_code: { type: 'string' }, fix: { type: 'string' },
      cwe: { type: 'string' }, exploit_scenario: { type: 'string' },
    }, required: ['owasp_category', 'file', 'severity', 'title', 'description', 'fix'],
  },
};

const REMEDIATION_SHAPE = {
  type: 'object', properties: {
    critical_count: { type: 'number' }, high_count: { type: 'number' }, medium_count: { type: 'number' }, low_count: { type: 'number' },
    immediate_actions: { type: 'array', items: { type: 'string' } },
    remediation_plan: { type: 'array', items: { type: 'object', properties: { priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] }, action: { type: 'string' }, effort: { type: 'string', enum: ['minutes', 'hours', 'days', 'weeks'] } }, required: ['priority', 'action', 'effort'] } },
    secure_config_notes: { type: 'string' }, summary: { type: 'string' }, overall_risk: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
  }, required: ['critical_count', 'high_count', 'medium_count', 'low_count', 'immediate_actions', 'remediation_plan', 'summary', 'overall_risk'],
};

// ── Main ──────────────────────────────────────────────────────────
const input = typeof args === 'string' ? { paths: args.split(',').map(s => s.trim()).filter(Boolean) } : (args || {});
let fileList = [];
if (Array.isArray(input.paths) && input.paths.length > 0) {
  fileList = input.paths;
} else if (input.glob) {
  try { fileList = await glob(input.glob); } catch { return { error: `Glob failed: ${input.glob}` }; }
} else {
  try {
    const candidates = await glob('**/*.{ts,js,tsx,jsx,py,java,go,rs,rb,php,c,cpp}');
    fileList = candidates.filter(p => !p.startsWith('node_modules/') && !p.startsWith('.git/') && !p.startsWith('dist/') && !p.startsWith('build/') && !p.startsWith('target/')).slice(0, MAX_FILES);
  } catch { return { error: 'No files specified and auto-detect failed.' }; }
}
if (fileList.length === 0) return { error: 'No files to audit.' };

const selectedFiles = fileList.slice(0, MAX_FILES);
log(`Files to audit: ${selectedFiles.length}`);

phase('Identify');
const sources = [];
for (const p of selectedFiles) { try { const content = await readFile(p); sources.push({ path: p, content: content.split('\n').slice(0, MAX_LINES).join('\n') }); } catch { log(`Cannot read: ${p}`); } }
const codeBlock = sources.map(s => `--- ${s.path} ---\n${s.content}`).join('\n\n');

let depContent = '';
try { depContent = await readFile('package.json'); } catch {}
try { if (!depContent) depContent = await readFile('Cargo.toml'); } catch {}
try { if (!depContent) depContent = await readFile('requirements.txt'); } catch {}

const inventory = await agent(
  `You are a security auditor. Review files for security risk exposure.\n\nFiles:\n${codeBlock}\n\n${depContent ? `Dependencies:\n${depContent}` : 'No manifest found.'}\n\nFor each file, assess risk exposure (high/medium/low/none) based on what it does (user input, auth, network, file system, crypto). List key dependencies.`,
  { schema: INVENTORY_SHAPE, label: 'inventory-analyst', phase: 'Identify' }
);
if (!inventory) return { error: 'Security inventory failed.' };
log(`High-risk files: ${inventory.target_files.filter(f => f.risk_exposure === 'high').length}`);

phase('Inspect');
const findings = await agent(
  `You are a security auditor. Perform a deep security audit.\n\nCheck: A01-A10 OWASP categories, hardcoded secrets, injection, IDOR, missing validation, insecure deserialization, prototype pollution.\n\nFiles:\n${codeBlock}\n\nFor each finding: OWASP category, file, line, severity, title, description, vulnerable code, fix, CWE, exploit scenario.`,
  { schema: FINDING_SHAPE, label: 'deep-inspector', phase: 'Inspect' }
);
const findingsList = Array.isArray(findings) ? findings : (findings && findings.findings ? findings.findings : []);
log(`Findings: ${findingsList.length}`);

phase('Analyze');
const severityOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
findingsList.sort((a, b) => (severityOrder[a.severity] ?? 9) - (severityOrder[b.severity] ?? 9));

phase('Report');
const remediation = await agent(
  `You are a security remediation planner. Create a prioritized remediation plan.\n\nInventory:\n${JSON.stringify(inventory, null, 2)}\n\nFindings:\n${JSON.stringify(findingsList, null, 2)}\n\n${depContent ? `Dependencies:\n${depContent}` : ''}\n\nCreate severity counts, immediate actions, prioritized plan, secure config notes, overall risk assessment.`,
  { schema: REMEDIATION_SHAPE, label: 'remediation-planner', phase: 'Report' }
);

return {
  inventory: { files: inventory.target_files, dependencies: inventory.dependencies },
  findings: findingsList,
  remediation: remediation || {
    critical_count: findingsList.filter(f => f.severity === 'critical').length, high_count: findingsList.filter(f => f.severity === 'high').length,
    medium_count: findingsList.filter(f => f.severity === 'medium').length, low_count: findingsList.filter(f => f.severity === 'low').length,
    immediate_actions: ['Review findings manually.'], remediation_plan: [],
    summary: `Security audit found ${findingsList.length} issues.`, overall_risk: findingsList.some(f => f.severity === 'critical' || f.severity === 'high') ? 'high' : 'medium',
  },
};