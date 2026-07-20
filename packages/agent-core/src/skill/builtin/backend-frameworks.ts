import { parseSkillText } from '../parser';
import type { SkillDefinition } from '../types';

import BACKEND_FRAMEWORKS_BODY from './backend-frameworks/SKILL.md?raw';
import BACKEND_FRAMEWORKS_CSHARP_DEVELOPER_BODY from './backend-frameworks/csharp-developer/SKILL.md?raw';
import BACKEND_FRAMEWORKS_CSHARP_DEVELOPER_REFERENCES_ASPNET_CORE from './backend-frameworks/csharp-developer/references/aspnet-core.md?raw';
import BACKEND_FRAMEWORKS_CSHARP_DEVELOPER_REFERENCES_BLAZOR from './backend-frameworks/csharp-developer/references/blazor.md?raw';
import BACKEND_FRAMEWORKS_CSHARP_DEVELOPER_REFERENCES_ENTITY_FRAMEWORK from './backend-frameworks/csharp-developer/references/entity-framework.md?raw';
import BACKEND_FRAMEWORKS_CSHARP_DEVELOPER_REFERENCES_MODERN_CSHARP from './backend-frameworks/csharp-developer/references/modern-csharp.md?raw';
import BACKEND_FRAMEWORKS_CSHARP_DEVELOPER_REFERENCES_PERFORMANCE from './backend-frameworks/csharp-developer/references/performance.md?raw';
import BACKEND_FRAMEWORKS_DJANGO_EXPERT_BODY from './backend-frameworks/django-expert/SKILL.md?raw';
import BACKEND_FRAMEWORKS_DJANGO_EXPERT_REFERENCES_AUTHENTICATION from './backend-frameworks/django-expert/references/authentication.md?raw';
import BACKEND_FRAMEWORKS_DJANGO_EXPERT_REFERENCES_DRF_SERIALIZERS from './backend-frameworks/django-expert/references/drf-serializers.md?raw';
import BACKEND_FRAMEWORKS_DJANGO_EXPERT_REFERENCES_MODELS_ORM from './backend-frameworks/django-expert/references/models-orm.md?raw';
import BACKEND_FRAMEWORKS_DJANGO_EXPERT_REFERENCES_TESTING_DJANGO from './backend-frameworks/django-expert/references/testing-django.md?raw';
import BACKEND_FRAMEWORKS_DJANGO_EXPERT_REFERENCES_VIEWSETS_VIEWS from './backend-frameworks/django-expert/references/viewsets-views.md?raw';
import BACKEND_FRAMEWORKS_DOTNET_CORE_EXPERT_BODY from './backend-frameworks/dotnet-core-expert/SKILL.md?raw';
import BACKEND_FRAMEWORKS_DOTNET_CORE_EXPERT_REFERENCES_AUTHENTICATION from './backend-frameworks/dotnet-core-expert/references/authentication.md?raw';
import BACKEND_FRAMEWORKS_DOTNET_CORE_EXPERT_REFERENCES_CLEAN_ARCHITECTURE from './backend-frameworks/dotnet-core-expert/references/clean-architecture.md?raw';
import BACKEND_FRAMEWORKS_DOTNET_CORE_EXPERT_REFERENCES_CLOUD_NATIVE from './backend-frameworks/dotnet-core-expert/references/cloud-native.md?raw';
import BACKEND_FRAMEWORKS_DOTNET_CORE_EXPERT_REFERENCES_ENTITY_FRAMEWORK from './backend-frameworks/dotnet-core-expert/references/entity-framework.md?raw';
import BACKEND_FRAMEWORKS_DOTNET_CORE_EXPERT_REFERENCES_MINIMAL_APIS from './backend-frameworks/dotnet-core-expert/references/minimal-apis.md?raw';
import BACKEND_FRAMEWORKS_FASTAPI_EXPERT_BODY from './backend-frameworks/fastapi-expert/SKILL.md?raw';
import BACKEND_FRAMEWORKS_FASTAPI_EXPERT_REFERENCES_ASYNC_SQLALCHEMY from './backend-frameworks/fastapi-expert/references/async-sqlalchemy.md?raw';
import BACKEND_FRAMEWORKS_FASTAPI_EXPERT_REFERENCES_AUTHENTICATION from './backend-frameworks/fastapi-expert/references/authentication.md?raw';
import BACKEND_FRAMEWORKS_FASTAPI_EXPERT_REFERENCES_ENDPOINTS_ROUTING from './backend-frameworks/fastapi-expert/references/endpoints-routing.md?raw';
import BACKEND_FRAMEWORKS_FASTAPI_EXPERT_REFERENCES_MIGRATION_FROM_DJANGO from './backend-frameworks/fastapi-expert/references/migration-from-django.md?raw';
import BACKEND_FRAMEWORKS_FASTAPI_EXPERT_REFERENCES_PYDANTIC_V2 from './backend-frameworks/fastapi-expert/references/pydantic-v2.md?raw';
import BACKEND_FRAMEWORKS_FASTAPI_EXPERT_REFERENCES_TESTING_ASYNC from './backend-frameworks/fastapi-expert/references/testing-async.md?raw';
import BACKEND_FRAMEWORKS_JAVA_ARCHITECT_BODY from './backend-frameworks/java-architect/SKILL.md?raw';
import BACKEND_FRAMEWORKS_JAVA_ARCHITECT_REFERENCES_JPA_OPTIMIZATION from './backend-frameworks/java-architect/references/jpa-optimization.md?raw';
import BACKEND_FRAMEWORKS_JAVA_ARCHITECT_REFERENCES_REACTIVE_WEBFLUX from './backend-frameworks/java-architect/references/reactive-webflux.md?raw';
import BACKEND_FRAMEWORKS_JAVA_ARCHITECT_REFERENCES_SPRING_BOOT_SETUP from './backend-frameworks/java-architect/references/spring-boot-setup.md?raw';
import BACKEND_FRAMEWORKS_JAVA_ARCHITECT_REFERENCES_SPRING_SECURITY from './backend-frameworks/java-architect/references/spring-security.md?raw';
import BACKEND_FRAMEWORKS_JAVA_ARCHITECT_REFERENCES_TESTING_PATTERNS from './backend-frameworks/java-architect/references/testing-patterns.md?raw';
import BACKEND_FRAMEWORKS_LARAVEL_SPECIALIST_BODY from './backend-frameworks/laravel-specialist/SKILL.md?raw';
import BACKEND_FRAMEWORKS_LARAVEL_SPECIALIST_REFERENCES_ELOQUENT from './backend-frameworks/laravel-specialist/references/eloquent.md?raw';
import BACKEND_FRAMEWORKS_LARAVEL_SPECIALIST_REFERENCES_LIVEWIRE from './backend-frameworks/laravel-specialist/references/livewire.md?raw';
import BACKEND_FRAMEWORKS_LARAVEL_SPECIALIST_REFERENCES_QUEUES from './backend-frameworks/laravel-specialist/references/queues.md?raw';
import BACKEND_FRAMEWORKS_LARAVEL_SPECIALIST_REFERENCES_ROUTING from './backend-frameworks/laravel-specialist/references/routing.md?raw';
import BACKEND_FRAMEWORKS_LARAVEL_SPECIALIST_REFERENCES_TESTING from './backend-frameworks/laravel-specialist/references/testing.md?raw';
import BACKEND_FRAMEWORKS_NESTJS_EXPERT_BODY from './backend-frameworks/nestjs-expert/SKILL.md?raw';
import BACKEND_FRAMEWORKS_NESTJS_EXPERT_REFERENCES_AUTHENTICATION from './backend-frameworks/nestjs-expert/references/authentication.md?raw';
import BACKEND_FRAMEWORKS_NESTJS_EXPERT_REFERENCES_CONTROLLERS_ROUTING from './backend-frameworks/nestjs-expert/references/controllers-routing.md?raw';
import BACKEND_FRAMEWORKS_NESTJS_EXPERT_REFERENCES_DTOS_VALIDATION from './backend-frameworks/nestjs-expert/references/dtos-validation.md?raw';
import BACKEND_FRAMEWORKS_NESTJS_EXPERT_REFERENCES_MIGRATION_FROM_EXPRESS from './backend-frameworks/nestjs-expert/references/migration-from-express.md?raw';
import BACKEND_FRAMEWORKS_NESTJS_EXPERT_REFERENCES_SERVICES_DI from './backend-frameworks/nestjs-expert/references/services-di.md?raw';
import BACKEND_FRAMEWORKS_NESTJS_EXPERT_REFERENCES_TESTING_PATTERNS from './backend-frameworks/nestjs-expert/references/testing-patterns.md?raw';
import BACKEND_FRAMEWORKS_PHP_PRO_BODY from './backend-frameworks/php-pro/SKILL.md?raw';
import BACKEND_FRAMEWORKS_PHP_PRO_REFERENCES_ASYNC_PATTERNS from './backend-frameworks/php-pro/references/async-patterns.md?raw';
import BACKEND_FRAMEWORKS_PHP_PRO_REFERENCES_LARAVEL_PATTERNS from './backend-frameworks/php-pro/references/laravel-patterns.md?raw';
import BACKEND_FRAMEWORKS_PHP_PRO_REFERENCES_MODERN_PHP_FEATURES from './backend-frameworks/php-pro/references/modern-php-features.md?raw';
import BACKEND_FRAMEWORKS_PHP_PRO_REFERENCES_SYMFONY_PATTERNS from './backend-frameworks/php-pro/references/symfony-patterns.md?raw';
import BACKEND_FRAMEWORKS_PHP_PRO_REFERENCES_TESTING_QUALITY from './backend-frameworks/php-pro/references/testing-quality.md?raw';
import BACKEND_FRAMEWORKS_RAILS_EXPERT_BODY from './backend-frameworks/rails-expert/SKILL.md?raw';
import BACKEND_FRAMEWORKS_RAILS_EXPERT_REFERENCES_ACTIVE_RECORD from './backend-frameworks/rails-expert/references/active-record.md?raw';
import BACKEND_FRAMEWORKS_RAILS_EXPERT_REFERENCES_API_DEVELOPMENT from './backend-frameworks/rails-expert/references/api-development.md?raw';
import BACKEND_FRAMEWORKS_RAILS_EXPERT_REFERENCES_BACKGROUND_JOBS from './backend-frameworks/rails-expert/references/background-jobs.md?raw';
import BACKEND_FRAMEWORKS_RAILS_EXPERT_REFERENCES_HOTWIRE_TURBO from './backend-frameworks/rails-expert/references/hotwire-turbo.md?raw';
import BACKEND_FRAMEWORKS_RAILS_EXPERT_REFERENCES_RSPEC_TESTING from './backend-frameworks/rails-expert/references/rspec-testing.md?raw';
import BACKEND_FRAMEWORKS_SALESFORCE_DEVELOPER_BODY from './backend-frameworks/salesforce-developer/SKILL.md?raw';
import BACKEND_FRAMEWORKS_SALESFORCE_DEVELOPER_REFERENCES_APEX_DEVELOPMENT from './backend-frameworks/salesforce-developer/references/apex-development.md?raw';
import BACKEND_FRAMEWORKS_SALESFORCE_DEVELOPER_REFERENCES_DEPLOYMENT_DEVOPS from './backend-frameworks/salesforce-developer/references/deployment-devops.md?raw';
import BACKEND_FRAMEWORKS_SALESFORCE_DEVELOPER_REFERENCES_INTEGRATION_PATTERNS from './backend-frameworks/salesforce-developer/references/integration-patterns.md?raw';
import BACKEND_FRAMEWORKS_SALESFORCE_DEVELOPER_REFERENCES_LIGHTNING_WEB_COMPONENTS from './backend-frameworks/salesforce-developer/references/lightning-web-components.md?raw';
import BACKEND_FRAMEWORKS_SALESFORCE_DEVELOPER_REFERENCES_SOQL_SOSL from './backend-frameworks/salesforce-developer/references/soql-sosl.md?raw';
import BACKEND_FRAMEWORKS_SPRING_BOOT_ENGINEER_BODY from './backend-frameworks/spring-boot-engineer/SKILL.md?raw';
import BACKEND_FRAMEWORKS_SPRING_BOOT_ENGINEER_REFERENCES_CLOUD from './backend-frameworks/spring-boot-engineer/references/cloud.md?raw';
import BACKEND_FRAMEWORKS_SPRING_BOOT_ENGINEER_REFERENCES_DATA from './backend-frameworks/spring-boot-engineer/references/data.md?raw';
import BACKEND_FRAMEWORKS_SPRING_BOOT_ENGINEER_REFERENCES_SECURITY from './backend-frameworks/spring-boot-engineer/references/security.md?raw';
import BACKEND_FRAMEWORKS_SPRING_BOOT_ENGINEER_REFERENCES_TESTING from './backend-frameworks/spring-boot-engineer/references/testing.md?raw';
import BACKEND_FRAMEWORKS_SPRING_BOOT_ENGINEER_REFERENCES_WEB from './backend-frameworks/spring-boot-engineer/references/web.md?raw';
import BACKEND_FRAMEWORKS_WEBSOCKET_ENGINEER_BODY from './backend-frameworks/websocket-engineer/SKILL.md?raw';
import BACKEND_FRAMEWORKS_WEBSOCKET_ENGINEER_REFERENCES_ALTERNATIVES from './backend-frameworks/websocket-engineer/references/alternatives.md?raw';
import BACKEND_FRAMEWORKS_WEBSOCKET_ENGINEER_REFERENCES_PATTERNS from './backend-frameworks/websocket-engineer/references/patterns.md?raw';
import BACKEND_FRAMEWORKS_WEBSOCKET_ENGINEER_REFERENCES_PROTOCOL from './backend-frameworks/websocket-engineer/references/protocol.md?raw';
import BACKEND_FRAMEWORKS_WEBSOCKET_ENGINEER_REFERENCES_SCALING from './backend-frameworks/websocket-engineer/references/scaling.md?raw';
import BACKEND_FRAMEWORKS_WEBSOCKET_ENGINEER_REFERENCES_SECURITY from './backend-frameworks/websocket-engineer/references/security.md?raw';

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
  {
    'references/aspnet-core.md': BACKEND_FRAMEWORKS_CSHARP_DEVELOPER_REFERENCES_ASPNET_CORE,
    'references/blazor.md': BACKEND_FRAMEWORKS_CSHARP_DEVELOPER_REFERENCES_BLAZOR,
    'references/entity-framework.md': BACKEND_FRAMEWORKS_CSHARP_DEVELOPER_REFERENCES_ENTITY_FRAMEWORK,
    'references/modern-csharp.md': BACKEND_FRAMEWORKS_CSHARP_DEVELOPER_REFERENCES_MODERN_CSHARP,
    'references/performance.md': BACKEND_FRAMEWORKS_CSHARP_DEVELOPER_REFERENCES_PERFORMANCE,
  },
);

