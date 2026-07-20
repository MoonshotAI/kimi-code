/**
 * `skillCatalog` domain (L3) — builtin `frontend-frameworks` skill bundle.
 */

import type { SkillDefinition } from '#/app/skillCatalog/types';
import { parseSkillText } from '#/app/skillCatalog/parser';

import FRONTEND_FRAMEWORKS_BODY from './frontend-frameworks/SKILL.md?raw';
import FRONTEND_FRAMEWORKS_ANGULAR_ARCHITECT_BODY from './frontend-frameworks/angular-architect/SKILL.md?raw';
import FRONTEND_FRAMEWORKS_ANGULAR_ARCHITECT_REFERENCES_COMPONENTS from './frontend-frameworks/angular-architect/references/components.md?raw';
import FRONTEND_FRAMEWORKS_ANGULAR_ARCHITECT_REFERENCES_NGRX from './frontend-frameworks/angular-architect/references/ngrx.md?raw';
import FRONTEND_FRAMEWORKS_ANGULAR_ARCHITECT_REFERENCES_ROUTING from './frontend-frameworks/angular-architect/references/routing.md?raw';
import FRONTEND_FRAMEWORKS_ANGULAR_ARCHITECT_REFERENCES_RXJS from './frontend-frameworks/angular-architect/references/rxjs.md?raw';
import FRONTEND_FRAMEWORKS_ANGULAR_ARCHITECT_REFERENCES_TESTING from './frontend-frameworks/angular-architect/references/testing.md?raw';
import FRONTEND_FRAMEWORKS_FLUTTER_EXPERT_BODY from './frontend-frameworks/flutter-expert/SKILL.md?raw';
import FRONTEND_FRAMEWORKS_FLUTTER_EXPERT_REFERENCES_BLOC_STATE from './frontend-frameworks/flutter-expert/references/bloc-state.md?raw';
import FRONTEND_FRAMEWORKS_FLUTTER_EXPERT_REFERENCES_GOROUTER_NAVIGATION from './frontend-frameworks/flutter-expert/references/gorouter-navigation.md?raw';
import FRONTEND_FRAMEWORKS_FLUTTER_EXPERT_REFERENCES_PERFORMANCE from './frontend-frameworks/flutter-expert/references/performance.md?raw';
import FRONTEND_FRAMEWORKS_FLUTTER_EXPERT_REFERENCES_PROJECT_STRUCTURE from './frontend-frameworks/flutter-expert/references/project-structure.md?raw';
import FRONTEND_FRAMEWORKS_FLUTTER_EXPERT_REFERENCES_RIVERPOD_STATE from './frontend-frameworks/flutter-expert/references/riverpod-state.md?raw';
import FRONTEND_FRAMEWORKS_FLUTTER_EXPERT_REFERENCES_WIDGET_PATTERNS from './frontend-frameworks/flutter-expert/references/widget-patterns.md?raw';
import FRONTEND_FRAMEWORKS_FULLSTACK_DEVELOPER_BODY from './frontend-frameworks/fullstack-developer/SKILL.md?raw';
import FRONTEND_FRAMEWORKS_NEXTJS_DEVELOPER_BODY from './frontend-frameworks/nextjs-developer/SKILL.md?raw';
import FRONTEND_FRAMEWORKS_NEXTJS_DEVELOPER_REFERENCES_APP_ROUTER from './frontend-frameworks/nextjs-developer/references/app-router.md?raw';
import FRONTEND_FRAMEWORKS_NEXTJS_DEVELOPER_REFERENCES_DATA_FETCHING from './frontend-frameworks/nextjs-developer/references/data-fetching.md?raw';
import FRONTEND_FRAMEWORKS_NEXTJS_DEVELOPER_REFERENCES_DEPLOYMENT from './frontend-frameworks/nextjs-developer/references/deployment.md?raw';
import FRONTEND_FRAMEWORKS_NEXTJS_DEVELOPER_REFERENCES_SERVER_ACTIONS from './frontend-frameworks/nextjs-developer/references/server-actions.md?raw';
import FRONTEND_FRAMEWORKS_NEXTJS_DEVELOPER_REFERENCES_SERVER_COMPONENTS from './frontend-frameworks/nextjs-developer/references/server-components.md?raw';
import FRONTEND_FRAMEWORKS_REACT_EXPERT_BODY from './frontend-frameworks/react-expert/SKILL.md?raw';
import FRONTEND_FRAMEWORKS_REACT_EXPERT_REFERENCES_HOOKS_PATTERNS from './frontend-frameworks/react-expert/references/hooks-patterns.md?raw';
import FRONTEND_FRAMEWORKS_REACT_EXPERT_REFERENCES_MIGRATION_CLASS_TO_MODERN from './frontend-frameworks/react-expert/references/migration-class-to-modern.md?raw';
import FRONTEND_FRAMEWORKS_REACT_EXPERT_REFERENCES_PERFORMANCE from './frontend-frameworks/react-expert/references/performance.md?raw';
import FRONTEND_FRAMEWORKS_REACT_EXPERT_REFERENCES_REACT_19_FEATURES from './frontend-frameworks/react-expert/references/react-19-features.md?raw';
import FRONTEND_FRAMEWORKS_REACT_EXPERT_REFERENCES_SERVER_COMPONENTS from './frontend-frameworks/react-expert/references/server-components.md?raw';
import FRONTEND_FRAMEWORKS_REACT_EXPERT_REFERENCES_STATE_MANAGEMENT from './frontend-frameworks/react-expert/references/state-management.md?raw';
import FRONTEND_FRAMEWORKS_REACT_EXPERT_REFERENCES_TESTING_REACT from './frontend-frameworks/react-expert/references/testing-react.md?raw';
import FRONTEND_FRAMEWORKS_REACT_NATIVE_EXPERT_BODY from './frontend-frameworks/react-native-expert/SKILL.md?raw';
import FRONTEND_FRAMEWORKS_REACT_NATIVE_EXPERT_REFERENCES_EXPO_ROUTER from './frontend-frameworks/react-native-expert/references/expo-router.md?raw';
import FRONTEND_FRAMEWORKS_REACT_NATIVE_EXPERT_REFERENCES_LIST_OPTIMIZATION from './frontend-frameworks/react-native-expert/references/list-optimization.md?raw';
import FRONTEND_FRAMEWORKS_REACT_NATIVE_EXPERT_REFERENCES_PLATFORM_HANDLING from './frontend-frameworks/react-native-expert/references/platform-handling.md?raw';
import FRONTEND_FRAMEWORKS_REACT_NATIVE_EXPERT_REFERENCES_PROJECT_STRUCTURE from './frontend-frameworks/react-native-expert/references/project-structure.md?raw';
import FRONTEND_FRAMEWORKS_REACT_NATIVE_EXPERT_REFERENCES_STORAGE_HOOKS from './frontend-frameworks/react-native-expert/references/storage-hooks.md?raw';
import FRONTEND_FRAMEWORKS_SHOPIFY_EXPERT_BODY from './frontend-frameworks/shopify-expert/SKILL.md?raw';
import FRONTEND_FRAMEWORKS_SHOPIFY_EXPERT_REFERENCES_APP_DEVELOPMENT from './frontend-frameworks/shopify-expert/references/app-development.md?raw';
import FRONTEND_FRAMEWORKS_SHOPIFY_EXPERT_REFERENCES_CHECKOUT_CUSTOMIZATION from './frontend-frameworks/shopify-expert/references/checkout-customization.md?raw';
import FRONTEND_FRAMEWORKS_SHOPIFY_EXPERT_REFERENCES_LIQUID_TEMPLATING from './frontend-frameworks/shopify-expert/references/liquid-templating.md?raw';
import FRONTEND_FRAMEWORKS_SHOPIFY_EXPERT_REFERENCES_PERFORMANCE_OPTIMIZATION from './frontend-frameworks/shopify-expert/references/performance-optimization.md?raw';
import FRONTEND_FRAMEWORKS_SHOPIFY_EXPERT_REFERENCES_STOREFRONT_API from './frontend-frameworks/shopify-expert/references/storefront-api.md?raw';
import FRONTEND_FRAMEWORKS_SWIFT_EXPERT_BODY from './frontend-frameworks/swift-expert/SKILL.md?raw';
import FRONTEND_FRAMEWORKS_SWIFT_EXPERT_REFERENCES_ASYNC_CONCURRENCY from './frontend-frameworks/swift-expert/references/async-concurrency.md?raw';
import FRONTEND_FRAMEWORKS_SWIFT_EXPERT_REFERENCES_MEMORY_PERFORMANCE from './frontend-frameworks/swift-expert/references/memory-performance.md?raw';
import FRONTEND_FRAMEWORKS_SWIFT_EXPERT_REFERENCES_PROTOCOL_ORIENTED from './frontend-frameworks/swift-expert/references/protocol-oriented.md?raw';
import FRONTEND_FRAMEWORKS_SWIFT_EXPERT_REFERENCES_SWIFTUI_PATTERNS from './frontend-frameworks/swift-expert/references/swiftui-patterns.md?raw';
import FRONTEND_FRAMEWORKS_SWIFT_EXPERT_REFERENCES_TESTING_PATTERNS from './frontend-frameworks/swift-expert/references/testing-patterns.md?raw';
import FRONTEND_FRAMEWORKS_VUE_EXPERT_BODY from './frontend-frameworks/vue-expert/SKILL.md?raw';
import FRONTEND_FRAMEWORKS_VUE_EXPERT_REFERENCES_BUILD_TOOLING from './frontend-frameworks/vue-expert/references/build-tooling.md?raw';
import FRONTEND_FRAMEWORKS_VUE_EXPERT_REFERENCES_COMPONENTS from './frontend-frameworks/vue-expert/references/components.md?raw';
import FRONTEND_FRAMEWORKS_VUE_EXPERT_REFERENCES_COMPOSITION_API from './frontend-frameworks/vue-expert/references/composition-api.md?raw';
import FRONTEND_FRAMEWORKS_VUE_EXPERT_REFERENCES_MOBILE_HYBRID from './frontend-frameworks/vue-expert/references/mobile-hybrid.md?raw';
import FRONTEND_FRAMEWORKS_VUE_EXPERT_REFERENCES_NUXT from './frontend-frameworks/vue-expert/references/nuxt.md?raw';
import FRONTEND_FRAMEWORKS_VUE_EXPERT_REFERENCES_STATE_MANAGEMENT from './frontend-frameworks/vue-expert/references/state-management.md?raw';
import FRONTEND_FRAMEWORKS_VUE_EXPERT_REFERENCES_TYPESCRIPT from './frontend-frameworks/vue-expert/references/typescript.md?raw';
import FRONTEND_FRAMEWORKS_VUE_EXPERT_JS_BODY from './frontend-frameworks/vue-expert-js/SKILL.md?raw';
import FRONTEND_FRAMEWORKS_VUE_EXPERT_JS_REFERENCES_COMPONENT_ARCHITECTURE from './frontend-frameworks/vue-expert-js/references/component-architecture.md?raw';
import FRONTEND_FRAMEWORKS_VUE_EXPERT_JS_REFERENCES_COMPOSABLES_PATTERNS from './frontend-frameworks/vue-expert-js/references/composables-patterns.md?raw';
import FRONTEND_FRAMEWORKS_VUE_EXPERT_JS_REFERENCES_JSDOC_TYPING from './frontend-frameworks/vue-expert-js/references/jsdoc-typing.md?raw';
import FRONTEND_FRAMEWORKS_VUE_EXPERT_JS_REFERENCES_STATE_MANAGEMENT from './frontend-frameworks/vue-expert-js/references/state-management.md?raw';
import FRONTEND_FRAMEWORKS_VUE_EXPERT_JS_REFERENCES_TESTING_PATTERNS from './frontend-frameworks/vue-expert-js/references/testing-patterns.md?raw';
import FRONTEND_FRAMEWORKS_WORDPRESS_PRO_BODY from './frontend-frameworks/wordpress-pro/SKILL.md?raw';
import FRONTEND_FRAMEWORKS_WORDPRESS_PRO_REFERENCES_GUTENBERG_BLOCKS from './frontend-frameworks/wordpress-pro/references/gutenberg-blocks.md?raw';
import FRONTEND_FRAMEWORKS_WORDPRESS_PRO_REFERENCES_HOOKS_FILTERS from './frontend-frameworks/wordpress-pro/references/hooks-filters.md?raw';
import FRONTEND_FRAMEWORKS_WORDPRESS_PRO_REFERENCES_PERFORMANCE_SECURITY from './frontend-frameworks/wordpress-pro/references/performance-security.md?raw';
import FRONTEND_FRAMEWORKS_WORDPRESS_PRO_REFERENCES_PLUGIN_ARCHITECTURE from './frontend-frameworks/wordpress-pro/references/plugin-architecture.md?raw';
import FRONTEND_FRAMEWORKS_WORDPRESS_PRO_REFERENCES_THEME_DEVELOPMENT from './frontend-frameworks/wordpress-pro/references/theme-development.md?raw';

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
  {
    'references/components.md': FRONTEND_FRAMEWORKS_ANGULAR_ARCHITECT_REFERENCES_COMPONENTS,
    'references/ngrx.md': FRONTEND_FRAMEWORKS_ANGULAR_ARCHITECT_REFERENCES_NGRX,
    'references/routing.md': FRONTEND_FRAMEWORKS_ANGULAR_ARCHITECT_REFERENCES_ROUTING,
    'references/rxjs.md': FRONTEND_FRAMEWORKS_ANGULAR_ARCHITECT_REFERENCES_RXJS,
    'references/testing.md': FRONTEND_FRAMEWORKS_ANGULAR_ARCHITECT_REFERENCES_TESTING,
  },
);

