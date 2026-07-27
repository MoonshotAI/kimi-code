import { describe, it, expect } from 'vitest';

import { parseShellEnvDump, mergeShellEnv } from '../../src/main/shell-env';

const MARK = 'abc123def456';

function dump(env: Record<string, string>): string {
  return `${MARK}${JSON.stringify(env)}${MARK}\n`;
}

describe('parseShellEnvDump', () => {
  it('parses the JSON env object between the marks', () => {
    const env = parseShellEnvDump(dump({ FOO: 'bar', HOME: '/Users/x' }), MARK);
    expect(env).toEqual({ FOO: 'bar', HOME: '/Users/x' });
  });

  it('discards profile output outside the marks', () => {
    const stdout = `p10k garbage\nloading nvm...\n${dump({ FOO: 'bar' })}trailing noise`;
    expect(parseShellEnvDump(stdout, MARK)).toEqual({ FOO: 'bar' });
  });

  it('returns {} when the marks or valid JSON are missing', () => {
    expect(parseShellEnvDump('FOO=bar\n', MARK)).toEqual({});
    expect(parseShellEnvDump(`${MARK}not-json${MARK}`, MARK)).toEqual({});
    expect(parseShellEnvDump(`${MARK}[1,2]${MARK}`, MARK)).toEqual({});
    expect(parseShellEnvDump('', MARK)).toEqual({});
  });

  it('keeps multi-line values and KEY=-lookalikes inside them', () => {
    const env = parseShellEnvDump(dump({ CONFIG: 'first\nTOKEN=secret', FOO: 'bar' }), MARK);
    expect(env).toEqual({ CONFIG: 'first\nTOKEN=secret', FOO: 'bar' });
  });

  it('parses bash exported functions (BASH_FUNC_%%) as their own entries', () => {
    const env = parseShellEnvDump(
      dump({ 'BASH_FUNC_myfn%%': '() {  echo hi\n}', PATH: '/usr/bin' }),
      MARK,
    );
    expect(env).toEqual({ 'BASH_FUNC_myfn%%': '() {  echo hi\n}', PATH: '/usr/bin' });
  });

  it('keeps values containing "=" and quotes', () => {
    const env = parseShellEnvDump(dump({ OPTS: '--flag=a=b "quoted"' }), MARK);
    expect(env).toEqual({ OPTS: '--flag=a=b "quoted"' });
  });

  it('spans Unicode line separators (U+2028/U+2029) in values', () => {
    const env = parseShellEnvDump(dump({ WEIRD: 'a\u2028b\u2029c' }), MARK);
    expect(env).toEqual({ WEIRD: 'a\u2028b\u2029c' });
  });
});

describe('mergeShellEnv', () => {
  it('fills variables missing from the target', () => {
    const target: Record<string, string | undefined> = { HOME: '/Users/x' };
    const applied = mergeShellEnv(target, { GH_TOKEN: 't', HOME: '/other' });
    expect(target['GH_TOKEN']).toBe('t');
    expect(target['HOME']).toBe('/Users/x');
    expect(applied).toEqual(['GH_TOKEN']);
  });

  it('never imports KIMI_* (desktop has its own auth/settings)', () => {
    const target: Record<string, string | undefined> = {};
    const applied = mergeShellEnv(target, {
      KIMI_API_KEY: 'sk',
      KIMI_CODE_DEBUG: '1',
      UNRELATED: 'yes',
    });
    expect(target['KIMI_API_KEY']).toBeUndefined();
    expect(target['KIMI_CODE_DEBUG']).toBeUndefined();
    expect(target['UNRELATED']).toBe('yes');
    expect(applied).toEqual(['UNRELATED']);
  });

  it('filters terminal-session noise', () => {
    const target: Record<string, string | undefined> = {};
    const applied = mergeShellEnv(target, {
      TERM_PROGRAM: 'iTerm.app',
      ITERM_SESSION_ID: 'w0t0',
      ZSH: '/Users/x/.oh-my-zsh',
      ZSH_THEME: 'robbyrussell',
      'BASH_FUNC_f%%': '() {',
      SHLVL: '3',
      GOPATH: '/Users/x/go',
    });
    expect(applied).toEqual(['GOPATH']);
    expect(target['GOPATH']).toBe('/Users/x/go');
    expect(Object.keys(target)).toEqual(['GOPATH']);
  });

  it('appends only missing absolute PATH entries, keeping current order', () => {
    const target: Record<string, string | undefined> = { PATH: '/usr/bin:/bin' };
    const applied = mergeShellEnv(target, {
      PATH: '/opt/homebrew/bin:/usr/bin:relative/bin:.:/Users/x/bin',
    });
    expect(target['PATH']).toBe('/usr/bin:/bin:/opt/homebrew/bin:/Users/x/bin');
    expect(applied).toEqual(['PATH']);
  });

  it('reports no PATH change when nothing is missing', () => {
    const target: Record<string, string | undefined> = { PATH: '/usr/bin:/bin' };
    const applied = mergeShellEnv(target, { PATH: '/usr/bin:/bin' });
    expect(target['PATH']).toBe('/usr/bin:/bin');
    expect(applied).toEqual([]);
  });

  it('treats an unset PATH as fillable', () => {
    const target: Record<string, string | undefined> = {};
    const applied = mergeShellEnv(target, { PATH: '/usr/bin:/opt/homebrew/bin' });
    expect(target['PATH']).toBe('/usr/bin:/opt/homebrew/bin');
    expect(applied).toEqual(['PATH']);
  });
});
