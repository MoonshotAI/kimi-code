/**
 * `kosong/provider` domain (L2) — registration barrel of the OpenAI wire
 * bases. Importing this module registers both OpenAI transports — `openai`
 * (Chat Completions) and `openai_responses` — through their contrib
 * side-effect modules; the base implementations themselves stay
 * registry-free.
 */

import './openai-legacy.contrib';
import './openai-responses.contrib';
