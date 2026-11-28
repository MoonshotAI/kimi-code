import { afterEach, describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';

import { listNetworkAddresses } from '../../../src/cli/sub/web/networks';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    networkInterfaces: vi.fn(actual.networkInterfaces),
  };
});

describe('listNetworkAddresses', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns an empty list instead of throwing when os.networkInterfaces() throws EACCES', () => {
    const err = Object.assign(new Error('uv_interface_addresses returned EACCES'), {
      code: 'ERR_SYSTEM_ERROR',
      syscall: 'uv_interface_addresses',
    });
    vi.mocked(os.networkInterfaces).mockImplementationOnce(() => {
      throw err;
    });

    expect(listNetworkAddresses()).toEqual([]);
  });
});
