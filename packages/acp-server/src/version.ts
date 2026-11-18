export interface AcpVersionSpec {
  readonly protocolVersion: number;
  readonly specTag: string;
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