export const FRONTEND_FRAMEWORKS_FLUTTER_EXPERT_SKILL = makeBuiltin(
  FRONTEND_FRAMEWORKS_FLUTTER_EXPERT_BODY,
  'frontend-frameworks.flutter-expert',
  'builtin://frontend-frameworks/flutter-expert',
  { isSubSkill: true },
  {
    'references/bloc-state.md': FRONTEND_FRAMEWORKS_FLUTTER_EXPERT_REFERENCES_BLOC_STATE,
    'references/gorouter-navigation.md': FRONTEND_FRAMEWORKS_FLUTTER_EXPERT_REFERENCES_GOROUTER_NAVIGATION,
    'references/performance.md': FRONTEND_FRAMEWORKS_FLUTTER_EXPERT_REFERENCES_PERFORMANCE,
    'references/project-structure.md': FRONTEND_FRAMEWORKS_FLUTTER_EXPERT_REFERENCES_PROJECT_STRUCTURE,
    'references/riverpod-state.md': FRONTEND_FRAMEWORKS_FLUTTER_EXPERT_REFERENCES_RIVERPOD_STATE,
    'references/widget-patterns.md': FRONTEND_FRAMEWORKS_FLUTTER_EXPERT_REFERENCES_WIDGET_PATTERNS,
  },
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
  {
    'references/app-router.md': FRONTEND_FRAMEWORKS_NEXTJS_DEVELOPER_REFERENCES_APP_ROUTER,
    'references/data-fetching.md': FRONTEND_FRAMEWORKS_NEXTJS_DEVELOPER_REFERENCES_DATA_FETCHING,
    'references/deployment.md': FRONTEND_FRAMEWORKS_NEXTJS_DEVELOPER_REFERENCES_DEPLOYMENT,
    'references/server-actions.md': FRONTEND_FRAMEWORKS_NEXTJS_DEVELOPER_REFERENCES_SERVER_ACTIONS,
    'references/server-components.md': FRONTEND_FRAMEWORKS_NEXTJS_DEVELOPER_REFERENCES_SERVER_COMPONENTS,
  },
);