export const BACKEND_FRAMEWORKS_DJANGO_EXPERT_SKILL = makeBuiltin(
  BACKEND_FRAMEWORKS_DJANGO_EXPERT_BODY,
  'backend-frameworks.django-expert',
  'builtin://backend-frameworks/django-expert',
  { isSubSkill: true },
  {
    'references/authentication.md': BACKEND_FRAMEWORKS_DJANGO_EXPERT_REFERENCES_AUTHENTICATION,
    'references/drf-serializers.md': BACKEND_FRAMEWORKS_DJANGO_EXPERT_REFERENCES_DRF_SERIALIZERS,
    'references/models-orm.md': BACKEND_FRAMEWORKS_DJANGO_EXPERT_REFERENCES_MODELS_ORM,
    'references/testing-django.md': BACKEND_FRAMEWORKS_DJANGO_EXPERT_REFERENCES_TESTING_DJANGO,
    'references/viewsets-views.md': BACKEND_FRAMEWORKS_DJANGO_EXPERT_REFERENCES_VIEWSETS_VIEWS,
  },
);

export const BACKEND_FRAMEWORKS_DOTNET_CORE_EXPERT_SKILL = makeBuiltin(
  BACKEND_FRAMEWORKS_DOTNET_CORE_EXPERT_BODY,
  'backend-frameworks.dotnet-core-expert',
  'builtin://backend-frameworks/dotnet-core-expert',
  { isSubSkill: true },
  {
    'references/authentication.md': BACKEND_FRAMEWORKS_DOTNET_CORE_EXPERT_REFERENCES_AUTHENTICATION,
    'references/clean-architecture.md': BACKEND_FRAMEWORKS_DOTNET_CORE_EXPERT_REFERENCES_CLEAN_ARCHITECTURE,
    'references/cloud-native.md': BACKEND_FRAMEWORKS_DOTNET_CORE_EXPERT_REFERENCES_CLOUD_NATIVE,
    'references/entity-framework.md': BACKEND_FRAMEWORKS_DOTNET_CORE_EXPERT_REFERENCES_ENTITY_FRAMEWORK,
    'references/minimal-apis.md': BACKEND_FRAMEWORKS_DOTNET_CORE_EXPERT_REFERENCES_MINIMAL_APIS,
  },
);

