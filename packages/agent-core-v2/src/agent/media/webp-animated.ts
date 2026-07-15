export function isAnimatedWebp(bytes: Uint8Array): boolean {
  if (bytes.length < 50) return false;
  const limit = Math.min(bytes.length - 4, 4096);
  for (let i = 0; i < limit; i++) {
    if (bytes[i] === 0x41 && bytes[i + 1] === 0x4e && bytes[i + 2] === 0x4d && bytes[i + 3] === 0x46) {
      return true;
    }
  }
  return false;
}
