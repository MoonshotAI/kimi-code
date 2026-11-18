import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

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
