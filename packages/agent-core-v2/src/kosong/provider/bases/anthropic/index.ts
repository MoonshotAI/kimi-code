/**
 * `kosong/provider` domain (L2) — registration barrel of the Anthropic wire
 * base. Importing this module registers the `anthropic` transport through
 * its contrib side-effect module; the base implementation itself stays
 * registry-free.
 */

import './anthropic.contrib';
