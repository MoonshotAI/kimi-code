/**
 * Server origin formatting — builds parseable HTTP origins from bind hosts.
 *
 * Bracket-wraps IPv6 literals per RFC 3986 while leaving DNS names and IPv4
 * addresses unchanged.
 */

export function formatServerOrigin(host: string, port: number): string {
  const urlHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${urlHost}:${String(port)}`;
}
