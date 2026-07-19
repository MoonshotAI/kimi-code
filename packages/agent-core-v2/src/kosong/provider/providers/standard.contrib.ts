/**
 * ⚠ PHASE 4 GAP PATCH — additive lower-layer fill-in, clearly marked.
 *
 * `kosong/provider` domain (L2) — side-effect module: endpoint-only provider
 * definitions for the five canonical vendors.
 *
 * Phase 3 registered only the Kimi vendor definition, so
 * `resolveProviderEndpoint(providerType, env)` answered for `kimi` alone and
 * the legacy config-env-bag fallbacks (`[providers.x.env] OPENAI_API_KEY=…`
 * etc.) had no registry home. Phase 4's `kosong/model` (modelAuth, catalog
 * assembly, env overlay, catalog credential state) resolves every endpoint
 * through the definition registry — hardcoded per-protocol env tables are
 * abolished — so the five canonical vendors each need a definition that
 * declares their env chain. These declarations change nothing else: each
 * vendor's `baseProtocol` equals its protocol id and the trait list is empty,
 * so adapter identity, hook composition, and capability resolution are
 * exactly as they were for an unregistered vendor.
 *
 * No `defaultBaseUrl` is declared: construction-time defaults stay where they
 * always were (inside the bases / their SDKs), matching the legacy env-only
 * fallback semantics precisely. Kimi's endpoint (with its
 * `api.moonshot.ai/v1` default) is declared by its own traits in
 * `providers/kimi/`, not here.
 *
 * Like every contrib, this module is imported for effect only — production
 * gets it from the `src/index.ts` side-effect block; tests import it on
 * demand.
 */

import { registerProviderDefinition } from '../providerDefinition';

registerProviderDefinition({
  id: 'anthropic',
  baseProtocol: 'anthropic',
  traits: [],
  endpoint: { apiKeyEnv: 'ANTHROPIC_API_KEY', baseUrlEnv: 'ANTHROPIC_BASE_URL' },
});

registerProviderDefinition({
  id: 'openai',
  baseProtocol: 'openai',
  traits: [],
  endpoint: { apiKeyEnv: 'OPENAI_API_KEY', baseUrlEnv: 'OPENAI_BASE_URL' },
});

registerProviderDefinition({
  id: 'openai_responses',
  baseProtocol: 'openai_responses',
  traits: [],
  endpoint: { apiKeyEnv: 'OPENAI_API_KEY', baseUrlEnv: 'OPENAI_BASE_URL' },
});

registerProviderDefinition({
  id: 'google-genai',
  baseProtocol: 'google-genai',
  traits: [],
  endpoint: { apiKeyEnv: 'GOOGLE_API_KEY', baseUrlEnv: 'GOOGLE_GEMINI_BASE_URL' },
});

registerProviderDefinition({
  id: 'vertexai',
  baseProtocol: 'vertexai',
  traits: [
    // Two one-line endpoint traits so the aggregated apiKey fallback chain is
    // `VERTEXAI_API_KEY` → `GOOGLE_API_KEY` (legacy precedence preserved).
    { endpoint: () => ({ apiKeyEnv: 'VERTEXAI_API_KEY', baseUrlEnv: 'GOOGLE_VERTEX_BASE_URL' }) },
    { endpoint: () => ({ apiKeyEnv: 'GOOGLE_API_KEY' }) },
  ],
});
