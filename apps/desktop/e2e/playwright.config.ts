import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const specFiles = readdirSync(fileURLToPath(new URL('.', import.meta.url))).filter(file => file.endsWith('.spec.ts'));
const specsWithPrefix = (...prefixes: string[]) =>
  specFiles.filter(file => prefixes.some(prefix => file.startsWith(prefix)));

const journeySpecs = ['**/desktop/e2e/*.spec.ts', '**/desktop/test/e2e/**/*.spec.ts'];
const quarantineTag = /@quarantine\b/;
const excludedJourneyTags = [/@smoke\b/, quarantineTag];
const sessionApiGateSpecs = ['approval-permission-modes.spec.ts'];
const approvalsStateSpecs = [
  'approval-plan-review.spec.ts',
  'approval-batch-and-questions.spec.ts',
  'approval-decisions.spec.ts',
  'agents-tasks-todos.spec.ts',
  'agents-goal.spec.ts',
  'composer-drafts-models.spec.ts',
  'lifecycle-quit.spec.ts',
  'lifecycle-connection.spec.ts',
];
const turnEngineGateSpecs = ['lifecycle-model-errors.spec.ts'];
const turnsTranscriptSpecs = [
  ...specsWithPrefix('transcript-', 'turn-'),
  'bash-background.spec.ts',
  'bash-tool-card.spec.ts',
  'agents-subagents.spec.ts',
  'agents-side-chat-compaction.spec.ts',
  'composer-writing.spec.ts',
  'files-turn-changes.spec.ts',
  'selection-comment.spec.ts',
];

const tieredSpecs = [
  ...sessionApiGateSpecs,
  ...approvalsStateSpecs,
  ...turnEngineGateSpecs,
  ...turnsTranscriptSpecs,
];
const missingSpecs = tieredSpecs.filter(spec => !specFiles.includes(spec));
if (missingSpecs.length > 0) throw new Error(`Tiered specs not found: ${missingSpecs.join(', ')}`);
const duplicateSpecs = tieredSpecs.filter((spec, index) => tieredSpecs.indexOf(spec) !== index);
if (duplicateSpecs.length > 0) throw new Error(`Specs listed in more than one project: ${duplicateSpecs.join(', ')}`);

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  outputDir: '../test-results/e2e',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: !!process.env['CI'],
  timeout: process.platform === 'win32' ? 240_000 : 120_000,
  expect: { timeout: 15_000 },
  reporter: process.env['CI']
    ? [['list'], ['./fixtures/smoke-reporter.ts'], ['html', { outputFolder: fileURLToPath(new URL('../playwright-report', import.meta.url)), open: 'never' }]]
    : [['list'], ['./fixtures/smoke-reporter.ts']],
  projects: process.env['KIMI_E2E_QUARANTINE'] === '1' ? [
    { name: 'quarantine', testDir: '..', testMatch: journeySpecs, grep: quarantineTag },
  ] : [
    { name: 'smoke', testDir: '..', testMatch: journeySpecs, grep: /@smoke\b/, grepInvert: quarantineTag },
    { name: 'gate-session-api', grepInvert: excludedJourneyTags, testMatch: sessionApiGateSpecs, retries: 1, dependencies: ['smoke'] },
    { name: 'approvals-state', grepInvert: excludedJourneyTags, testMatch: approvalsStateSpecs, dependencies: ['gate-session-api'] },
    { name: 'gate-turn-engine', grepInvert: excludedJourneyTags, testMatch: turnEngineGateSpecs, retries: 1, dependencies: ['smoke'] },
    { name: 'turns-transcript', grepInvert: excludedJourneyTags, testMatch: turnsTranscriptSpecs, dependencies: ['gate-turn-engine'] },
    { name: 'app-shell', testDir: '..', testMatch: journeySpecs, testIgnore: tieredSpecs.map(file => `**/desktop/e2e/${file}`), grepInvert: excludedJourneyTags, dependencies: ['smoke'] },
  ],
});
