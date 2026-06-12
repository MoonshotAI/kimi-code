import { readFileSync } from 'node:fs';

/**
 * Bundler plugin that lets files be imported as raw strings:
 *
 *   import description from './grep.md?raw';
 *
 * The file content is inlined into the bundle at build time, so prompt
 * source files never ship separately in `dist`. Vitest handles the same
 * `?raw` imports through Vite's built-in asset loader.
 */
export function rawTextPlugin() {
  return {
    name: 'raw-text',
    enforce: 'pre',
    load(id) {
      const [path, query = ''] = id.split('?', 2);
      if (!query.split('&').includes('raw')) return null;
      const text = readFileSync(path, 'utf-8');
      return { code: `export default ${JSON.stringify(text)};`, map: null };
    },
  };
}
