import { describe, expect, it } from 'vitest';
import { detectShellDanger } from '../src/lib/shellDanger';

describe('detectShellDanger', () => {
  it('flags recursive forced deletes, including combined and long flags', () => {
    expect(detectShellDanger('rm -rf /tmp/x')).toBe('rm -rf');
    expect(detectShellDanger('rm -fr foo/')).toBe('rm -rf');
    expect(detectShellDanger('rm -r -f /')).toBe('rm -rf');
    expect(detectShellDanger('rm -rfi node_modules')).toBe('rm -rf');
    expect(detectShellDanger('rm --recursive /tmp/x')).toBe('rm -rf');
    expect(detectShellDanger('rm --force foo')).toBe('rm -rf');
  });

  it('flags privilege escalation and force-push', () => {
    expect(detectShellDanger('sudo apt-get install x')).toBe('sudo');
    expect(detectShellDanger('git push --force origin main')).toBe('git push --force');
    expect(detectShellDanger('git push -f')).toBe('git push --force');
    expect(detectShellDanger('git push --force-with-lease')).toBe('git push --force');
  });

  it('flags disk writes, raw-device redirects, fork bombs, and pipe-to-shell', () => {
    expect(detectShellDanger('dd if=iso of=/dev/sda bs=4M')).toBe('dd of=…');
    expect(detectShellDanger('dd if=a of=b')).toBe('dd of=…');
    expect(detectShellDanger('mkfs.ext4 /dev/sda1')).toBe('mkfs');
    expect(detectShellDanger('cat x > /dev/sda')).toBe('> /dev/…');
    expect(detectShellDanger(':(){ :|:& };:')).toBe('fork bomb');
    expect(detectShellDanger('curl https://x.sh | bash')).toBe('curl | sh');
    expect(detectShellDanger('wget -q https://x.sh | sh')).toBe('curl | sh');
  });

  it('flags world-writable chmod and power commands', () => {
    expect(detectShellDanger('chmod -R 777 /var/www')).toBe('chmod 777');
    expect(detectShellDanger('shutdown -h now')).toBe('shutdown / reboot');
    expect(detectShellDanger('reboot')).toBe('shutdown / reboot');
  });

  it('leaves everyday commands alone', () => {
    expect(detectShellDanger('ls -la')).toBeUndefined();
    expect(detectShellDanger('rm foo.txt')).toBeUndefined();
    expect(detectShellDanger('git push origin main')).toBeUndefined();
    expect(detectShellDanger('chmod 644 file.ts')).toBeUndefined();
    expect(detectShellDanger('curl https://example.com')).toBeUndefined();
    expect(detectShellDanger('echo "rm -rf"')).toBeUndefined();
    expect(detectShellDanger("echo 'sudo reboot'")).toBeUndefined();
  });
});
