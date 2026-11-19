import { readFileSync } from 'node:fs';

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