export const FRONTEND_FRAMEWORKS_REACT_EXPERT_SKILL = makeBuiltin(
  FRONTEND_FRAMEWORKS_REACT_EXPERT_BODY,
  'frontend-frameworks.react-expert',
  'builtin://frontend-frameworks/react-expert',
  { isSubSkill: true },
  {
    'references/hooks-patterns.md': FRONTEND_FRAMEWORKS_REACT_EXPERT_REFERENCES_HOOKS_PATTERNS,
    'references/migration-class-to-modern.md': FRONTEND_FRAMEWORKS_REACT_EXPERT_REFERENCES_MIGRATION_CLASS_TO_MODERN,
    'references/performance.md': FRONTEND_FRAMEWORKS_REACT_EXPERT_REFERENCES_PERFORMANCE,
    'references/react-19-features.md': FRONTEND_FRAMEWORKS_REACT_EXPERT_REFERENCES_REACT_19_FEATURES,
    'references/server-components.md': FRONTEND_FRAMEWORKS_REACT_EXPERT_REFERENCES_SERVER_COMPONENTS,
    'references/state-management.md': FRONTEND_FRAMEWORKS_REACT_EXPERT_REFERENCES_STATE_MANAGEMENT,
    'references/testing-react.md': FRONTEND_FRAMEWORKS_REACT_EXPERT_REFERENCES_TESTING_REACT,
  },
);

