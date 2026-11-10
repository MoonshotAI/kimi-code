import { describe, expect, it } from 'vitest';

import { matchHostProxyPath, upstreamHeaders } from '../src/services/hosts/hostProxy';
import { hostsSectionSchema, isValidHostId } from '../src/services/hosts/hostsConfig';
import {
  HostConnectError,
  classifySshFailure,
  parseBootstrapOutput,
  remoteBinCommand,
} from '../src/services/hosts/sshKapBridge';

const endpoint = { origin: 'http://127.0.0.1:9000', port: 9000, token: 'remote', version: '1.0.0' };

describe('host proxy path', () => {
  it('splits the host id from the upstream path and keeps the query', () => {
    expect(matchHostProxyPath('/api/v1/hosts/dev/proxy/api/v1/sessions?limit=1')).toEqual({
      hostId: 'dev',
      path: '/api/v1/sessions?limit=1',
    });
    expect(matchHostProxyPath('/api/v1/hosts/dev/proxy')).toEqual({ hostId: 'dev', path: '/' });
  });

  it('does not match control-plane routes', () => {
    expect(matchHostProxyPath('/api/v1/hosts')).toBeUndefined();
    expect(matchHostProxyPath('/api/v1/hosts/dev/projects')).toBeUndefined();
  });

  it('replaces local credentials and browser identity on the way upstream', () => {
    expect(
      upstreamHeaders(
        {
          authorization: 'Bearer local',
          origin: 'http://example.test',
          host: '127.0.0.1:58627',
          connection: 'keep-alive',
          'x-kimi-client-id': 'client',
        },
        endpoint,
      ),
    ).toEqual({
      authorization: 'Bearer remote',
      host: '127.0.0.1:9000',
      'x-kimi-client-id': 'client',
    });
  });
});

describe('host configuration', () => {
  it('accepts an alias entry and rejects unknown fields or option-like hosts', () => {
    expect(hostsSectionSchema.safeParse({ dev: { host: 'dev-box', identityFile: '~/.ssh/key' } }).success).toBe(true);
    expect(hostsSectionSchema.safeParse({ dev: { host: 'dev-box', type: 'ssh' } }).success).toBe(false);
    expect(hostsSectionSchema.safeParse({ dev: { host: '-oProxyCommand=x' } }).success).toBe(false);
  });

  it('keeps host ids safe for URL path segments', () => {
    expect(isValidHostId('dev_box-1.example')).toBe(true);
    expect(isValidHostId('a/b')).toBe(false);
    expect(isValidHostId('')).toBe(false);
  });
});

describe('ssh bootstrap', () => {
  it('quotes the remote binary while keeping home expansion', () => {
    expect(remoteBinCommand(undefined)).toBe(`"$HOME"/'.kimi-code/bin/kimi'`);
    expect(remoteBinCommand('kimi')).toBe('kimi');
    expect(remoteBinCommand('/opt/my kimi')).toBe(`'/opt/my kimi'`);
  });

  it('finds the marker line among shell startup noise', () => {
    const stdout = 'welcome\n__KIMI_ENSURE_DAEMON__{"port":1234,"token":"t","version":"1.0.0","agentSocket":"/s"}\n';
    expect(parseBootstrapOutput(stdout)).toEqual({ port: 1234, token: 't', version: '1.0.0', agentSocket: '/s' });
    expect(parseBootstrapOutput('command output without a marker\n')).toBeUndefined();
  });

  it('reports a busy remote as a typed connect failure', () => {
    const stdout = '__KIMI_ENSURE_DAEMON__{"error":"version_mismatch_busy","message":"busy"}\n';
    expect(() => parseBootstrapOutput(stdout)).toThrow(HostConnectError);
    try {
      parseBootstrapOutput(stdout);
    } catch (error) {
      expect((error as HostConnectError).failure).toBe('remote_busy');
    }
  });

  it.each([
    ['ssh: Could not resolve hostname dev: Name or service not known', 255, 'host_not_found'],
    ['ssh: connect to host dev port 22: Connection refused', 255, 'connection_refused'],
    ['ssh: connect to host dev port 22: Operation timed out', 255, 'connect_timeout'],
    ['user@dev: Permission denied (publickey).', 255, 'authentication_failed'],
    ['Host key verification failed.', 255, 'host_key_changed'],
    ['Error: remote port forwarding failed for listen path /s', 255, 'port_forwarding_denied'],
    ['bash: kimi: command not found', 127, 'executor_not_found'],
    ["error: unknown command 'ensure-daemon'", 1, 'executor_outdated'],
    ['something else', 1, 'unknown'],
  ] as const)('classifies %s', (stderr, code, failure) => {
    expect(classifySshFailure(stderr, code)).toBe(failure);
  });
});
