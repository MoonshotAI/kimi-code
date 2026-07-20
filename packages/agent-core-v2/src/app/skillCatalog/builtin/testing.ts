/**
 * `skillCatalog` domain (L3) — builtin `testing` skill bundle.
 */

import type { SkillDefinition } from '#/app/skillCatalog/types';
import { parseSkillText } from '#/app/skillCatalog/parser';

import TESTING_BODY from './testing/SKILL.md?raw';
import TESTING_CODE_REVIEWER_BODY from './testing/code-reviewer/SKILL.md?raw';
import TESTING_CODE_REVIEWER_AGENTS from './testing/code-reviewer/AGENTS.md?raw';
import TESTING_CODE_REVIEWER_REFERENCES_COMMON_ISSUES from './testing/code-reviewer/references/common-issues.md?raw';
import TESTING_CODE_REVIEWER_REFERENCES_FEEDBACK_EXAMPLES from './testing/code-reviewer/references/feedback-examples.md?raw';
import TESTING_CODE_REVIEWER_REFERENCES_RECEIVING_FEEDBACK from './testing/code-reviewer/references/receiving-feedback.md?raw';
import TESTING_CODE_REVIEWER_REFERENCES_REPORT_TEMPLATE from './testing/code-reviewer/references/report-template.md?raw';
import TESTING_CODE_REVIEWER_REFERENCES_REVIEW_CHECKLIST from './testing/code-reviewer/references/review-checklist.md?raw';
import TESTING_CODE_REVIEWER_REFERENCES_SPEC_COMPLIANCE_REVIEW from './testing/code-reviewer/references/spec-compliance-review.md?raw';
import TESTING_CODE_REVIEWER_RULES_CORRECTNESS_ERROR_HANDLING from './testing/code-reviewer/rules/correctness-error-handling.md?raw';
import TESTING_CODE_REVIEWER_RULES_MAINTAINABILITY_NAMING from './testing/code-reviewer/rules/maintainability-naming.md?raw';
import TESTING_CODE_REVIEWER_RULES_MAINTAINABILITY_TYPE_HINTS from './testing/code-reviewer/rules/maintainability-type-hints.md?raw';
import TESTING_CODE_REVIEWER_RULES_PERFORMANCE_N_PLUS_ONE from './testing/code-reviewer/rules/performance-n-plus-one.md?raw';
import TESTING_CODE_REVIEWER_RULES_SECURITY_SQL_INJECTION from './testing/code-reviewer/rules/security-sql-injection.md?raw';
import TESTING_CODE_REVIEWER_RULES_SECURITY_XSS_PREVENTION from './testing/code-reviewer/rules/security-xss-prevention.md?raw';
import TESTING_PLAYWRIGHT_EXPERT_BODY from './testing/playwright-expert/SKILL.md?raw';
import TESTING_PLAYWRIGHT_EXPERT_REFERENCES_API_MOCKING from './testing/playwright-expert/references/api-mocking.md?raw';
import TESTING_PLAYWRIGHT_EXPERT_REFERENCES_CONFIGURATION from './testing/playwright-expert/references/configuration.md?raw';
import TESTING_PLAYWRIGHT_EXPERT_REFERENCES_DEBUGGING_FLAKY from './testing/playwright-expert/references/debugging-flaky.md?raw';
import TESTING_PLAYWRIGHT_EXPERT_REFERENCES_PAGE_OBJECT_MODEL from './testing/playwright-expert/references/page-object-model.md?raw';
import TESTING_PLAYWRIGHT_EXPERT_REFERENCES_SELECTORS_LOCATORS from './testing/playwright-expert/references/selectors-locators.md?raw';
import TESTING_TEST_MASTER_BODY from './testing/test-master/SKILL.md?raw';
import TESTING_TEST_MASTER_REFERENCES_AUTOMATION_FRAMEWORKS from './testing/test-master/references/automation-frameworks.md?raw';
import TESTING_TEST_MASTER_REFERENCES_E2E_TESTING from './testing/test-master/references/e2e-testing.md?raw';
import TESTING_TEST_MASTER_REFERENCES_INTEGRATION_TESTING from './testing/test-master/references/integration-testing.md?raw';
import TESTING_TEST_MASTER_REFERENCES_PERFORMANCE_TESTING from './testing/test-master/references/performance-testing.md?raw';
import TESTING_TEST_MASTER_REFERENCES_QA_METHODOLOGY from './testing/test-master/references/qa-methodology.md?raw';
import TESTING_TEST_MASTER_REFERENCES_SECURITY_TESTING from './testing/test-master/references/security-testing.md?raw';
import TESTING_TEST_MASTER_REFERENCES_TDD_IRON_LAWS from './testing/test-master/references/tdd-iron-laws.md?raw';
import TESTING_TEST_MASTER_REFERENCES_TESTING_ANTI_PATTERNS from './testing/test-master/references/testing-anti-patterns.md?raw';
import TESTING_TEST_MASTER_REFERENCES_TEST_REPORTS from './testing/test-master/references/test-reports.md?raw';
import TESTING_TEST_MASTER_REFERENCES_UNIT_TESTING from './testing/test-master/references/unit-testing.md?raw';

