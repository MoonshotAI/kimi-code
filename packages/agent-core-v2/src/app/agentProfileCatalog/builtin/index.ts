/**
 * `agentProfileCatalog` domain (L3) — builtin profile barrel.
 *
 * Side-effect import: pulling this file triggers the `registerAgentProfile`
 * calls in `./profiles.ts`, populating the module-level catalog before
 * `AgentProfileCatalogService` is instantiated.
 */

import './profiles';