export const FRONTEND_FRAMEWORKS_REACT_NATIVE_EXPERT_SKILL = makeBuiltin(
  FRONTEND_FRAMEWORKS_REACT_NATIVE_EXPERT_BODY,
  'frontend-frameworks.react-native-expert',
  'builtin://frontend-frameworks/react-native-expert',
  { isSubSkill: true },
  {
    'references/expo-router.md': FRONTEND_FRAMEWORKS_REACT_NATIVE_EXPERT_REFERENCES_EXPO_ROUTER,
    'references/list-optimization.md': FRONTEND_FRAMEWORKS_REACT_NATIVE_EXPERT_REFERENCES_LIST_OPTIMIZATION,
    'references/platform-handling.md': FRONTEND_FRAMEWORKS_REACT_NATIVE_EXPERT_REFERENCES_PLATFORM_HANDLING,
    'references/project-structure.md': FRONTEND_FRAMEWORKS_REACT_NATIVE_EXPERT_REFERENCES_PROJECT_STRUCTURE,
    'references/storage-hooks.md': FRONTEND_FRAMEWORKS_REACT_NATIVE_EXPERT_REFERENCES_STORAGE_HOOKS,
  },
);

export const FRONTEND_FRAMEWORKS_SHOPIFY_EXPERT_SKILL = makeBuiltin(
  FRONTEND_FRAMEWORKS_SHOPIFY_EXPERT_BODY,
  'frontend-frameworks.shopify-expert',
  'builtin://frontend-frameworks/shopify-expert',
  { isSubSkill: true },
  {
    'references/app-development.md': FRONTEND_FRAMEWORKS_SHOPIFY_EXPERT_REFERENCES_APP_DEVELOPMENT,
    'references/checkout-customization.md': FRONTEND_FRAMEWORKS_SHOPIFY_EXPERT_REFERENCES_CHECKOUT_CUSTOMIZATION,
    'references/liquid-templating.md': FRONTEND_FRAMEWORKS_SHOPIFY_EXPERT_REFERENCES_LIQUID_TEMPLATING,
    'references/performance-optimization.md': FRONTEND_FRAMEWORKS_SHOPIFY_EXPERT_REFERENCES_PERFORMANCE_OPTIMIZATION,
    'references/storefront-api.md': FRONTEND_FRAMEWORKS_SHOPIFY_EXPERT_REFERENCES_STOREFRONT_API,
  },
);