function makeBuiltin(
  body: string,
  dirName: string,
  pseudoPath: string,
  extraMetadata: Record<string, unknown> = {},
  resources?: Readonly<Record<string, string>>,
): SkillDefinition {
  const parsed = parseSkillText({
    skillMdPath: `/builtin/skills/${dirName}/SKILL.md`,
    skillDirName: dirName,
    source: 'builtin',
    text: body,
  });
  return {
    ...parsed,
    name: dirName,
    path: pseudoPath,
    dir: pseudoPath,
    resources,
    metadata: {
      ...parsed.metadata,
      type: parsed.metadata.type ?? 'inline',
      ...extraMetadata,
    },
  };
}

export const TESTING_SKILL = makeBuiltin(
  TESTING_BODY,
  'testing',
  'builtin://testing',
  { 'has-sub-skill': true },
);

export const TESTING_CODE_REVIEWER_SKILL = makeBuiltin(
  TESTING_CODE_REVIEWER_BODY,
  'testing.code-reviewer',
  'builtin://testing/code-reviewer',
  { isSubSkill: true },
  {
    'AGENTS.md': TESTING_CODE_REVIEWER_AGENTS,
    'references/common-issues.md': TESTING_CODE_REVIEWER_REFERENCES_COMMON_ISSUES,
    'references/feedback-examples.md': TESTING_CODE_REVIEWER_REFERENCES_FEEDBACK_EXAMPLES,
    'references/receiving-feedback.md': TESTING_CODE_REVIEWER_REFERENCES_RECEIVING_FEEDBACK,
    'references/report-template.md': TESTING_CODE_REVIEWER_REFERENCES_REPORT_TEMPLATE,
    'references/review-checklist.md': TESTING_CODE_REVIEWER_REFERENCES_REVIEW_CHECKLIST,
    'references/spec-compliance-review.md': TESTING_CODE_REVIEWER_REFERENCES_SPEC_COMPLIANCE_REVIEW,
    'rules/correctness-error-handling.md': TESTING_CODE_REVIEWER_RULES_CORRECTNESS_ERROR_HANDLING,
    'rules/maintainability-naming.md': TESTING_CODE_REVIEWER_RULES_MAINTAINABILITY_NAMING,
    'rules/maintainability-type-hints.md': TESTING_CODE_REVIEWER_RULES_MAINTAINABILITY_TYPE_HINTS,
    'rules/performance-n-plus-one.md': TESTING_CODE_REVIEWER_RULES_PERFORMANCE_N_PLUS_ONE,
    'rules/security-sql-injection.md': TESTING_CODE_REVIEWER_RULES_SECURITY_SQL_INJECTION,
    'rules/security-xss-prevention.md': TESTING_CODE_REVIEWER_RULES_SECURITY_XSS_PREVENTION,
  },
);

export const TESTING_PLAYWRIGHT_EXPERT_SKILL = makeBuiltin(
  TESTING_PLAYWRIGHT_EXPERT_BODY,
  'testing.playwright-expert',
  'builtin://testing/playwright-expert',
  { isSubSkill: true },
  {
    'references/api-mocking.md': TESTING_PLAYWRIGHT_EXPERT_REFERENCES_API_MOCKING,
    'references/configuration.md': TESTING_PLAYWRIGHT_EXPERT_REFERENCES_CONFIGURATION,
    'references/debugging-flaky.md': TESTING_PLAYWRIGHT_EXPERT_REFERENCES_DEBUGGING_FLAKY,
    'references/page-object-model.md': TESTING_PLAYWRIGHT_EXPERT_REFERENCES_PAGE_OBJECT_MODEL,
    'references/selectors-locators.md': TESTING_PLAYWRIGHT_EXPERT_REFERENCES_SELECTORS_LOCATORS,
  },
);

export const TESTING_TEST_MASTER_SKILL = makeBuiltin(
  TESTING_TEST_MASTER_BODY,
  'testing.test-master',
  'builtin://testing/test-master',
  { isSubSkill: true },
  {
    'references/automation-frameworks.md': TESTING_TEST_MASTER_REFERENCES_AUTOMATION_FRAMEWORKS,
    'references/e2e-testing.md': TESTING_TEST_MASTER_REFERENCES_E2E_TESTING,
    'references/integration-testing.md': TESTING_TEST_MASTER_REFERENCES_INTEGRATION_TESTING,
    'references/performance-testing.md': TESTING_TEST_MASTER_REFERENCES_PERFORMANCE_TESTING,
    'references/qa-methodology.md': TESTING_TEST_MASTER_REFERENCES_QA_METHODOLOGY,
    'references/security-testing.md': TESTING_TEST_MASTER_REFERENCES_SECURITY_TESTING,
    'references/tdd-iron-laws.md': TESTING_TEST_MASTER_REFERENCES_TDD_IRON_LAWS,
    'references/testing-anti-patterns.md': TESTING_TEST_MASTER_REFERENCES_TESTING_ANTI_PATTERNS,
    'references/test-reports.md': TESTING_TEST_MASTER_REFERENCES_TEST_REPORTS,
    'references/unit-testing.md': TESTING_TEST_MASTER_REFERENCES_UNIT_TESTING,
  },
);

