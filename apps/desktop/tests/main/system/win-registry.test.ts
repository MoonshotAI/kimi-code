import { describe, expect, it, vi } from 'vitest';

import { buildRegQueryCommand, createRegQuery, parseRegOutput } from '../../../src/main/system/win-registry';

describe('buildRegQueryCommand', () => {
  it('forces UTF-8 output and quotes arguments containing spaces', () => {
    expect(
      buildRegQueryCommand([
        'query',
        'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Code.exe',
        '/ve',
      ]),
    ).toBe(
      'chcp 65001>nul & reg.exe query "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Code.exe" /ve',
    );
  });

  it('leaves plain arguments unquoted', () => {
    expect(buildRegQueryCommand(['query', 'HKLM\\SOFTWARE\\GitForWindows', '/v', 'InstallPath'])).toBe(
      'chcp 65001>nul & reg.exe query HKLM\\SOFTWARE\\GitForWindows /v InstallPath',
    );
  });
});

describe('parseRegOutput', () => {
  it('extracts the default value from English output', () => {
    const output = [
      '',
      'HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Code.exe',
      '    (Default)    REG_SZ    T:\\Microsoft VS Code\\Code.exe',
      '',
    ].join('\r\n');
    expect(parseRegOutput(output)).toBe('T:\\Microsoft VS Code\\Code.exe');
  });

  it('extracts the default value from localized output', () => {
    const output = [
      '',
      'HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Code.exe',
      '    (默认)    REG_SZ    T:\\Microsoft VS Code\\Code.exe',
      '',
    ].join('\r\n');
    expect(parseRegOutput(output)).toBe('T:\\Microsoft VS Code\\Code.exe');
  });

  it('extracts a named value', () => {
    const output = [
      '',
      'HKEY_LOCAL_MACHINE\\SOFTWARE\\GitForWindows',
      '    InstallPath    REG_SZ    D:\\Tools\\Git',
      '',
    ].join('\r\n');
    expect(parseRegOutput(output)).toBe('D:\\Tools\\Git');
  });

  it('returns null when there is no value line', () => {
    expect(parseRegOutput('\r\nHKEY_CURRENT_USER\\SOFTWARE\\None\r\n')).toBe(null);
  });
});

describe('createRegQuery', () => {
  it('queries the default value with /ve and named values with /v', async () => {
    const run = vi.fn().mockResolvedValue('    (Default)    REG_SZ    C:\\Apps\\Code.exe');
    const query = createRegQuery(run);
    await query('HKCU\\Some\\Key', null);
    await query('HKCU\\Some\\Key', 'InstallLocation');
    expect(run).toHaveBeenNthCalledWith(1, ['query', 'HKCU\\Some\\Key', '/ve']);
    expect(run).toHaveBeenNthCalledWith(2, ['query', 'HKCU\\Some\\Key', '/v', 'InstallLocation']);
  });

  it('maps missing keys to null', async () => {
    const query = createRegQuery(vi.fn().mockResolvedValue(null));
    expect(await query('HKCU\\Missing', null)).toBe(null);
  });

  it('caches successful results per key and value', async () => {
    const run = vi.fn().mockResolvedValue('    (Default)    REG_SZ    C:\\Apps\\Code.exe');
    const query = createRegQuery(run);
    expect(await query('HKCU\\Some\\Key', null)).toBe('C:\\Apps\\Code.exe');
    expect(await query('HKCU\\Some\\Key', null)).toBe('C:\\Apps\\Code.exe');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not cache misses, so a later install or recovered query is picked up', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('    (Default)    REG_SZ    C:\\Apps\\Code.exe');
    const query = createRegQuery(run);
    expect(await query('HKCU\\Some\\Key', null)).toBe(null);
    expect(await query('HKCU\\Some\\Key', null)).toBe('C:\\Apps\\Code.exe');
    expect(run).toHaveBeenCalledTimes(2);
  });
});
