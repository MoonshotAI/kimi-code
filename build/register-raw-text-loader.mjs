import { register } from 'node:module';

/**
 * Registers the `?raw` text loader. Pass to Node via `--import` (alongside
 * tsx) so source-executed code can import text files.
 */
register('./raw-text-loader.mjs', import.meta.url);
