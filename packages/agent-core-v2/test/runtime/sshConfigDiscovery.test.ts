import { describe, expect, it } from 'vitest';

import { parseSshConfigHosts } from '#/runtime/sshConfigDiscovery';

describe('parseSshConfigHosts', () => {
  it('collects plain Host entries from the main config file', () => {
    const hosts = parseSshConfigHosts(`
Host dev-box
  HostName 192.168.1.10
  User me

Host gym
  HostName gym.example.com
`);
    expect(hosts).toEqual(['dev-box', 'gym']);
  });

  it('filters wildcard and negated patterns', () => {
    const hosts = parseSshConfigHosts(`
Host *
  ServerAliveInterval 15

Host dev-*
  User me

Host !bastion secure
  HostName secure.example.com

Host web? temp*
  HostName x
`);
    expect(hosts).toEqual(['secure']);
  });

  it('ignores Match blocks and keeps later Host entries', () => {
    const hosts = parseSshConfigHosts(`
Host dev-box
  HostName 192.168.1.10

Match host dev-box
  User admin

Match all

Host gym
  HostName gym.example.com
`);
    expect(hosts).toEqual(['dev-box', 'gym']);
  });

  it('supports multiple patterns per Host line, equals syntax, comments, and dedupes', () => {
    const hosts = parseSshConfigHosts(`
# a comment
Host alpha beta # trailing comment
  HostName x
Host=gamma
  HostName y
Host alpha
  HostName z
`);
    expect(hosts).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('returns an empty list for empty or hostless content', () => {
    expect(parseSshConfigHosts('')).toEqual([]);
    expect(parseSshConfigHosts('HostName x\n  User me\n')).toEqual([]);
  });
});
