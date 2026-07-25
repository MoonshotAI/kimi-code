export const meta = {
  name: 'code-review',
  description: 'Multi-dimensional code review — runs parallel security, performance, correctness, and maintainability reviews, then produces a consolidated report with severity-ranked findings.',
  whenToUse: 'Use when the user wants a thorough, multi-perspective code review on a set of files, a diff, or a pull request.',
  phases: ['Analyze', 'Security', 'Performance', 'Correctness', 'Maintainability', 'Report'],
};

// ── Tunables ──────────────────────────────────────────────────────
const FILE_BUDGET = 12;
const MAX_LINES_PER_FILE = 200;

// ── Structured output shapes ──────────────────────────────────────
const SCOPE_SHAPE = {
  type: 'object',
  properties: {
    files: { type: 'array', items: { type: 'string' }, description: 'File paths to review, relative to workspace root.', minItems: 1, maxItems: FILE_BUDGET },
    context: { type: 'string', description: 'Project language / framework context gleaned from the files.' },
  },
  required: ['files', 'context'],
};

const REVIEW_SHAPE = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
          file: { type: 'string' }, line: { type: 'number' },
          title: { type: 'string' }, description: { type: 'string' },
          impact: { type: 'string' }, suggestion: { type: 'string' },
        },
        required: ['severity', 'file', 'title', 'description', 'suggestion'],
      },
      minItems: 1,
    },
    summary: { type: 'string', description: 'One-paragraph summary of findings in this dimension.' },
  },
  required: ['findings', 'summary'],
};

const REPORT_SHAPE = {
  type: 'object',
  properties: {
    overall_rating: { type: 'string', enum: ['pass', 'needs-work', 'fail'] },
    critical_count: { type: 'number' }, high_count: { type: 'number' },
    medium_count: { type: 'number' }, low_count: { type: 'number' },
    top_issues: { type: 'array', items: { type: 'string' }, maxItems: 5 },
    recommendations: { type: 'array', items: { type: 'string' }, minItems: 2 },
    summary: { type: 'string' },
  },
  required: ['overall_rating', 'critical_count', 'high_count', 'medium_count', 'low_count', 'top_issues', 'recommendations', 'summary'],
};

// ── Helpers ───────────────────────────────────────────────────────
function truncateFile(content, maxLines) {
  const lines = content.split('\n');
  if (lines.length <= maxLines) return content;
  return lines.slice(0, maxLines).join('\n') + `\n// ... [${lines.length - maxLines} more lines truncated]`;
}

// ── Main ──────────────────────────────────────────────────────────
const input = typeof args === 'string' ? { paths: args.split(',').map(s => s.trim()).filter(Boolean) } : (args || {});
const rawPaths = Array.isArray(input.paths) ? input.paths : [];
if (rawPaths.length === 0) {
  return { error: 'No file paths provided. Pass comma-separated paths or a glob pattern as args.' };
}

phase('Analyze');
const fileContents = [];
for (const p of rawPaths.slice(0, FILE_BUDGET)) {
  try {
    const content = await readFile(p);
    fileContents.push({ path: p, content: truncateFile(content, MAX_LINES_PER_FILE) });
  } catch { log(`Could not read: ${p}`); }
}
if (fileContents.length === 0) return { error: 'None of the specified files could be read.' };

const codeMap = fileContents.map(f => `--- ${f.path} ---\n${f.content}`).join('\n\n');
const scope = await agent(
  `You are a code review coordinator. Analyze the following files to determine the project context and confirm which files are relevant for review.\n\nFiles:\n${codeMap}\n\nReturn the file list and a brief context string.`,
  { schema: SCOPE_SHAPE, label: 'scope-analyzer', phase: 'Analyze' }
);
const filesToReview = (scope && scope.files) || fileContents.map(f => f.path);
const context = (scope && scope.context) || 'Unknown project context';
log(`Context: ${context} | Files: ${filesToReview.length}`);

