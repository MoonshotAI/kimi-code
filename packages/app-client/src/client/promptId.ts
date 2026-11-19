export function newPromptId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `msg_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
