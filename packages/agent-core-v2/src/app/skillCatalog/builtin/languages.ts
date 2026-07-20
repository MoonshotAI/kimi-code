/**
 * `skillCatalog` domain (L3) — builtin `languages` skill bundle.
 */

import type { SkillDefinition } from '#/app/skillCatalog/types';
import { parseSkillText } from '#/app/skillCatalog/parser';

import LANGUAGES_BODY from './languages/SKILL.md?raw';
import LANGUAGES_CPP_PRO_BODY from './languages/cpp-pro/SKILL.md?raw';
import LANGUAGES_CPP_PRO_REFERENCES_BUILD_TOOLING from './languages/cpp-pro/references/build-tooling.md?raw';
import LANGUAGES_CPP_PRO_REFERENCES_CONCURRENCY from './languages/cpp-pro/references/concurrency.md?raw';
import LANGUAGES_CPP_PRO_REFERENCES_MEMORY_PERFORMANCE from './languages/cpp-pro/references/memory-performance.md?raw';
import LANGUAGES_CPP_PRO_REFERENCES_MODERN_CPP from './languages/cpp-pro/references/modern-cpp.md?raw';
import LANGUAGES_CPP_PRO_REFERENCES_TEMPLATES from './languages/cpp-pro/references/templates.md?raw';
import LANGUAGES_GOLANG_PRO_BODY from './languages/golang-pro/SKILL.md?raw';
import LANGUAGES_GOLANG_PRO_REFERENCES_CONCURRENCY from './languages/golang-pro/references/concurrency.md?raw';
import LANGUAGES_GOLANG_PRO_REFERENCES_GENERICS from './languages/golang-pro/references/generics.md?raw';
import LANGUAGES_GOLANG_PRO_REFERENCES_INTERFACES from './languages/golang-pro/references/interfaces.md?raw';
import LANGUAGES_GOLANG_PRO_REFERENCES_PROJECT_STRUCTURE from './languages/golang-pro/references/project-structure.md?raw';
import LANGUAGES_GOLANG_PRO_REFERENCES_TESTING from './languages/golang-pro/references/testing.md?raw';
import LANGUAGES_JAVASCRIPT_PRO_BODY from './languages/javascript-pro/SKILL.md?raw';
import LANGUAGES_JAVASCRIPT_PRO_REFERENCES_ASYNC_PATTERNS from './languages/javascript-pro/references/async-patterns.md?raw';
import LANGUAGES_JAVASCRIPT_PRO_REFERENCES_BROWSER_APIS from './languages/javascript-pro/references/browser-apis.md?raw';
import LANGUAGES_JAVASCRIPT_PRO_REFERENCES_MODERN_SYNTAX from './languages/javascript-pro/references/modern-syntax.md?raw';
import LANGUAGES_JAVASCRIPT_PRO_REFERENCES_MODULES from './languages/javascript-pro/references/modules.md?raw';
import LANGUAGES_JAVASCRIPT_PRO_REFERENCES_NODE_ESSENTIALS from './languages/javascript-pro/references/node-essentials.md?raw';
import LANGUAGES_KOTLIN_SPECIALIST_BODY from './languages/kotlin-specialist/SKILL.md?raw';
import LANGUAGES_KOTLIN_SPECIALIST_REFERENCES_ANDROID_COMPOSE from './languages/kotlin-specialist/references/android-compose.md?raw';
import LANGUAGES_KOTLIN_SPECIALIST_REFERENCES_COROUTINES_FLOW from './languages/kotlin-specialist/references/coroutines-flow.md?raw';
import LANGUAGES_KOTLIN_SPECIALIST_REFERENCES_DSL_IDIOMS from './languages/kotlin-specialist/references/dsl-idioms.md?raw';
import LANGUAGES_KOTLIN_SPECIALIST_REFERENCES_KTOR_SERVER from './languages/kotlin-specialist/references/ktor-server.md?raw';
import LANGUAGES_KOTLIN_SPECIALIST_REFERENCES_MULTIPLATFORM_KMP from './languages/kotlin-specialist/references/multiplatform-kmp.md?raw';
import LANGUAGES_PYTHON_EXPERT_AGENTS from './languages/python-expert/AGENTS.md?raw';
import LANGUAGES_PYTHON_EXPERT_BODY from './languages/python-expert/SKILL.md?raw';
import LANGUAGES_PYTHON_PRO_BODY from './languages/python-pro/SKILL.md?raw';
import LANGUAGES_PYTHON_PRO_REFERENCES_ASYNC_PATTERNS from './languages/python-pro/references/async-patterns.md?raw';
import LANGUAGES_PYTHON_PRO_REFERENCES_PACKAGING from './languages/python-pro/references/packaging.md?raw';
import LANGUAGES_PYTHON_PRO_REFERENCES_STANDARD_LIBRARY from './languages/python-pro/references/standard-library.md?raw';
import LANGUAGES_PYTHON_PRO_REFERENCES_TESTING from './languages/python-pro/references/testing.md?raw';
import LANGUAGES_PYTHON_PRO_REFERENCES_TYPE_SYSTEM from './languages/python-pro/references/type-system.md?raw';
import LANGUAGES_RUST_ENGINEER_BODY from './languages/rust-engineer/SKILL.md?raw';
import LANGUAGES_RUST_ENGINEER_REFERENCES_ASYNC from './languages/rust-engineer/references/async.md?raw';
import LANGUAGES_RUST_ENGINEER_REFERENCES_ERROR_HANDLING from './languages/rust-engineer/references/error-handling.md?raw';
import LANGUAGES_RUST_ENGINEER_REFERENCES_OWNERSHIP from './languages/rust-engineer/references/ownership.md?raw';
import LANGUAGES_RUST_ENGINEER_REFERENCES_TESTING from './languages/rust-engineer/references/testing.md?raw';
import LANGUAGES_RUST_ENGINEER_REFERENCES_TRAITS from './languages/rust-engineer/references/traits.md?raw';
import LANGUAGES_TYPESCRIPT_PRO_BODY from './languages/typescript-pro/SKILL.md?raw';
import LANGUAGES_TYPESCRIPT_PRO_REFERENCES_ADVANCED_TYPES from './languages/typescript-pro/references/advanced-types.md?raw';
import LANGUAGES_TYPESCRIPT_PRO_REFERENCES_CONFIGURATION from './languages/typescript-pro/references/configuration.md?raw';
import LANGUAGES_TYPESCRIPT_PRO_REFERENCES_PATTERNS from './languages/typescript-pro/references/patterns.md?raw';
import LANGUAGES_TYPESCRIPT_PRO_REFERENCES_TYPE_GUARDS from './languages/typescript-pro/references/type-guards.md?raw';
import LANGUAGES_TYPESCRIPT_PRO_REFERENCES_UTILITY_TYPES from './languages/typescript-pro/references/utility-types.md?raw';

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

