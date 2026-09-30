export function randomHex(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}
