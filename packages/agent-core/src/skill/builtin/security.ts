import { parseSkillText } from '../parser';
import type { SkillDefinition } from '../types';

import SECURITY_BODY from './security/SKILL.md?raw';
import SECURITY_FULLSTACK_GUARDIAN_BODY from './security/fullstack-guardian/SKILL.md?raw';
import SECURITY_FULLSTACK_GUARDIAN_REFERENCES_API_DESIGN_STANDARDS from './security/fullstack-guardian/references/api-design-standards.md?raw';
import SECURITY_FULLSTACK_GUARDIAN_REFERENCES_ARCHITECTURE_DECISIONS from './security/fullstack-guardian/references/architecture-decisions.md?raw';
import SECURITY_FULLSTACK_GUARDIAN_REFERENCES_BACKEND_PATTERNS from './security/fullstack-guardian/references/backend-patterns.md?raw';
import SECURITY_FULLSTACK_GUARDIAN_REFERENCES_COMMON_PATTERNS from './security/fullstack-guardian/references/common-patterns.md?raw';
import SECURITY_FULLSTACK_GUARDIAN_REFERENCES_DELIVERABLES_CHECKLIST from './security/fullstack-guardian/references/deliverables-checklist.md?raw';
import SECURITY_FULLSTACK_GUARDIAN_REFERENCES_DESIGN_TEMPLATE from './security/fullstack-guardian/references/design-template.md?raw';
import SECURITY_FULLSTACK_GUARDIAN_REFERENCES_ERROR_HANDLING from './security/fullstack-guardian/references/error-handling.md?raw';
import SECURITY_FULLSTACK_GUARDIAN_REFERENCES_FRONTEND_PATTERNS from './security/fullstack-guardian/references/frontend-patterns.md?raw';
import SECURITY_FULLSTACK_GUARDIAN_REFERENCES_INTEGRATION_PATTERNS from './security/fullstack-guardian/references/integration-patterns.md?raw';
import SECURITY_FULLSTACK_GUARDIAN_REFERENCES_SECURITY_CHECKLIST from './security/fullstack-guardian/references/security-checklist.md?raw';
import SECURITY_SECURE_CODE_GUARDIAN_BODY from './security/secure-code-guardian/SKILL.md?raw';
import SECURITY_SECURE_CODE_GUARDIAN_REFERENCES_AUTHENTICATION from './security/secure-code-guardian/references/authentication.md?raw';
import SECURITY_SECURE_CODE_GUARDIAN_REFERENCES_INPUT_VALIDATION from './security/secure-code-guardian/references/input-validation.md?raw';
import SECURITY_SECURE_CODE_GUARDIAN_REFERENCES_OWASP_PREVENTION from './security/secure-code-guardian/references/owasp-prevention.md?raw';
import SECURITY_SECURE_CODE_GUARDIAN_REFERENCES_SECURITY_HEADERS from './security/secure-code-guardian/references/security-headers.md?raw';
import SECURITY_SECURE_CODE_GUARDIAN_REFERENCES_XSS_CSRF from './security/secure-code-guardian/references/xss-csrf.md?raw';
import SECURITY_SECURITY_REVIEWER_BODY from './security/security-reviewer/SKILL.md?raw';
import SECURITY_SECURITY_REVIEWER_REFERENCES_INFRASTRUCTURE_SECURITY from './security/security-reviewer/references/infrastructure-security.md?raw';
import SECURITY_SECURITY_REVIEWER_REFERENCES_PENETRATION_TESTING from './security/security-reviewer/references/penetration-testing.md?raw';
import SECURITY_SECURITY_REVIEWER_REFERENCES_REPORT_TEMPLATE from './security/security-reviewer/references/report-template.md?raw';
import SECURITY_SECURITY_REVIEWER_REFERENCES_SAST_TOOLS from './security/security-reviewer/references/sast-tools.md?raw';
import SECURITY_SECURITY_REVIEWER_REFERENCES_SECRET_SCANNING from './security/security-reviewer/references/secret-scanning.md?raw';
import SECURITY_SECURITY_REVIEWER_REFERENCES_VULNERABILITY_PATTERNS from './security/security-reviewer/references/vulnerability-patterns.md?raw';

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

