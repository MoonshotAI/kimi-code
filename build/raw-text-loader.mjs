import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/**
 * Node ESM `load` hook: import `?raw` files as raw-string modules.
 *
 * This is the runtime counterpart of `build/raw-text-plugin.mjs` (the bundler
 * plugin). The plugin covers build (tsdown); this loader covers source
 * execution — e.g. `tsx`-run dev flows that import `kimi-core` straight from
 * `src`, where no bundler is involved.
 */
export async function load(url, context, nextLoad) {
  const [fileUrl, query = ''] = url.split('?', 2);
  if (query.split('&').includes('raw')) {
    const text = await readFile(fileURLToPath(fileUrl), 'utf-8');
    return {
      format: 'module',
      shortCircuit: true,
      source: `export default ${JSON.stringify(text)};`,
    };
  }
  return nextLoad(url, context);
}
