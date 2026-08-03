/**
 * `kosong/provider` domain (L2) — registration barrel of the Google GenAI
 * wire base. Importing this module registers the `google-genai` transport
 * through its contrib side-effect module; the base implementation itself
 * stays registry-free.
 */

import './google-genai.contrib';