export const FRONTEND_FRAMEWORKS_SWIFT_EXPERT_SKILL = makeBuiltin(
  FRONTEND_FRAMEWORKS_SWIFT_EXPERT_BODY,
  'frontend-frameworks.swift-expert',
  'builtin://frontend-frameworks/swift-expert',
  { isSubSkill: true },
  {
    'references/async-concurrency.md': FRONTEND_FRAMEWORKS_SWIFT_EXPERT_REFERENCES_ASYNC_CONCURRENCY,
    'references/memory-performance.md': FRONTEND_FRAMEWORKS_SWIFT_EXPERT_REFERENCES_MEMORY_PERFORMANCE,
    'references/protocol-oriented.md': FRONTEND_FRAMEWORKS_SWIFT_EXPERT_REFERENCES_PROTOCOL_ORIENTED,
    'references/swiftui-patterns.md': FRONTEND_FRAMEWORKS_SWIFT_EXPERT_REFERENCES_SWIFTUI_PATTERNS,
    'references/testing-patterns.md': FRONTEND_FRAMEWORKS_SWIFT_EXPERT_REFERENCES_TESTING_PATTERNS,
  },
);

export const FRONTEND_FRAMEWORKS_VUE_EXPERT_SKILL = makeBuiltin(
  FRONTEND_FRAMEWORKS_VUE_EXPERT_BODY,
  'frontend-frameworks.vue-expert',
  'builtin://frontend-frameworks/vue-expert',
  { isSubSkill: true },
  {
    'references/build-tooling.md': FRONTEND_FRAMEWORKS_VUE_EXPERT_REFERENCES_BUILD_TOOLING,
    'references/components.md': FRONTEND_FRAMEWORKS_VUE_EXPERT_REFERENCES_COMPONENTS,
    'references/composition-api.md': FRONTEND_FRAMEWORKS_VUE_EXPERT_REFERENCES_COMPOSITION_API,
    'references/mobile-hybrid.md': FRONTEND_FRAMEWORKS_VUE_EXPERT_REFERENCES_MOBILE_HYBRID,
    'references/nuxt.md': FRONTEND_FRAMEWORKS_VUE_EXPERT_REFERENCES_NUXT,
    'references/state-management.md': FRONTEND_FRAMEWORKS_VUE_EXPERT_REFERENCES_STATE_MANAGEMENT,
    'references/typescript.md': FRONTEND_FRAMEWORKS_VUE_EXPERT_REFERENCES_TYPESCRIPT,
  },
);