export const BACKEND_FRAMEWORKS_FASTAPI_EXPERT_SKILL = makeBuiltin(
  BACKEND_FRAMEWORKS_FASTAPI_EXPERT_BODY,
  'backend-frameworks.fastapi-expert',
  'builtin://backend-frameworks/fastapi-expert',
  { isSubSkill: true },
  {
    'references/async-sqlalchemy.md': BACKEND_FRAMEWORKS_FASTAPI_EXPERT_REFERENCES_ASYNC_SQLALCHEMY,
    'references/authentication.md': BACKEND_FRAMEWORKS_FASTAPI_EXPERT_REFERENCES_AUTHENTICATION,
    'references/endpoints-routing.md': BACKEND_FRAMEWORKS_FASTAPI_EXPERT_REFERENCES_ENDPOINTS_ROUTING,
    'references/migration-from-django.md': BACKEND_FRAMEWORKS_FASTAPI_EXPERT_REFERENCES_MIGRATION_FROM_DJANGO,
    'references/pydantic-v2.md': BACKEND_FRAMEWORKS_FASTAPI_EXPERT_REFERENCES_PYDANTIC_V2,
    'references/testing-async.md': BACKEND_FRAMEWORKS_FASTAPI_EXPERT_REFERENCES_TESTING_ASYNC,
  },
);

