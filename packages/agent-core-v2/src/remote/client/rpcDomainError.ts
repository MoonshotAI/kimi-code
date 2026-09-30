import { RpcError } from '#/remote/protocol/errors';

export function rpcDomainError(
  error: unknown,
  codes: ReadonlySet<string>,
): { readonly domainCode: string; readonly details: Record<string, unknown> } | undefined {
  if (!(error instanceof RpcError)) return undefined;
  const data = error.data;
  const domainCode =
    data !== null && typeof data === 'object'
      ? (data as Record<string, unknown>)['domainCode']
      : undefined;
  if (typeof domainCode !== 'string' || !codes.has(domainCode)) return undefined;
  return { domainCode, details: data as Record<string, unknown> };
}
