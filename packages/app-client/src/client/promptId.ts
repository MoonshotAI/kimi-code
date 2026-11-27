const recentLocalPrompts = new Set<string>();

export function newPromptId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const id = `msg_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  recentLocalPrompts.add(id);
  const oldest = recentLocalPrompts.values().next();
  if (recentLocalPrompts.size > 128 && !oldest.done) recentLocalPrompts.delete(oldest.value);
  return id;
}

export function isLocalPromptId(id: string): boolean {
  return recentLocalPrompts.has(id);
}