export const BACKEND_FRAMEWORKS_JAVA_ARCHITECT_SKILL = makeBuiltin(
  BACKEND_FRAMEWORKS_JAVA_ARCHITECT_BODY,
  'backend-frameworks.java-architect',
  'builtin://backend-frameworks/java-architect',
  { isSubSkill: true },
  {
    'references/jpa-optimization.md': BACKEND_FRAMEWORKS_JAVA_ARCHITECT_REFERENCES_JPA_OPTIMIZATION,
    'references/reactive-webflux.md': BACKEND_FRAMEWORKS_JAVA_ARCHITECT_REFERENCES_REACTIVE_WEBFLUX,
    'references/spring-boot-setup.md': BACKEND_FRAMEWORKS_JAVA_ARCHITECT_REFERENCES_SPRING_BOOT_SETUP,
    'references/spring-security.md': BACKEND_FRAMEWORKS_JAVA_ARCHITECT_REFERENCES_SPRING_SECURITY,
    'references/testing-patterns.md': BACKEND_FRAMEWORKS_JAVA_ARCHITECT_REFERENCES_TESTING_PATTERNS,
  },
);

export const BACKEND_FRAMEWORKS_LARAVEL_SPECIALIST_SKILL = makeBuiltin(
  BACKEND_FRAMEWORKS_LARAVEL_SPECIALIST_BODY,
  'backend-frameworks.laravel-specialist',
  'builtin://backend-frameworks/laravel-specialist',
  { isSubSkill: true },
  {
    'references/eloquent.md': BACKEND_FRAMEWORKS_LARAVEL_SPECIALIST_REFERENCES_ELOQUENT,
    'references/livewire.md': BACKEND_FRAMEWORKS_LARAVEL_SPECIALIST_REFERENCES_LIVEWIRE,
    'references/queues.md': BACKEND_FRAMEWORKS_LARAVEL_SPECIALIST_REFERENCES_QUEUES,
    'references/routing.md': BACKEND_FRAMEWORKS_LARAVEL_SPECIALIST_REFERENCES_ROUTING,
    'references/testing.md': BACKEND_FRAMEWORKS_LARAVEL_SPECIALIST_REFERENCES_TESTING,
  },
);