phase('Security');
const securityReview = await agent(
  `You are a SECURITY reviewer. Review these files for injection vulnerabilities, auth flaws, hardcoded secrets, insecure deserialization, path traversal, and known vulnerable patterns.\n\nProject context: ${context}\n\nFiles:\n${codeMap}\n\nFor each finding, provide severity, file, line, title, description, impact, and a concrete fix suggestion.`,
  { schema: REVIEW_SHAPE, label: 'security-reviewer', phase: 'Security' }
);

phase('Performance');
const perfReview = await agent(
  `You are a PERFORMANCE reviewer. Review these files for N+1 queries, unnecessary allocations, sync blocking in async paths, large serialization overhead, cache-miss patterns, and algorithmic inefficiency.\n\nProject context: ${context}\n\nFiles:\n${codeMap}\n\nFor each finding, provide severity, file, line, title, description, impact, and a concrete fix suggestion.`,
  { schema: REVIEW_SHAPE, label: 'performance-reviewer', phase: 'Performance' }
);

phase('Correctness');
const correctnessReview = await agent(
  `You are a CORRECTNESS reviewer. Review these files for race conditions, off-by-one errors, null/undefined dereferences, type mismatches, incorrect error handling, and logic errors.\n\nProject context: ${context}\n\nFiles:\n${codeMap}\n\nFor each finding, provide severity, file, line, title, description, impact, and a concrete fix suggestion.`,
  { schema: REVIEW_SHAPE, label: 'correctness-reviewer', phase: 'Correctness' }
);

phase('Maintainability');
const maintainabilityReview = await agent(
  `You are a MAINTAINABILITY reviewer. Review these files for code duplication, high cyclomatic complexity, poor naming, missing comments, deep nesting, and tight coupling.\n\nProject context: ${context}\n\nFiles:\n${codeMap}\n\nFor each finding, provide severity, file, line, title, description, impact, and a concrete fix suggestion.`,
  { schema: REVIEW_SHAPE, label: 'maintainability-reviewer', phase: 'Maintainability' }
);

phase('Report');
const allFindings = [
  ...((securityReview && securityReview.findings) || []),
  ...((perfReview && perfReview.findings) || []),
  ...((correctnessReview && correctnessReview.findings) || []),
  ...((maintainabilityReview && maintainabilityReview.findings) || []),
];
if (allFindings.length === 0) {
  return { files: filesToReview, context, overall_rating: 'pass', critical_count: 0, high_count: 0, medium_count: 0, low_count: 0, findings: [], summary: 'No issues found by any reviewer dimension.', recommendations: ['Consider adding automated linting tools to catch issues earlier.'] };
}

const severityOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
allFindings.sort((a, b) => (severityOrder[a.severity] ?? 9) - (severityOrder[b.severity] ?? 9));

const report = await agent(
  `You are a review coordinator. Consolidate these findings from 4 review dimensions into a final report.\n\nProject context: ${context}\n\nFiles reviewed: ${filesToReview.join(', ')}\n\nAll findings:\n${JSON.stringify(allFindings, null, 2)}\n\nProduce an overall rating, severity counts, top 5 issues, and actionable recommendations. "pass"=no critical/high, "needs-work"=fixable issues, "fail"=fundamental design flaws.`,
  { schema: REPORT_SHAPE, label: 'report-consolidator', phase: 'Report' }
);

return {
  files: filesToReview, context,
  ...(report || { overall_rating: allFindings.some(f => f.severity === 'critical') ? 'fail' : 'needs-work', critical_count: allFindings.filter(f => f.severity === 'critical').length, high_count: allFindings.filter(f => f.severity === 'high').length, medium_count: allFindings.filter(f => f.severity === 'medium').length, low_count: allFindings.filter(f => f.severity === 'low').length }),
  findings: allFindings,
  summaries: { security: (securityReview && securityReview.summary) || '', performance: (perfReview && perfReview.summary) || '', correctness: (correctnessReview && correctnessReview.summary) || '', maintainability: (maintainabilityReview && maintainabilityReview.summary) || '' },
  recommendations: (report && report.recommendations) || ['Address critical and high-severity findings first.', 'Run automated linting and type checking in CI.'],
};