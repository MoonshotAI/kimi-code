/**
 * `mcp` domain (L5) — MCP server configuration schemas.
 *
 * Owns the `McpServerConfig` schema and its transport variants. These describe
 * the shape of MCP server entries as they appear in configuration (whether in
 * `config.toml` or an MCP-specific config file) and are consumed by the MCP
 * config loader and connection clients.
 */

import { z } from 'zod';

const StringRecordSchema = z.record(z.string(), z.string());

const McpServerCommonFields = {
  enabled: z.boolean().optional(),
  startupTimeoutMs: z.number().int().min(1).max(300_000).optional(),
  toolTimeoutMs: z.number().int().min(1).max(300_000).optional(),
  enabledTools: z.array(z.string()).optional(),
  disabledTools: z.array(z.string()).optional(),
} as const;

export const McpServerStdioConfigSchema = z.object({
  transport: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: StringRecordSchema.optional(),
  cwd: z.string().optional(),
  executor: z.enum(['local', 'kaos']).optional(),
  ...McpServerCommonFields,
});

export type McpServerStdioConfig = z.infer<typeof McpServerStdioConfigSchema>;

export const McpServerHttpConfigSchema = z.object({
  transport: z.literal('http'),
  url: z.string().url(),
  headers: StringRecordSchema.optional(),
  bearerTokenEnvVar: z.string().min(1).optional(),
  env: StringRecordSchema.optional(),
  ...McpServerCommonFields,
});

export type McpServerHttpConfig = z.infer<typeof McpServerHttpConfigSchema>;

export const McpServerSseConfigSchema = z.object({
  transport: z.literal('sse'),
  url: z.string().url(),
  headers: StringRecordSchema.optional(),
  bearerTokenEnvVar: z.string().min(1).optional(),
  env: StringRecordSchema.optional(),
  ...McpServerCommonFields,
});

export type McpServerSseConfig = z.infer<typeof McpServerSseConfigSchema>;
export type McpRemoteServerConfig = McpServerHttpConfig | McpServerSseConfig;

const McpServerConfigDiscriminatedSchema = z.discriminatedUnion('transport', [
  McpServerStdioConfigSchema,
  McpServerHttpConfigSchema,
  McpServerSseConfigSchema,
]);

export const McpServerConfigSchema = z.preprocess((raw) => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw;
  const obj = raw as Record<string, unknown>;
  if ('transport' in obj) return obj;
  if (typeof obj['command'] === 'string' && typeof obj['url'] === 'string') return obj;
  if (typeof obj['command'] === 'string') return { ...obj, transport: 'stdio' };
  if (typeof obj['url'] === 'string') return { ...obj, transport: 'http' };
  return obj;
}, McpServerConfigDiscriminatedSchema);

export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

/**
 * Reject URLs that would let a configured MCP server exfiltrate bearer
 * tokens to internal networks or cloud metadata services. Allows
 * loopback for local development only when the host is literally
 * localhost (not 127.0.0.1 / ::1 / 0.0.0.0), since a developer
 * running a local MCP server typically uses localhost.
 */
export function isSafeMcpRemoteUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  let host = parsed.hostname.toLowerCase();
  // URL.hostname wraps IPv6 literals in brackets (e.g. ``[::1]``); strip them
  // so the IPv6 checks see the bare address.
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  // Only `localhost` is permitted for loopback; numeric 127.0.0.1 / ::1 are
  // blocked so a malicious config cannot smuggle a bearer token to a local
  // service via an IP literal that bypasses DNS review.
  if (host === 'localhost') return true;
  if (isPrivateOrLoopbackIPv4(host)) return false;
  if (isPrivateOrLoopbackIPv6(host)) return false;
  if (looksLikeObfuscatedLoopback(host)) return false;
  return true;
}

function isPrivateOrLoopbackIPv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m === null) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a > 255 || b > 255 || Number(m[3]) > 255 || Number(m[4]) > 255) return false;
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isPrivateOrLoopbackIPv6(host: string): boolean {
  const h = host.toLowerCase();
  if (h === '::1' || h === '::') return true;
  if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
  if (h.startsWith('::ffff:')) {
    const v4 = h.slice('::ffff:'.length);
    if (isPrivateOrLoopbackIPv4(v4)) return true;
  }
  return false;
}

function looksLikeObfuscatedLoopback(host: string): boolean {
  // Decimal / hex / octal encodings of 127.0.0.1 / 0.0.0.0
  if (/^\d+$/.test(host)) {
    const n = Number(host);
    // 2130706433 = 127.0.0.1, 0 = 0.0.0.0
    if (n === 2130706433 || n === 0) return true;
  }
  if (/^0x[0-9a-f]+$/i.test(host)) return true;
  if (/^0[0-7]+(\.[0-7]+)*$/.test(host)) return true;
  return false;
}