export const BACKEND_FRAMEWORKS_NESTJS_EXPERT_SKILL = makeBuiltin(
  BACKEND_FRAMEWORKS_NESTJS_EXPERT_BODY,
  'backend-frameworks.nestjs-expert',
  'builtin://backend-frameworks/nestjs-expert',
  { isSubSkill: true },
  {
    'references/authentication.md': BACKEND_FRAMEWORKS_NESTJS_EXPERT_REFERENCES_AUTHENTICATION,
    'references/controllers-routing.md': BACKEND_FRAMEWORKS_NESTJS_EXPERT_REFERENCES_CONTROLLERS_ROUTING,
    'references/dtos-validation.md': BACKEND_FRAMEWORKS_NESTJS_EXPERT_REFERENCES_DTOS_VALIDATION,
    'references/migration-from-express.md': BACKEND_FRAMEWORKS_NESTJS_EXPERT_REFERENCES_MIGRATION_FROM_EXPRESS,
    'references/services-di.md': BACKEND_FRAMEWORKS_NESTJS_EXPERT_REFERENCES_SERVICES_DI,
    'references/testing-patterns.md': BACKEND_FRAMEWORKS_NESTJS_EXPERT_REFERENCES_TESTING_PATTERNS,
  },
);

export const BACKEND_FRAMEWORKS_PHP_PRO_SKILL = makeBuiltin(
  BACKEND_FRAMEWORKS_PHP_PRO_BODY,
  'backend-frameworks.php-pro',
  'builtin://backend-frameworks/php-pro',
  { isSubSkill: true },
  {
    'references/async-patterns.md': BACKEND_FRAMEWORKS_PHP_PRO_REFERENCES_ASYNC_PATTERNS,
    'references/laravel-patterns.md': BACKEND_FRAMEWORKS_PHP_PRO_REFERENCES_LARAVEL_PATTERNS,
    'references/modern-php-features.md': BACKEND_FRAMEWORKS_PHP_PRO_REFERENCES_MODERN_PHP_FEATURES,
    'references/symfony-patterns.md': BACKEND_FRAMEWORKS_PHP_PRO_REFERENCES_SYMFONY_PATTERNS,
    'references/testing-quality.md': BACKEND_FRAMEWORKS_PHP_PRO_REFERENCES_TESTING_QUALITY,
  },
);

