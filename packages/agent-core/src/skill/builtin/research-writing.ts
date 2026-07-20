import { parseSkillText } from '../parser';
import type { SkillDefinition } from '../types';

import RESEARCH_WRITING_BODY from './research-writing/SKILL.md?raw';
import RESEARCH_WRITING_ACADEMIC_RESEARCHER_BODY from './research-writing/academic-researcher/SKILL.md?raw';
import RESEARCH_WRITING_CODE_DOCUMENTER_BODY from './research-writing/code-documenter/SKILL.md?raw';
import RESEARCH_WRITING_CODE_DOCUMENTER_REFERENCES_API_DOCS_FASTAPI_DJANGO from './research-writing/code-documenter/references/api-docs-fastapi-django.md?raw';
import RESEARCH_WRITING_CODE_DOCUMENTER_REFERENCES_API_DOCS_NESTJS_EXPRESS from './research-writing/code-documenter/references/api-docs-nestjs-express.md?raw';
import RESEARCH_WRITING_CODE_DOCUMENTER_REFERENCES_COVERAGE_REPORTS from './research-writing/code-documenter/references/coverage-reports.md?raw';
import RESEARCH_WRITING_CODE_DOCUMENTER_REFERENCES_DOCUMENTATION_SYSTEMS from './research-writing/code-documenter/references/documentation-systems.md?raw';
import RESEARCH_WRITING_CODE_DOCUMENTER_REFERENCES_INTERACTIVE_API_DOCS from './research-writing/code-documenter/references/interactive-api-docs.md?raw';
import RESEARCH_WRITING_CODE_DOCUMENTER_REFERENCES_PYTHON_DOCSTRINGS from './research-writing/code-documenter/references/python-docstrings.md?raw';
import RESEARCH_WRITING_CODE_DOCUMENTER_REFERENCES_TYPESCRIPT_JSDOC from './research-writing/code-documenter/references/typescript-jsdoc.md?raw';
import RESEARCH_WRITING_CODE_DOCUMENTER_REFERENCES_USER_GUIDES_TUTORIALS from './research-writing/code-documenter/references/user-guides-tutorials.md?raw';
import RESEARCH_WRITING_CONTENT_CREATOR_BODY from './research-writing/content-creator/SKILL.md?raw';
import RESEARCH_WRITING_DEEP_RESEARCH_BODY from './research-writing/deep-research/SKILL.md?raw';
import RESEARCH_WRITING_EDITOR_BODY from './research-writing/editor/SKILL.md?raw';
import RESEARCH_WRITING_EMAIL_DRAFTER_BODY from './research-writing/email-drafter/SKILL.md?raw';
import RESEARCH_WRITING_FACT_CHECKER_BODY from './research-writing/fact-checker/SKILL.md?raw';
import RESEARCH_WRITING_MEETING_NOTES_BODY from './research-writing/meeting-notes/SKILL.md?raw';
import RESEARCH_WRITING_TECHNICAL_WRITER_BODY from './research-writing/technical-writer/SKILL.md?raw';

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

export const RESEARCH_WRITING_SKILL = makeBuiltin(
  RESEARCH_WRITING_BODY,
  'research-writing',
  'builtin://research-writing',
  { 'has-sub-skill': true },
);

export const RESEARCH_WRITING_ACADEMIC_RESEARCHER_SKILL = makeBuiltin(
  RESEARCH_WRITING_ACADEMIC_RESEARCHER_BODY,
  'research-writing.academic-researcher',
  'builtin://research-writing/academic-researcher',
  { isSubSkill: true },
);

export const RESEARCH_WRITING_CODE_DOCUMENTER_SKILL = makeBuiltin(
  RESEARCH_WRITING_CODE_DOCUMENTER_BODY,
  'research-writing.code-documenter',
  'builtin://research-writing/code-documenter',
  { isSubSkill: true },
  {
    'references/api-docs-fastapi-django.md': RESEARCH_WRITING_CODE_DOCUMENTER_REFERENCES_API_DOCS_FASTAPI_DJANGO,
    'references/api-docs-nestjs-express.md': RESEARCH_WRITING_CODE_DOCUMENTER_REFERENCES_API_DOCS_NESTJS_EXPRESS,
    'references/coverage-reports.md': RESEARCH_WRITING_CODE_DOCUMENTER_REFERENCES_COVERAGE_REPORTS,
    'references/documentation-systems.md': RESEARCH_WRITING_CODE_DOCUMENTER_REFERENCES_DOCUMENTATION_SYSTEMS,
    'references/interactive-api-docs.md': RESEARCH_WRITING_CODE_DOCUMENTER_REFERENCES_INTERACTIVE_API_DOCS,
    'references/python-docstrings.md': RESEARCH_WRITING_CODE_DOCUMENTER_REFERENCES_PYTHON_DOCSTRINGS,
    'references/typescript-jsdoc.md': RESEARCH_WRITING_CODE_DOCUMENTER_REFERENCES_TYPESCRIPT_JSDOC,
    'references/user-guides-tutorials.md': RESEARCH_WRITING_CODE_DOCUMENTER_REFERENCES_USER_GUIDES_TUTORIALS,
  },
);

export const RESEARCH_WRITING_CONTENT_CREATOR_SKILL = makeBuiltin(
  RESEARCH_WRITING_CONTENT_CREATOR_BODY,
  'research-writing.content-creator',
  'builtin://research-writing/content-creator',
  { isSubSkill: true },
);

export const RESEARCH_WRITING_DEEP_RESEARCH_SKILL = makeBuiltin(
  RESEARCH_WRITING_DEEP_RESEARCH_BODY,
  'research-writing.deep-research',
  'builtin://research-writing/deep-research',
  { isSubSkill: true },
);

export const RESEARCH_WRITING_EDITOR_SKILL = makeBuiltin(
  RESEARCH_WRITING_EDITOR_BODY,
  'research-writing.editor',
  'builtin://research-writing/editor',
  { isSubSkill: true },
);

export const RESEARCH_WRITING_EMAIL_DRAFTER_SKILL = makeBuiltin(
  RESEARCH_WRITING_EMAIL_DRAFTER_BODY,
  'research-writing.email-drafter',
  'builtin://research-writing/email-drafter',
  { isSubSkill: true },
);

export const RESEARCH_WRITING_FACT_CHECKER_SKILL = makeBuiltin(
  RESEARCH_WRITING_FACT_CHECKER_BODY,
  'research-writing.fact-checker',
  'builtin://research-writing/fact-checker',
  { isSubSkill: true },
);

export const RESEARCH_WRITING_MEETING_NOTES_SKILL = makeBuiltin(
  RESEARCH_WRITING_MEETING_NOTES_BODY,
  'research-writing.meeting-notes',
  'builtin://research-writing/meeting-notes',
  { isSubSkill: true },
);

export const RESEARCH_WRITING_TECHNICAL_WRITER_SKILL = makeBuiltin(
  RESEARCH_WRITING_TECHNICAL_WRITER_BODY,
  'research-writing.technical-writer',
  'builtin://research-writing/technical-writer',
  { isSubSkill: true },
);