export const LANGUAGES_SKILL = makeBuiltin(
  LANGUAGES_BODY,
  'languages',
  'builtin://languages',
  { 'has-sub-skill': true },
);

export const LANGUAGES_CPP_PRO_SKILL = makeBuiltin(
  LANGUAGES_CPP_PRO_BODY,
  'languages.cpp-pro',
  'builtin://languages/cpp-pro',
  { isSubSkill: true },
  {
    'references/build-tooling.md': LANGUAGES_CPP_PRO_REFERENCES_BUILD_TOOLING,
    'references/concurrency.md': LANGUAGES_CPP_PRO_REFERENCES_CONCURRENCY,
    'references/memory-performance.md': LANGUAGES_CPP_PRO_REFERENCES_MEMORY_PERFORMANCE,
    'references/modern-cpp.md': LANGUAGES_CPP_PRO_REFERENCES_MODERN_CPP,
    'references/templates.md': LANGUAGES_CPP_PRO_REFERENCES_TEMPLATES,
  },
);

export const LANGUAGES_GOLANG_PRO_SKILL = makeBuiltin(
  LANGUAGES_GOLANG_PRO_BODY,
  'languages.golang-pro',
  'builtin://languages/golang-pro',
  { isSubSkill: true },
  {
    'references/concurrency.md': LANGUAGES_GOLANG_PRO_REFERENCES_CONCURRENCY,
    'references/generics.md': LANGUAGES_GOLANG_PRO_REFERENCES_GENERICS,
    'references/interfaces.md': LANGUAGES_GOLANG_PRO_REFERENCES_INTERFACES,
    'references/project-structure.md': LANGUAGES_GOLANG_PRO_REFERENCES_PROJECT_STRUCTURE,
    'references/testing.md': LANGUAGES_GOLANG_PRO_REFERENCES_TESTING,
  },
);