export const BACKEND_FRAMEWORKS_RAILS_EXPERT_SKILL = makeBuiltin(
  BACKEND_FRAMEWORKS_RAILS_EXPERT_BODY,
  'backend-frameworks.rails-expert',
  'builtin://backend-frameworks/rails-expert',
  { isSubSkill: true },
  {
    'references/active-record.md': BACKEND_FRAMEWORKS_RAILS_EXPERT_REFERENCES_ACTIVE_RECORD,
    'references/api-development.md': BACKEND_FRAMEWORKS_RAILS_EXPERT_REFERENCES_API_DEVELOPMENT,
    'references/background-jobs.md': BACKEND_FRAMEWORKS_RAILS_EXPERT_REFERENCES_BACKGROUND_JOBS,
    'references/hotwire-turbo.md': BACKEND_FRAMEWORKS_RAILS_EXPERT_REFERENCES_HOTWIRE_TURBO,
    'references/rspec-testing.md': BACKEND_FRAMEWORKS_RAILS_EXPERT_REFERENCES_RSPEC_TESTING,
  },
);

export const BACKEND_FRAMEWORKS_SALESFORCE_DEVELOPER_SKILL = makeBuiltin(
  BACKEND_FRAMEWORKS_SALESFORCE_DEVELOPER_BODY,
  'backend-frameworks.salesforce-developer',
  'builtin://backend-frameworks/salesforce-developer',
  { isSubSkill: true },
  {
    'references/apex-development.md': BACKEND_FRAMEWORKS_SALESFORCE_DEVELOPER_REFERENCES_APEX_DEVELOPMENT,
    'references/deployment-devops.md': BACKEND_FRAMEWORKS_SALESFORCE_DEVELOPER_REFERENCES_DEPLOYMENT_DEVOPS,
    'references/integration-patterns.md': BACKEND_FRAMEWORKS_SALESFORCE_DEVELOPER_REFERENCES_INTEGRATION_PATTERNS,
    'references/lightning-web-components.md': BACKEND_FRAMEWORKS_SALESFORCE_DEVELOPER_REFERENCES_LIGHTNING_WEB_COMPONENTS,
    'references/soql-sosl.md': BACKEND_FRAMEWORKS_SALESFORCE_DEVELOPER_REFERENCES_SOQL_SOSL,
  },
);

