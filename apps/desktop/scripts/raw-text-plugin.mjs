import { readFileSync } from 'node:fs';

/**
 * Rolldown plugin: inline files imported with a `?raw` suffix as strings.
 *
 *   import systemMd from './profile/default/system.md?raw';
 *
 * Strips `?raw`, resolves the real file relative to the importer, and inlines
 * its UTF-8 content as `export default "<content>"`. Mirrors the semantics of
 * Vite's `?raw` asset imports (used inside kimi-code's agent-core for prompt
 * source files) so they never ship separately in the Electron bundle.
 */
const PREFIX = '\0raw:';

export function rawTextPlugin() {
  return {
    name: 'raw-text',
    async resolveId(source, importer) {
      const q = source.indexOf('?');
      if (q === -1) return null;
      const query = source.slice(q + 1);
      if (!query.split('&').includes('raw')) return null;
      const spec = source.slice(0, q);
      const resolved = await this.resolve(spec, importer, { skipSelf: true });
      if (resolved === null) return null;
      return { id: PREFIX + resolved.id };
    },
    load(id) {
      if (!id.startsWith(PREFIX)) return null;
      const path = id.slice(PREFIX.length);
      const text = readFileSync(path, 'utf-8');
      return { code: `export default ${JSON.stringify(text)};`, map: null };
    },
  };
}