export const LANGUAGES_JAVASCRIPT_PRO_SKILL = makeBuiltin(
  LANGUAGES_JAVASCRIPT_PRO_BODY,
  'languages.javascript-pro',
  'builtin://languages/javascript-pro',
  { isSubSkill: true },
  {
    'references/async-patterns.md': LANGUAGES_JAVASCRIPT_PRO_REFERENCES_ASYNC_PATTERNS,
    'references/browser-apis.md': LANGUAGES_JAVASCRIPT_PRO_REFERENCES_BROWSER_APIS,
    'references/modern-syntax.md': LANGUAGES_JAVASCRIPT_PRO_REFERENCES_MODERN_SYNTAX,
    'references/modules.md': LANGUAGES_JAVASCRIPT_PRO_REFERENCES_MODULES,
    'references/node-essentials.md': LANGUAGES_JAVASCRIPT_PRO_REFERENCES_NODE_ESSENTIALS,
  },
);

export const LANGUAGES_KOTLIN_SPECIALIST_SKILL = makeBuiltin(
  LANGUAGES_KOTLIN_SPECIALIST_BODY,
  'languages.kotlin-specialist',
  'builtin://languages/kotlin-specialist',
  { isSubSkill: true },
  {
    'references/android-compose.md': LANGUAGES_KOTLIN_SPECIALIST_REFERENCES_ANDROID_COMPOSE,
    'references/coroutines-flow.md': LANGUAGES_KOTLIN_SPECIALIST_REFERENCES_COROUTINES_FLOW,
    'references/dsl-idioms.md': LANGUAGES_KOTLIN_SPECIALIST_REFERENCES_DSL_IDIOMS,
    'references/ktor-server.md': LANGUAGES_KOTLIN_SPECIALIST_REFERENCES_KTOR_SERVER,
    'references/multiplatform-kmp.md': LANGUAGES_KOTLIN_SPECIALIST_REFERENCES_MULTIPLATFORM_KMP,
  },
);

export const LANGUAGES_PYTHON_EXPERT_SKILL = makeBuiltin(
  LANGUAGES_PYTHON_EXPERT_BODY,
  'languages.python-expert',
  'builtin://languages/python-expert',
  { isSubSkill: true },
  { 'AGENTS.md': LANGUAGES_PYTHON_EXPERT_AGENTS },
);

export const LANGUAGES_PYTHON_PRO_SKILL = makeBuiltin(
  LANGUAGES_PYTHON_PRO_BODY,
  'languages.python-pro',
  'builtin://languages/python-pro',
  { isSubSkill: true },
  {
    'references/async-patterns.md': LANGUAGES_PYTHON_PRO_REFERENCES_ASYNC_PATTERNS,
    'references/packaging.md': LANGUAGES_PYTHON_PRO_REFERENCES_PACKAGING,
    'references/standard-library.md': LANGUAGES_PYTHON_PRO_REFERENCES_STANDARD_LIBRARY,
    'references/testing.md': LANGUAGES_PYTHON_PRO_REFERENCES_TESTING,
    'references/type-system.md': LANGUAGES_PYTHON_PRO_REFERENCES_TYPE_SYSTEM,
  },
);

export const LANGUAGES_RUST_ENGINEER_SKILL = makeBuiltin(
  LANGUAGES_RUST_ENGINEER_BODY,
  'languages.rust-engineer',
  'builtin://languages/rust-engineer',
  { isSubSkill: true },
  {
    'references/async.md': LANGUAGES_RUST_ENGINEER_REFERENCES_ASYNC,
    'references/error-handling.md': LANGUAGES_RUST_ENGINEER_REFERENCES_ERROR_HANDLING,
    'references/ownership.md': LANGUAGES_RUST_ENGINEER_REFERENCES_OWNERSHIP,
    'references/testing.md': LANGUAGES_RUST_ENGINEER_REFERENCES_TESTING,
    'references/traits.md': LANGUAGES_RUST_ENGINEER_REFERENCES_TRAITS,
  },
);

export const LANGUAGES_TYPESCRIPT_PRO_SKILL = makeBuiltin(
  LANGUAGES_TYPESCRIPT_PRO_BODY,
  'languages.typescript-pro',
  'builtin://languages/typescript-pro',
  { isSubSkill: true },
  {
    'references/advanced-types.md': LANGUAGES_TYPESCRIPT_PRO_REFERENCES_ADVANCED_TYPES,
    'references/configuration.md': LANGUAGES_TYPESCRIPT_PRO_REFERENCES_CONFIGURATION,
    'references/patterns.md': LANGUAGES_TYPESCRIPT_PRO_REFERENCES_PATTERNS,
    'references/type-guards.md': LANGUAGES_TYPESCRIPT_PRO_REFERENCES_TYPE_GUARDS,
    'references/utility-types.md': LANGUAGES_TYPESCRIPT_PRO_REFERENCES_UTILITY_TYPES,
  },
);