export const BACKEND_FRAMEWORKS_SPRING_BOOT_ENGINEER_SKILL = makeBuiltin(
  BACKEND_FRAMEWORKS_SPRING_BOOT_ENGINEER_BODY,
  'backend-frameworks.spring-boot-engineer',
  'builtin://backend-frameworks/spring-boot-engineer',
  { isSubSkill: true },
  {
    'references/cloud.md': BACKEND_FRAMEWORKS_SPRING_BOOT_ENGINEER_REFERENCES_CLOUD,
    'references/data.md': BACKEND_FRAMEWORKS_SPRING_BOOT_ENGINEER_REFERENCES_DATA,
    'references/security.md': BACKEND_FRAMEWORKS_SPRING_BOOT_ENGINEER_REFERENCES_SECURITY,
    'references/testing.md': BACKEND_FRAMEWORKS_SPRING_BOOT_ENGINEER_REFERENCES_TESTING,
    'references/web.md': BACKEND_FRAMEWORKS_SPRING_BOOT_ENGINEER_REFERENCES_WEB,
  },
);

export const BACKEND_FRAMEWORKS_WEBSOCKET_ENGINEER_SKILL = makeBuiltin(
  BACKEND_FRAMEWORKS_WEBSOCKET_ENGINEER_BODY,
  'backend-frameworks.websocket-engineer',
  'builtin://backend-frameworks/websocket-engineer',
  { isSubSkill: true },
  {
    'references/alternatives.md': BACKEND_FRAMEWORKS_WEBSOCKET_ENGINEER_REFERENCES_ALTERNATIVES,
    'references/patterns.md': BACKEND_FRAMEWORKS_WEBSOCKET_ENGINEER_REFERENCES_PATTERNS,
    'references/protocol.md': BACKEND_FRAMEWORKS_WEBSOCKET_ENGINEER_REFERENCES_PROTOCOL,
    'references/scaling.md': BACKEND_FRAMEWORKS_WEBSOCKET_ENGINEER_REFERENCES_SCALING,
    'references/security.md': BACKEND_FRAMEWORKS_WEBSOCKET_ENGINEER_REFERENCES_SECURITY,
  },
);

