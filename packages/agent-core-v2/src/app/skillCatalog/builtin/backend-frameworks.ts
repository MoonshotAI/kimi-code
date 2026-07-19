/**
 * `skillCatalog` domain (L3) — builtin `backend-frameworks` skill bundle.
 */

import type { SkillDefinition } from '#/app/skillCatalog/types';
import { parseSkillText } from '#/app/skillCatalog/parser';

import BACKEND_FRAMEWORKS_BODY from './backend-frameworks/SKILL.md?raw';
import BACKEND_FRAMEWORKS_CSHARP_DEVELOPER_BODY from './backend-frameworks/csharp-developer/SKILL.md?raw';
import BACKEND_FRAMEWORKS_DJANGO_EXPERT_BODY from './backend-frameworks/django-expert/SKILL.md?raw';
import BACKEND_FRAMEWORKS_DOTNET_CORE_EXPERT_BODY from './backend-frameworks/dotnet-core-expert/SKILL.md?raw';
import BACKEND_FRAMEWORKS_FASTAPI_EXPERT_BODY from './backend-frameworks/fastapi-expert/SKILL.md?raw';
import BACKEND_FRAMEWORKS_JAVA_ARCHITECT_BODY from './backend-frameworks/java-architect/SKILL.md?raw';
import BACKEND_FRAMEWORKS_LARAVEL_SPECIALIST_BODY from './backend-frameworks/laravel-specialist/SKILL.md?raw';
import BACKEND_FRAMEWORKS_NESTJS_EXPERT_BODY from './backend-frameworks/nestjs-expert/SKILL.md?raw';
import BACKEND_FRAMEWORKS_PHP_PRO_BODY from './backend-frameworks/php-pro/SKILL.md?raw';
import BACKEND_FRAMEWORKS_RAILS_EXPERT_BODY from './backend-frameworks/rails-expert/SKILL.md?raw';
import BACKEND_FRAMEWORKS_SALESFORCE_DEVELOPER_BODY from './backend-frameworks/salesforce-developer/SKILL.md?raw';
import BACKEND_FRAMEWORKS_SPRING_BOOT_ENGINEER_BODY from './backend-frameworks/spring-boot-engineer/SKILL.md?raw';
import BACKEND_FRAMEWORKS_WEBSOCKET_ENGINEER_BODY from './backend-frameworks/websocket-engineer/SKILL.md?raw';

function makeBuiltin(
  body: string,
  dirName: string,
  pseudoPath: string,
  extraMetadata: Record<string, unknown> = {},
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
    metadata: {
      ...parsed.metadata,
      type: parsed.metadata.type ?? 'inline',
      disableModelInvocation: true,
      ...extraMetadata,
    },
  };
}

export const BACKEND_FRAMEWORKS_SKILL = makeBuiltin(
  BACKEND_FRAMEWORKS_BODY,
  'backend-frameworks',
  'builtin://backend-frameworks',
  { 'has-sub-skill': true },
);

export const BACKEND_FRAMEWORKS_CSHARP_DEVELOPER_SKILL = makeBuiltin(
  BACKEND_FRAMEWORKS_CSHARP_DEVELOPER_BODY,
  'backend-frameworks.csharp-developer',
  'builtin://backend-frameworks/csharp-developer',
  { isSubSkill: true },
);

export const BACKEND_FRAMEWORKS_DJANGO_EXPERT_SKILL = makeBuiltin(
  BACKEND_FRAMEWORKS_DJANGO_EXPERT_BODY,
  'backend-frameworks.django-expert',
  'builtin://backend-frameworks/django-expert',
  { isSubSkill: true },
);

export const BACKEND_FRAMEWORKS_DOTNET_CORE_EXPERT_SKILL = makeBuiltin(
  BACKEND_FRAMEWORKS_DOTNET_CORE_EXPERT_BODY,
  'backend-frameworks.dotnet-core-expert',
  'builtin://backend-frameworks/dotnet-core-expert',
  { isSubSkill: true },
);

export const BACKEND_FRAMEWORKS_FASTAPI_EXPERT_SKILL = makeBuiltin(
  BACKEND_FRAMEWORKS_FASTAPI_EXPERT_BODY,
  'backend-frameworks.fastapi-expert',
  'builtin://backend-frameworks/fastapi-expert',
  { isSubSkill: true },
);

export const BACKEND_FRAMEWORKS_JAVA_ARCHITECT_SKILL = makeBuiltin(
  BACKEND_FRAMEWORKS_JAVA_ARCHITECT_BODY,
  'backend-frameworks.java-architect',
  'builtin://backend-frameworks/java-architect',
  { isSubSkill: true },
);

export const BACKEND_FRAMEWORKS_LARAVEL_SPECIALIST_SKILL = makeBuiltin(
  BACKEND_FRAMEWORKS_LARAVEL_SPECIALIST_BODY,
  'backend-frameworks.laravel-specialist',
  'builtin://backend-frameworks/laravel-specialist',
  { isSubSkill: true },
);

export const BACKEND_FRAMEWORKS_NESTJS_EXPERT_SKILL = makeBuiltin(
  BACKEND_FRAMEWORKS_NESTJS_EXPERT_BODY,
  'backend-frameworks.nestjs-expert',
  'builtin://backend-frameworks/nestjs-expert',
  { isSubSkill: true },
);

export const BACKEND_FRAMEWORKS_PHP_PRO_SKILL = makeBuiltin(
  BACKEND_FRAMEWORKS_PHP_PRO_BODY,
  'backend-frameworks.php-pro',
  'builtin://backend-frameworks/php-pro',
  { isSubSkill: true },
);

export const BACKEND_FRAMEWORKS_RAILS_EXPERT_SKILL = makeBuiltin(
  BACKEND_FRAMEWORKS_RAILS_EXPERT_BODY,
  'backend-frameworks.rails-expert',
  'builtin://backend-frameworks/rails-expert',
  { isSubSkill: true },
);

export const BACKEND_FRAMEWORKS_SALESFORCE_DEVELOPER_SKILL = makeBuiltin(
  BACKEND_FRAMEWORKS_SALESFORCE_DEVELOPER_BODY,
  'backend-frameworks.salesforce-developer',
  'builtin://backend-frameworks/salesforce-developer',
  { isSubSkill: true },
);

export const BACKEND_FRAMEWORKS_SPRING_BOOT_ENGINEER_SKILL = makeBuiltin(
  BACKEND_FRAMEWORKS_SPRING_BOOT_ENGINEER_BODY,
  'backend-frameworks.spring-boot-engineer',
  'builtin://backend-frameworks/spring-boot-engineer',
  { isSubSkill: true },
);

export const BACKEND_FRAMEWORKS_WEBSOCKET_ENGINEER_SKILL = makeBuiltin(
  BACKEND_FRAMEWORKS_WEBSOCKET_ENGINEER_BODY,
  'backend-frameworks.websocket-engineer',
  'builtin://backend-frameworks/websocket-engineer',
  { isSubSkill: true },
);

