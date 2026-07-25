export const meta = {
  name: 'pr-description',
  description: 'Pull request description generator — analyzes code diffs or file changes, extracts the semantic intent, and generates a comprehensive PR description with summary, changelog entries, testing notes, and reviewer guidance.',
  whenToUse: 'Use when preparing a pull request, writing commit messages, or generating changelog entries from code changes.',
  phases: ['Analyze', 'Categorize', 'Describe', 'Review'],
};

// ── Tunables ──────────────────────────────────────────────────────
const MAX_FILES = 30; const MAX_DIFF_LINES = 500; const MAX_CHUNK_LINES = 100;

// ── Structured output shapes ──────────────────────────────────────
const ANALYSIS_SHAPE = {
  type: 'object', properties: {
    title: { type: 'string', description: 'Suggested PR title (conventional commit format).' },
    type: { type: 'string', enum: ['feat', 'fix', 'refactor', 'docs', 'test', 'chore', 'perf', 'ci', 'style'] },
    scope: { type: 'string' }, files_changed: { type: 'number' },
    languages: { type: 'array', items: { type: 'string' } }, breaking: { type: 'boolean' },
  }, required: ['title', 'type', 'scope', 'files_changed', 'languages', 'breaking'],
};

const CHANGE_GROUP_SHAPE = {
  type: 'object', properties: {
    groups: { type: 'array', items: { type: 'object', properties: { category: { type: 'string' }, files: { type: 'array', items: { type: 'string' } }, description: { type: 'string' } }, required: ['category', 'files', 'description'] } },
    deleted_files: { type: 'array', items: { type: 'string' } }, new_files: { type: 'array', items: { type: 'string' } },
  }, required: ['groups', 'deleted_files', 'new_files'],
};

const PR_DESCRIPTION_SHAPE = {
  type: 'object', properties: {
    summary: { type: 'string' }, motivation: { type: 'string' },
    changes: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, change: { type: 'string' }, impact: { type: 'string', enum: ['low', 'medium', 'high'] } }, required: ['file', 'change', 'impact'] } },
    checklist: { type: 'array', items: { type: 'string' } },
  }, required: ['summary', 'motivation', 'changes', 'checklist'],
};

const REVIEW_GUIDE_SHAPE = {
  type: 'object', properties: {
    focus_areas: { type: 'array', items: { type: 'string' } }, risks: { type: 'array', items: { type: 'string' } },
    test_instructions: { type: 'string' }, changelog_entry: { type: 'string' },
  }, required: ['focus_areas', 'risks', 'test_instructions', 'changelog_entry'],
};

// ── Main ──────────────────────────────────────────────────────────
const input = typeof args === 'string' ? { files: args.split(',').map(s => s.trim()).filter(Boolean) } : (args || {});
let filePaths = Array.isArray(input.files) ? input.files : [];
const branch = input.branch || ''; const baseBranch = input.base_branch || 'main';

if (filePaths.length === 0) {
  if (input.diff_file) {
    try {
      const diffContent = await readFile(input.diff_file);
      const fileMatches = diffContent.match(/^[+]{3}\s+[ab]\/(.+)$/gm);
      filePaths = fileMatches ? [...new Set(fileMatches.map(m => m.replace(/^[+]{3}\s+[ab]\//, '').trim()))] : ['diff_input'];
    } catch { return { error: `Could not read diff file: ${input.diff_file}` }; }
  } else if (branch) {
    return { error: `Branch comparison (${branch}...${baseBranch}) requires git. Provide explicit file paths instead.` };
  } else { return { error: 'No file paths provided. Pass files as args or use diff_file.' }; }
}

phase('Analyze');
const sources = []; let diffContent = '';
for (const p of filePaths.slice(0, MAX_FILES)) {
  if (p === 'diff_input' && input.diff_file) { try { diffContent = (await readFile(input.diff_file)).split('\n').slice(0, MAX_DIFF_LINES).join('\n'); } catch {} continue; }
  try { const content = await readFile(p); sources.push({ path: p, content: content.split('\n').slice(0, MAX_CHUNK_LINES).join('\n') }); } catch { log(`Cannot read: ${p}`); }
}
const codeBlock = sources.map(s => `--- ${s.path} ---\n${s.content}`).join('\n\n');
const diffBlock = diffContent ? `\n\nDiff:\n${diffContent}` : '';

const analysis = await agent(
  `You are a PR analyst. Analyze these file changes and determine the PR title, type, scope, and breaking change status.\n\n${codeBlock}${diffBlock}\n\nProduce a conventional commit title and classify the changes.`,
  { schema: ANALYSIS_SHAPE, label: 'analyzer', phase: 'Analyze' }
);
if (!analysis) return { error: 'Change analysis failed.' };
log(`Type: ${analysis.type}${analysis.breaking ? ' (BREAKING)' : ''} | Scope: ${analysis.scope}`);

phase('Categorize');
const categorized = await agent(
  `You are a change categorizer. Group these file changes into logical categories.\n\n${codeBlock}${diffBlock}\n\nGroup related files together. Identify new and deleted files.`,
  { schema: CHANGE_GROUP_SHAPE, label: 'categorizer', phase: 'Categorize' }
);

phase('Describe');
const description = await agent(
  `You are a technical writer. Write a comprehensive PR description.\n\nTitle: ${analysis.type}${analysis.breaking ? '!' : ''}(${analysis.scope}): ${analysis.title}\n${analysis.breaking ? '\n**BREAKING CHANGE**\n' : ''}\n\nChanges:\n${JSON.stringify((categorized && categorized.groups) || [], null, 2)}\n\nFiles:\n${codeBlock}${diffBlock}\n\nWrite a summary, motivation, detailed per-file changes, and a pre-merge checklist.`,
  { schema: PR_DESCRIPTION_SHAPE, label: 'writer', phase: 'Describe' }
);

phase('Review');
const reviewGuide = await agent(
  `You are a review coordinator. Generate reviewer guidance.\n\nTitle: ${analysis.type}(${analysis.scope}): ${analysis.title}\n\nDescription:\n${JSON.stringify(description || {}, null, 2)}\n\nFiles:\n${codeBlock}${diffBlock}\n\nGenerate focus areas, risks, testing instructions, and changelog entry.`,
  { schema: REVIEW_GUIDE_SHAPE, label: 'review-coordinator', phase: 'Review' }
);

return {
  title: `${analysis.type}${analysis.breaking ? '!' : ''}(${analysis.scope}): ${analysis.title}`,
  type: analysis.type, scope: analysis.scope, breaking: analysis.breaking,
  description: description || { summary: '', motivation: '', changes: [], checklist: [] },
  categories: (categorized && categorized.groups) || [],
  stats: { files_analyzed: sources.length, new_files: (categorized && categorized.new_files) || [], deleted_files: (categorized && categorized.deleted_files) || [] },
  review_guide: reviewGuide || { focus_areas: [], risks: [], test_instructions: 'Manual testing recommended.', changelog_entry: `- ${analysis.type}: ${analysis.title}` },
};