export const FRONTEND_FRAMEWORKS_VUE_EXPERT_JS_SKILL = makeBuiltin(
  FRONTEND_FRAMEWORKS_VUE_EXPERT_JS_BODY,
  'frontend-frameworks.vue-expert-js',
  'builtin://frontend-frameworks/vue-expert-js',
  { isSubSkill: true },
  {
    'references/component-architecture.md': FRONTEND_FRAMEWORKS_VUE_EXPERT_JS_REFERENCES_COMPONENT_ARCHITECTURE,
    'references/composables-patterns.md': FRONTEND_FRAMEWORKS_VUE_EXPERT_JS_REFERENCES_COMPOSABLES_PATTERNS,
    'references/jsdoc-typing.md': FRONTEND_FRAMEWORKS_VUE_EXPERT_JS_REFERENCES_JSDOC_TYPING,
    'references/state-management.md': FRONTEND_FRAMEWORKS_VUE_EXPERT_JS_REFERENCES_STATE_MANAGEMENT,
    'references/testing-patterns.md': FRONTEND_FRAMEWORKS_VUE_EXPERT_JS_REFERENCES_TESTING_PATTERNS,
  },
);

export const FRONTEND_FRAMEWORKS_WORDPRESS_PRO_SKILL = makeBuiltin(
  FRONTEND_FRAMEWORKS_WORDPRESS_PRO_BODY,
  'frontend-frameworks.wordpress-pro',
  'builtin://frontend-frameworks/wordpress-pro',
  { isSubSkill: true },
  {
    'references/gutenberg-blocks.md': FRONTEND_FRAMEWORKS_WORDPRESS_PRO_REFERENCES_GUTENBERG_BLOCKS,
    'references/hooks-filters.md': FRONTEND_FRAMEWORKS_WORDPRESS_PRO_REFERENCES_HOOKS_FILTERS,
    'references/performance-security.md': FRONTEND_FRAMEWORKS_WORDPRESS_PRO_REFERENCES_PERFORMANCE_SECURITY,
    'references/plugin-architecture.md': FRONTEND_FRAMEWORKS_WORDPRESS_PRO_REFERENCES_PLUGIN_ARCHITECTURE,
    'references/theme-development.md': FRONTEND_FRAMEWORKS_WORDPRESS_PRO_REFERENCES_THEME_DEVELOPMENT,
  },
);
