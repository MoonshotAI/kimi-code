const MCP_NAME_PREFIX = 'mcp__';
const MCP_NAME_SEPARATOR = '__';
/**
 * Most LLM providers cap tool names around 64 characters. Leave headroom
 * for the prefix and a separator and truncate longer names with a stable
 * hash suffix so collisions remain extremely unlikely.
 */
const MAX_QUALIFIED_LENGTH = 64;

/**
 * Replace any character outside the safe ASCII set with `_`, then collapse
 * any run of `_` into a single underscore. The collapse step guarantees neither the sanitized server
 * nor tool name contains the `__` separator used by {@link qualifyMcpToolName},
 * which lets {@link isMcpToolName}-aware decoders split unambiguously on the
 * first `__` after the prefix.
 */
export function sanitizeMcpNamePart(part: string): string {
  return part.replaceAll(/[^a-zA-Z0-9_-]/g, '_').replaceAll(/_+/g, '_');
}

export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_NAME_PREFIX);
}

/**
 * Produce the qualified MCP tool name used inside the agent and on the wire.
 * If the result would exceed {@link MAX_QUALIFIED_LENGTH}, a deterministic
 * 8-char hash suffix replaces the tail so the prefix structure stays intact.
 */
export function qualifyMcpToolName(serverName: string, toolName: string): string {
  const full = `${MCP_NAME_PREFIX}${sanitizeMcpNamePart(serverName)}${MCP_NAME_SEPARATOR}${sanitizeMcpNamePart(toolName)}`;
  if (full.length <= MAX_QUALIFIED_LENGTH) return full;

  const hash = stableHash8(full);
  const head = full.slice(0, MAX_QUALIFIED_LENGTH - hash.length - 1);
  return `${head}_${hash}`;
}

function stableHash8(input: string): string {
  // 32-bit FNV-1a — enough to disambiguate truncated tool names within a
  // single server's tool list. Not cryptographic; only used for collision
  // resistance among a handful of strings.
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.codePointAt(i)!;
    hash = Math.trunc(Math.imul(hash, 0x01000193));
  }
  // `Math.imul` yields a signed 32-bit int, so coerce to unsigned before
  // hex-encoding — otherwise a negative hash renders as a 9-char `-xxxxxxxx`
  // suffix (the `-` is not a hex digit), breaking the documented 8-char hash.
  const unsigned = hash < 0 ? hash + 0x1_0000_0000 : hash;
  return unsigned.toString(16).padStart(8, '0');
}
