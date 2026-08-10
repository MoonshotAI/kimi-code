import { describe, expect, it } from 'vitest';

import { normalizeRemote } from '../src/remote';

describe('normalizeRemote', () => {
  it.each([
    ['git@github.com:user/repo.git', 'github.com/user/repo'],
    ['https://github.com/user/repo.git', 'github.com/user/repo'],
    ['https://github.com/user/repo', 'github.com/user/repo'],
    ['http://github.com/user/repo.git', 'github.com/user/repo'],
    ['https://user:token@github.com/org/repo.git', 'github.com/org/repo'],
    ['http://user@github.com/org/repo.git', 'github.com/org/repo'],
    ['https://user:pass:word@github.com/repo.git', 'github.com/repo'],
    ['git@host.com:path/to/repo.git', 'host.com/path/to/repo'],
    ['git@host.com:path/to/repo', 'host.com/path/to/repo'],
    ['https://github.com/org/team/repo.git', 'github.com/org/team/repo'],
    ['github.com/user/repo', 'github.com/user/repo'],
    ['github.com/user/repo.git', 'github.com/user/repo'],
    ['user@host.com:path/repo.git', 'host.com/path/repo'],
    ['', ''],
    ['   ', ''],
    ['https://host.com:8443/path/repo.git', 'host.com/8443/path/repo'],
  ])('canonicalizes %s to %s', (url, expected) => {
    expect(normalizeRemote(url)).toBe(expected);
  });
});
