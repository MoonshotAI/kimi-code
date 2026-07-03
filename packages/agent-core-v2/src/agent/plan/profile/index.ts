/**
 * `plan` domain (L4) — builtin profile contribution barrel.
 *
 * Side-effect import: pulling this file triggers the `registerAgentProfile`
 * call in `./plan.ts`, populating the module-level catalog before
 * `AgentProfileCatalogService` is instantiated.
 */

import './plan';
