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

  it('imports power-user KIMI_* config (home, endpoints, flags, logging)', () => {
    const target: Record<string, string | undefined> = {};
    const applied = mergeShellEnv(target, {
      KIMI_CODE_HOME: '/Users/x/.kimi-code-2',
      KIMI_CODE_OAUTH_HOST: 'https://auth-test.example.com',
      KIMI_OAUTH_HOST: 'https://auth-test.example.com',
      KIMI_CODE_BASE_URL: 'https://api-test.example.com/coding/v1',
      KIMI_CODE_EXPERIMENTAL_FLAG: '1',
      KIMI_CODE_EXPERIMENTAL_TOOL_SELECT: '1',
      KIMI_LOG_LEVEL: 'debug',
      KIMI_CODE_DEBUG: '1',
      KIMI_DISABLE_TELEMETRY: '1',
    });
    expect(applied).toEqual([
      'KIMI_CODE_HOME',
      'KIMI_CODE_OAUTH_HOST',
      'KIMI_OAUTH_HOST',
      'KIMI_CODE_BASE_URL',
      'KIMI_CODE_EXPERIMENTAL_FLAG',
      'KIMI_CODE_EXPERIMENTAL_TOOL_SELECT',
      'KIMI_LOG_LEVEL',
      'KIMI_CODE_DEBUG',
      'KIMI_DISABLE_TELEMETRY',
    ]);
    expect(target['KIMI_CODE_HOME']).toBe('/Users/x/.kimi-code-2');
  });

  it('blacklists KIMI_* secrets and out-of-band endpoint overrides', () => {
    const target: Record<string, string | undefined> = {};
    const applied = mergeShellEnv(target, {
      KIMI_API_KEY: 'sk',
      KIMI_WEB_SEARCH_API_KEY: 'sk',
      KIMI_FUTURE_API_KEY: 'sk',
      KIMI_CODE_PASSWORD: 'pw',
      KIMI_CODE_CUSTOM_HEADERS: 'X: y',
      KIMI_BASE_URL: 'https://relay.example.com',
      KIMI_WEB_SEARCH_BASE_URL: 'https://relay.example.com',
      KIMI_WEB_FETCH_BASE_URL: 'https://relay.example.com',
    });
    expect(applied).toEqual([]);
    expect(Object.keys(target)).toEqual([]);
  });

  it('blacklists the KIMI_MODEL_* provider-hijack family', () => {
    const target: Record<string, string | undefined> = {};
    const applied = mergeShellEnv(target, {
      KIMI_MODEL_NAME: 'other-model',
      KIMI_MODEL_API_KEY: 'sk',
      KIMI_MODEL_BASE_URL: 'https://relay.example.com',
      KIMI_MODEL_TEMPERATURE: '0.5',
    });
    expect(applied).toEqual([]);
    expect(Object.keys(target)).toEqual([]);
  });

  it('blacklists server defenses, dev switches, and internal plumbing', () => {
    const target: Record<string, string | undefined> = {};
    const applied = mergeShellEnv(target, {
      KIMI_CODE_CORS_ORIGINS: 'https://evil.example.com',
      KIMI_CODE_ALLOWED_HOSTS: 'evil.example.com',
      KIMI_CODE_DISABLE_HOST_CHECK: '1',
      KIMI_DISABLE_OAUTH_LOCK: '1',
      KIMI_SERVER_URL: 'http://127.0.0.1:1',
      KIMI_RENDERER_DEV_URL: 'http://127.0.0.1:5174',
      KIMI_DESKTOP_NO_SHELL_ENV: '1',
      KIMI_PLUGIN_ROOT: '/tmp/plugin',
      KIMI_WSL_CLIPBOARD_IMAGE_PATH: '/tmp/img',
    });
    expect(applied).toEqual([]);
    expect(Object.keys(target)).toEqual([]);
  });

  it('still imports non-KIMI *_API_KEY secrets for tools and MCP servers', () => {
    const target: Record<string, string | undefined> = {};
    const applied = mergeShellEnv(target, { OPENAI_API_KEY: 'sk', TAVILY_API_KEY: 'tv' });
    expect(applied).toEqual(['OPENAI_API_KEY', 'TAVILY_API_KEY']);
    expect(target['OPENAI_API_KEY']).toBe('sk');
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
