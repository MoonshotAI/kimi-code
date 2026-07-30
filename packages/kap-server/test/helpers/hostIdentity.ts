import type { ServerHostIdentity } from '../../src/start';

/**
 * Neutral fixture identity for kap-server tests — stands in for the embedding
 * host's product identity, which `startServer` requires. Tests that care
 * about a specific version or platform build their own literal instead.
 */
export const TEST_HOST_IDENTITY: ServerHostIdentity = {
  productName: 'test-host',
  version: '0.0.0-test',
  platform: 'test_platform',
};
