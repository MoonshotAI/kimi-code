/**
 * `kosong/provider` domain (L2) — side-effect module: registers the Kimi
 * provider definition.
 *
 * Kimi is not a wire protocol — it is `{ base: 'openai', traits }`: six
 * native-transport traits declaring every deviation from the OpenAI base, one
 * `dialects.anthropic` slice for running over the Anthropic transport, full
 * host-header forwarding, OAuth-catalog model discovery, and an UNKNOWN
 * capability declaration (Kimi model capabilities come from the catalog, not
 * from client-side tables).
 *
 * Deliberately absent (do not reintroduce): a 64-char tool-call-id policy
 * (the base default is identical), an extra-body deep-merge morph, and a
 * vendor-specific provider `name` (the composed provider's name is the
 * base's `'openai'`).
 */

import { UNKNOWN_CAPABILITY } from '#/kosong/contract/capability';

import { registerProviderDefinition } from '../../providerDefinition';
import { kimiAnthropicThinkingTrait } from './kimi-anthropic';
import { kimiMessageShapeTrait } from './kimi-message-shape';
import { kimiParamsTrait } from './kimi-params';
import { kimiReasoningTrait } from './kimi-reasoning';
import { kimiToolSchemaTrait } from './kimi-tool-schema';
import { kimiUsageTrait } from './kimi-usage';
import { kimiVideoUploadTrait } from './kimi-video-upload';

registerProviderDefinition({
  id: 'kimi',
  base: 'openai',
  traits: [
    kimiToolSchemaTrait,
    kimiMessageShapeTrait,
    kimiReasoningTrait,
    kimiUsageTrait,
    kimiParamsTrait,
    kimiVideoUploadTrait,
  ],
  dialects: { anthropic: [kimiAnthropicThinkingTrait] },
  hostHeaders: 'full',
  modelSource: 'oauth-catalog',
  capability: UNKNOWN_CAPABILITY,
});
