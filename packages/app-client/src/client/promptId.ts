const recentLocalPrompts = new Set<string>();

function rememberPromptId(id: string): string {
  recentLocalPrompts.add(id);
  const oldest = recentLocalPrompts.values().next();
  if (recentLocalPrompts.size > 128 && !oldest.done) recentLocalPrompts.delete(oldest.value);
  return id;
}

export function newPromptId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return rememberPromptId(`msg_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`);
}

export function stablePromptId(seed: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  let h3 = 0x85ebca6b;
  let h4 = 0xc2b2ae35;
  for (let i = 0; i < seed.length; i += 1) {
    const code = seed.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193);
    h2 = Math.imul(h2 ^ code, 0x5bd1e995);
    h3 = Math.imul(h3 + code, 0x27d4eb2d);
    h4 = Math.imul(h4 ^ (code + i), 0x165667b1);
  }
  const finalize = (hash: number): string => {
    let x = hash ^ seed.length;
    x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
    x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
    return ((x ^ (x >>> 16)) >>> 0).toString(16).padStart(8, '0');
  };
  return rememberPromptId(`msg_${finalize(h1)}${finalize(h2)}${finalize(h3)}${finalize(h4)}`);
}

export function isLocalPromptId(id: string): boolean {
  return recentLocalPrompts.has(id);
}
