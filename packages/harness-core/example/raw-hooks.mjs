import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function bareSpecifier(specifier) {
  const query = specifier.indexOf('?');
  if (query < 0) {
    return undefined;
  }
  const params = specifier.slice(query + 1).split('#')[0];
  if (!params.split('&').includes('raw')) {
    return undefined;
  }
  return specifier.slice(0, query);
}

export async function resolve(specifier, context, nextResolve) {
  const bare = bareSpecifier(specifier);
  if (bare === undefined) {
    return nextResolve(specifier, context);
  }
  return {
    url: `${new URL(bare, context.parentURL).href}?raw`,
    format: 'module',
    shortCircuit: true,
  };
}

export async function load(url, context, nextLoad) {
  const marker = url.indexOf('?raw');
  if (marker < 0) {
    return nextLoad(url, context);
  }
  return {
    format: 'module',
    shortCircuit: true,
    source: `export default ${JSON.stringify(readFileSync(fileURLToPath(url.slice(0, marker)), 'utf8'))};`,
  };
}
