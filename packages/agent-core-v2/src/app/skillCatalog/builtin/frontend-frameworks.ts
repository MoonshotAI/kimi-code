/**
 * `skillCatalog` domain (L3) — builtin `frontend-frameworks` skill bundle.
 */

import type { SkillDefinition } from '#/app/skillCatalog/types';
import { parseSkillText } from '#/app/skillCatalog/parser';

import FRONTEND_FRAMEWORKS_BODY from './frontend-frameworks/SKILL.md?raw';
import FRONTEND_FRAMEWORKS_ANGULAR_ARCHITECT_BODY from './frontend-frameworks/angular-architect/SKILL.md?raw';
import FRONTEND_FRAMEWORKS_FLUTTER_EXPERT_BODY from './frontend-frameworks/flutter-expert/SKILL.md?raw';
import FRONTEND_FRAMEWORKS_FULLSTACK_DEVELOPER_BODY from './frontend-frameworks/fullstack-developer/SKILL.md?raw';
import FRONTEND_FRAMEWORKS_NEXTJS_DEVELOPER_BODY from './frontend-frameworks/nextjs-developer/SKILL.md?raw';
import FRONTEND_FRAMEWORKS_REACT_EXPERT_BODY from './frontend-frameworks/react-expert/SKILL.md?raw';
import FRONTEND_FRAMEWORKS_REACT_NATIVE_EXPERT_BODY from './frontend-frameworks/react-native-expert/SKILL.md?raw';
import FRONTEND_FRAMEWORKS_SHOPIFY_EXPERT_BODY from './frontend-frameworks/shopify-expert/SKILL.md?raw';
import FRONTEND_FRAMEWORKS_SWIFT_EXPERT_BODY from './frontend-frameworks/swift-expert/SKILL.md?raw';
import FRONTEND_FRAMEWORKS_VUE_EXPERT_BODY from './frontend-frameworks/vue-expert/SKILL.md?raw';
import FRONTEND_FRAMEWORKS_VUE_EXPERT_JS_BODY from './frontend-frameworks/vue-expert-js/SKILL.md?raw';
import FRONTEND_FRAMEWORKS_WORDPRESS_PRO_BODY from './frontend-frameworks/wordpress-pro/SKILL.md?raw';

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

export const FRONTEND_FRAMEWORKS_SKILL = makeBuiltin(
  FRONTEND_FRAMEWORKS_BODY,
  'frontend-frameworks',
  'builtin://frontend-frameworks',
  { 'has-sub-skill': true },
);

export const FRONTEND_FRAMEWORKS_ANGULAR_ARCHITECT_SKILL = makeBuiltin(
  FRONTEND_FRAMEWORKS_ANGULAR_ARCHITECT_BODY,
  'frontend-frameworks.angular-architect',
  'builtin://frontend-frameworks/angular-architect',
  { isSubSkill: true },
);

export const FRONTEND_FRAMEWORKS_FLUTTER_EXPERT_SKILL = makeBuiltin(
  FRONTEND_FRAMEWORKS_FLUTTER_EXPERT_BODY,
  'frontend-frameworks.flutter-expert',
  'builtin://frontend-frameworks/flutter-expert',
  { isSubSkill: true },
);

export const FRONTEND_FRAMEWORKS_FULLSTACK_DEVELOPER_SKILL = makeBuiltin(
  FRONTEND_FRAMEWORKS_FULLSTACK_DEVELOPER_BODY,
  'frontend-frameworks.fullstack-developer',
  'builtin://frontend-frameworks/fullstack-developer',
  { isSubSkill: true },
);

export const FRONTEND_FRAMEWORKS_NEXTJS_DEVELOPER_SKILL = makeBuiltin(
  FRONTEND_FRAMEWORKS_NEXTJS_DEVELOPER_BODY,
  'frontend-frameworks.nextjs-developer',
  'builtin://frontend-frameworks/nextjs-developer',
  { isSubSkill: true },
);

export const FRONTEND_FRAMEWORKS_REACT_EXPERT_SKILL = makeBuiltin(
  FRONTEND_FRAMEWORKS_REACT_EXPERT_BODY,
  'frontend-frameworks.react-expert',
  'builtin://frontend-frameworks/react-expert',
  { isSubSkill: true },
);

export const FRONTEND_FRAMEWORKS_REACT_NATIVE_EXPERT_SKILL = makeBuiltin(
  FRONTEND_FRAMEWORKS_REACT_NATIVE_EXPERT_BODY,
  'frontend-frameworks.react-native-expert',
  'builtin://frontend-frameworks/react-native-expert',
  { isSubSkill: true },
);

export const FRONTEND_FRAMEWORKS_SHOPIFY_EXPERT_SKILL = makeBuiltin(
  FRONTEND_FRAMEWORKS_SHOPIFY_EXPERT_BODY,
  'frontend-frameworks.shopify-expert',
  'builtin://frontend-frameworks/shopify-expert',
  { isSubSkill: true },
);

export const FRONTEND_FRAMEWORKS_SWIFT_EXPERT_SKILL = makeBuiltin(
  FRONTEND_FRAMEWORKS_SWIFT_EXPERT_BODY,
  'frontend-frameworks.swift-expert',
  'builtin://frontend-frameworks/swift-expert',
  { isSubSkill: true },
);

export const FRONTEND_FRAMEWORKS_VUE_EXPERT_SKILL = makeBuiltin(
  FRONTEND_FRAMEWORKS_VUE_EXPERT_BODY,
  'frontend-frameworks.vue-expert',
  'builtin://frontend-frameworks/vue-expert',
  { isSubSkill: true },
);

export const FRONTEND_FRAMEWORKS_VUE_EXPERT_JS_SKILL = makeBuiltin(
  FRONTEND_FRAMEWORKS_VUE_EXPERT_JS_BODY,
  'frontend-frameworks.vue-expert-js',
  'builtin://frontend-frameworks/vue-expert-js',
  { isSubSkill: true },
);

export const FRONTEND_FRAMEWORKS_WORDPRESS_PRO_SKILL = makeBuiltin(
  FRONTEND_FRAMEWORKS_WORDPRESS_PRO_BODY,
  'frontend-frameworks.wordpress-pro',
  'builtin://frontend-frameworks/wordpress-pro',
  { isSubSkill: true },
);

