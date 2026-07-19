/**
 * `kosong/provider` domain (L2) — side-effect module: registers the Kimi
 * provider definitions, one per transport Kimi runs over.
 *
 * Kimi is not a wire protocol — it is a set of vendor registrations:
 *
 *  - `(kimi, openai)`: six traits declaring every deviation from the OpenAI
 *    base on Kimi's native transport;
 *  - `(kimi, anthropic)`: the single thinking trait for running Kimi models
 *    over the Anthropic transport.
 *
 * Vendor-level facts — the endpoint fallback chain, full host-header
 * forwarding, OAuth-catalog model discovery, and the UNKNOWN capability
 * declaration (Kimi model capabilities come from the catalog, not from
 * client-side tables) — are shared constants declared identically on both
 * registrations, so id-level queries read either one.
 *
 * Deliberately absent (do not reintroduce): a 64-char tool-call-id policy
 * (the base default is identical), an extra-body deep-merge morph, and a
 * vendor-specific provider `name` (the composed provider's name is the
 * base's `'openai'`).
 */

import { UNKNOWN_CAPABILITY } from '#/kosong/contract/capability';
import type { ProtocolEndpoint } from '#/kosong/protocol/protocolTrait';

import { registerProviderDefinition } from '../../providerDefinition';
import { kimiAnthropicThinkingTrait } from './kimi-anthropic';
import { kimiMessageShapeTrait } from './kimi-message-shape';
import {
  KIMI_API_KEY_ENV,
  KIMI_BASE_URL_ENV,
  KIMI_DEFAULT_BASE_URL,
  kimiParamsTrait,
} from './kimi-params';
import { kimiReasoningTrait } from './kimi-reasoning';
import { kimiToolSchemaTrait } from './kimi-tool-schema';
import { kimiUsageTrait } from './kimi-usage';
import { kimiVideoUploadTrait } from './kimi-video-upload';

/** The vendor-level endpoint declaration, shared by both registrations. */
const kimiEndpoint: ProtocolEndpoint = {
  apiKeyEnv: KIMI_API_KEY_ENV,
  baseUrlEnv: KIMI_BASE_URL_ENV,
  defaultBaseUrl: KIMI_DEFAULT_BASE_URL,
};

registerProviderDefinition({
  id: 'kimi',
  baseProtocol: 'openai',
  traits: [
    kimiToolSchemaTrait,
    kimiMessageShapeTrait,
    kimiReasoningTrait,
    kimiUsageTrait,
    kimiParamsTrait,
    kimiVideoUploadTrait,
  ],
  endpoint: kimiEndpoint,
  hostHeaders: 'full',
  modelSource: 'oauth-catalog',
  capability: UNKNOWN_CAPABILITY,
});

registerProviderDefinition({
  id: 'kimi',
  baseProtocol: 'anthropic',
  traits: [kimiAnthropicThinkingTrait],
  endpoint: kimiEndpoint,
  hostHeaders: 'full',
  modelSource: 'oauth-catalog',
  capability: UNKNOWN_CAPABILITY,
});
