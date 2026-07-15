/**
 * Detect animated WebP by scanning for the ANMF chunk marker.
 * The Rust native codec handles everything else; this tiny check
 * is the only part of the old webp-decode that we still need.
 */
export function isAnimatedWebp(bytes: Uint8Array): boolean {
  if (bytes.length < 50) return false;
  // WebP VP8X chunk: "VP8X" at offset 12, flags at offset 20, bit 1 = animation
  // Simpler: scan for "ANMF" in the first 4096 bytes
  const limit = Math.min(bytes.length - 4, 4096);
  for (let i = 0; i < limit; i++) {
    if (bytes[i] === 0x41 && bytes[i + 1] === 0x4e && bytes[i + 2] === 0x4d && bytes[i + 3] === 0x46) {
      return true;
    }
  }
  return false;
}
