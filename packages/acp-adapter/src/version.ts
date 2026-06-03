/**
 * ACP protocol version negotiation.
 *
 * Ported from kimi-cli/src/kimi_cli/acp/version.py. Tracks the (negotiation
 * integer, spec tag, SDK version) tuple per supported protocol revision and
 * picks the highest mutually-supported one when the client initializes.
 */

export interface AcpVersionSpec {
  /** Negotiation integer used in InitializeRequest/Response. */
  readonly protocolVersion: number;
  /** ACP specification tag, e.g. "v0.10.x". */
  readonly specTag: string;
  /** Corresponding npm SDK semver string, e.g. "0.23.0". */
  readonly sdkVersion: string;
}

export const CURRENT_VERSION: AcpVersionSpec = {
  protocolVersion: 1,
  specTag: 'v0.10.x',
  sdkVersion: '0.23.0',
};

const SUPPORTED_VERSIONS: ReadonlyMap<number, AcpVersionSpec> = new Map([
  [1, CURRENT_VERSION],
]);

export const MIN_PROTOCOL_VERSION = 1;

/**
 * Negotiate the protocol version with the client.
 *
 * Returns the highest server-supported version that does not exceed the
 * client's requested version. If the client version is lower than
 * {@link MIN_PROTOCOL_VERSION} the server still returns its own current
 * version so the client can decide whether to disconnect.
 */
export function negotiateVersion(clientProtocolVersion: number): AcpVersionSpec {
  if (clientProtocolVersion < MIN_PROTOCOL_VERSION) {
    return CURRENT_VERSION;
  }

  let best: AcpVersionSpec | undefined;
  for (const [ver, spec] of SUPPORTED_VERSIONS) {
    if (ver <= clientProtocolVersion && (best === undefined || ver > best.protocolVersion)) {
      best = spec;
    }
  }
  return best ?? CURRENT_VERSION;
}
