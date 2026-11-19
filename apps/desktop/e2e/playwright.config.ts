import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const specFiles = readdirSync(fileURLToPath(new URL('.', import.meta.url))).filter(file => file.endsWith('.spec.ts'));
const specsWithPrefix = (...prefixes: string[]) =>
  specFiles.filter(file => prefixes.some(prefix => file.startsWith(prefix)));

const smokeSpecs = ['core-turn.spec.ts'];
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
  ...smokeSpecs,
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
    ? [['list'], ['html', { outputFolder: '../playwright-report', open: 'never' }]]
    : [['list']],
  projects: [
    { name: 'smoke', testMatch: smokeSpecs, retries: 1 },
    { name: 'gate-session-api', testMatch: sessionApiGateSpecs, retries: 1, dependencies: ['smoke'] },
    { name: 'approvals-state', testMatch: approvalsStateSpecs, dependencies: ['gate-session-api'] },
    { name: 'gate-turn-engine', testMatch: turnEngineGateSpecs, retries: 1, dependencies: ['smoke'] },
    { name: 'turns-transcript', testMatch: turnsTranscriptSpecs, dependencies: ['gate-turn-engine'] },
    { name: 'app-shell', testMatch: '*.spec.ts', testIgnore: tieredSpecs, dependencies: ['smoke'] },
  ],
});
