import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { readSshConfigHosts } from '#/remote/declaration/sshConfigHosts';

describe('readSshConfigHosts', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'ssh-config-hosts-'));
    await mkdir(join(home, '.ssh', 'config.d'), { recursive: true });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('lists concrete aliases with their first connection settings and follows includes', async () => {
    await writeFile(join(home, '.ssh', 'config'), [
      '# personal machines',
      'Include config.d/*.conf ~/.ssh/extra',
      'Host devbox dev-*',
      '  HostName devbox.internal',
      '  User alice',
      '  Port 2222',
      'Host devbox',
      '  User ignored',
      'Host "build box" !blocked',
      '  HostName=10.0.0.5 # trailing comment',
      'Match host gpu',
      '  User nobody',
      'Host *',
      '  ServerAliveInterval 30',
    ].join('\n'));
    await writeFile(join(home, '.ssh', 'config.d', 'work.conf'), 'Host gpu\n  HostName gpu.example.com\n');
    await writeFile(join(home, '.ssh', 'config.d', 'notes.txt'), 'Host skipped\n');
    await writeFile(join(home, '.ssh', 'extra'), 'Include config\nHost bastion\n  Port 70000\n');

    const result = await readSshConfigHosts(new HostFileSystem(), home);

    expect(result).toEqual({
      configPath: join(home, '.ssh', 'config'),
      exists: true,
      hosts: [
        { alias: 'gpu', hostName: 'gpu.example.com' },
        { alias: 'bastion' },
        { alias: 'devbox', hostName: 'devbox.internal', user: 'alice', port: 2222 },
        { alias: 'build box', hostName: '10.0.0.5' },
      ],
    });
  });

  it('reports a missing config file without failing', async () => {
    const result = await readSshConfigHosts(new HostFileSystem(), home);
    expect(result).toEqual({ configPath: join(home, '.ssh', 'config'), exists: false, hosts: [] });
  });
});
