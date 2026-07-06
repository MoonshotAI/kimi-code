/**
 * `skillCatalog` domain barrel — re-exports the skill types, parser, in-memory
 * catalog registry, the generic `ISkillDiscovery` primitive, the `ISkillSource`
 * producer contract and root helpers, the builtin skill set, and the App-scope
 * builtin/user sources. Importing this barrel registers the default in-memory
 * `ISkillDiscovery` plus the `IBuiltinSkillSource` and `IUserFileSkillSource`
 * bindings into the scope registry.
 */

export * from './types';
export * from './parser';
export * from './registry';
export * from './errors';
export * from './skillDiscovery';
export * from './inMemorySkillDiscovery';
export * from './skillSource';
export * from './skillRoots';
export * from './builtin';
export * from './builtinSkillSource';
export * from './userFileSkillSource';