export const SECURITY_SKILL = makeBuiltin(
  SECURITY_BODY,
  'security',
  'builtin://security',
  { 'has-sub-skill': true },
);

export const SECURITY_FULLSTACK_GUARDIAN_SKILL = makeBuiltin(
  SECURITY_FULLSTACK_GUARDIAN_BODY,
  'security.fullstack-guardian',
  'builtin://security/fullstack-guardian',
  { isSubSkill: true },
  {
    'references/api-design-standards.md': SECURITY_FULLSTACK_GUARDIAN_REFERENCES_API_DESIGN_STANDARDS,
    'references/architecture-decisions.md': SECURITY_FULLSTACK_GUARDIAN_REFERENCES_ARCHITECTURE_DECISIONS,
    'references/backend-patterns.md': SECURITY_FULLSTACK_GUARDIAN_REFERENCES_BACKEND_PATTERNS,
    'references/common-patterns.md': SECURITY_FULLSTACK_GUARDIAN_REFERENCES_COMMON_PATTERNS,
    'references/deliverables-checklist.md': SECURITY_FULLSTACK_GUARDIAN_REFERENCES_DELIVERABLES_CHECKLIST,
    'references/design-template.md': SECURITY_FULLSTACK_GUARDIAN_REFERENCES_DESIGN_TEMPLATE,
    'references/error-handling.md': SECURITY_FULLSTACK_GUARDIAN_REFERENCES_ERROR_HANDLING,
    'references/frontend-patterns.md': SECURITY_FULLSTACK_GUARDIAN_REFERENCES_FRONTEND_PATTERNS,
    'references/integration-patterns.md': SECURITY_FULLSTACK_GUARDIAN_REFERENCES_INTEGRATION_PATTERNS,
    'references/security-checklist.md': SECURITY_FULLSTACK_GUARDIAN_REFERENCES_SECURITY_CHECKLIST,
  },
);

export const SECURITY_SECURE_CODE_GUARDIAN_SKILL = makeBuiltin(
  SECURITY_SECURE_CODE_GUARDIAN_BODY,
  'security.secure-code-guardian',
  'builtin://security/secure-code-guardian',
  { isSubSkill: true },
  {
    'references/authentication.md': SECURITY_SECURE_CODE_GUARDIAN_REFERENCES_AUTHENTICATION,
    'references/input-validation.md': SECURITY_SECURE_CODE_GUARDIAN_REFERENCES_INPUT_VALIDATION,
    'references/owasp-prevention.md': SECURITY_SECURE_CODE_GUARDIAN_REFERENCES_OWASP_PREVENTION,
    'references/security-headers.md': SECURITY_SECURE_CODE_GUARDIAN_REFERENCES_SECURITY_HEADERS,
    'references/xss-csrf.md': SECURITY_SECURE_CODE_GUARDIAN_REFERENCES_XSS_CSRF,
  },
);

export const SECURITY_SECURITY_REVIEWER_SKILL = makeBuiltin(
  SECURITY_SECURITY_REVIEWER_BODY,
  'security.security-reviewer',
  'builtin://security/security-reviewer',
  { isSubSkill: true },
  {
    'references/infrastructure-security.md': SECURITY_SECURITY_REVIEWER_REFERENCES_INFRASTRUCTURE_SECURITY,
    'references/penetration-testing.md': SECURITY_SECURITY_REVIEWER_REFERENCES_PENETRATION_TESTING,
    'references/report-template.md': SECURITY_SECURITY_REVIEWER_REFERENCES_REPORT_TEMPLATE,
    'references/sast-tools.md': SECURITY_SECURITY_REVIEWER_REFERENCES_SAST_TOOLS,
    'references/secret-scanning.md': SECURITY_SECURITY_REVIEWER_REFERENCES_SECRET_SCANNING,
    'references/vulnerability-patterns.md': SECURITY_SECURITY_REVIEWER_REFERENCES_VULNERABILITY_PATTERNS,
  },
);
