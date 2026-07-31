/**
 * `kosong/provider` domain — registration barrel of the OpenAI wire
 * bases. Importing this module registers both OpenAI transports — `openai`
 * (Chat Completions) and `openai_responses`.
 */

import './openai-legacy.contrib';
import './openai-responses.contrib';
