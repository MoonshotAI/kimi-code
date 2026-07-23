/**
 * envScrub tests for the v2 sandbox domain.
 *
 * Covers the sensitive env-name classifier: case-insensitive suffix matching
 * (`_API_KEY`, `_KEY`, `_TOKEN`, `_SECRET`, `_PASSWORD`, `_CREDENTIALS`), the
 * exact agent/socket list, and non-matches.
 */

import { describe, expect, it } from 'vitest';

import { isSensitiveEnvName, sensitiveEnvNames } from '#/session/sandbox/envScrub';

describe('isSensitiveEnvName', () => {
  it('matches the secret suffixes case-insensitively', () => {
    expect(isSensitiveEnvName('KIMI_API_KEY')).toBe(true);
    expect(isSensitiveEnvName('OPENAI_API_KEY')).toBe(true);
    expect(isSensitiveEnvName('openai_api_key')).toBe(true);
    expect(isSensitiveEnvName('AWS_SECRET_ACCESS_TOKEN')).toBe(true);
    expect(isSensitiveEnvName('github_token')).toBe(true);
    expect(isSensitiveEnvName('DB_PASSWORD')).toBe(true);
    expect(isSensitiveEnvName('MY_SECRET')).toBe(true);
    expect(isSensitiveEnvName('GCP_CREDENTIALS')).toBe(true);
    expect(isSensitiveEnvName('ENCRYPTION_KEY')).toBe(true);
  });

  it('matches the exact agent/socket list', () => {
    expect(isSensitiveEnvName('SSH_AUTH_SOCK')).toBe(true);
    expect(isSensitiveEnvName('SSH_AGENT_PID')).toBe(true);
    expect(isSensitiveEnvName('GPG_AGENT_INFO')).toBe(true);
    expect(isSensitiveEnvName('XAUTHORITY')).toBe(true);
    expect(isSensitiveEnvName('ssh_auth_sock')).toBe(true);
  });

  it('does not match ordinary variables or near-misses', () => {
    expect(isSensitiveEnvName('PATH')).toBe(false);
    expect(isSensitiveEnvName('HOME')).toBe(false);
    expect(isSensitiveEnvName('KEY')).toBe(false);
    expect(isSensitiveEnvName('_KEY')).toBe(false);
    expect(isSensitiveEnvName('KEYSTONE')).toBe(false);
    expect(isSensitiveEnvName('MONKEY')).toBe(false);
    expect(isSensitiveEnvName('TURKEY')).toBe(false);
    expect(isSensitiveEnvName('SSH_AGENT')).toBe(false);
    expect(isSensitiveEnvName('XDG_RUNTIME_DIR')).toBe(false);
    expect(isSensitiveEnvName('GIT_TERMINAL_PROMPT')).toBe(false);
  });
});

describe('sensitiveEnvNames', () => {
  it('filters a name list down to the sensitive entries', () => {
    expect(
      sensitiveEnvNames(['PATH', 'KIMI_API_KEY', 'HOME', 'SSH_AUTH_SOCK', 'npm_token']),
    ).toEqual(['KIMI_API_KEY', 'SSH_AUTH_SOCK', 'npm_token']);
    expect(sensitiveEnvNames([])).toEqual([]);
  });
});
