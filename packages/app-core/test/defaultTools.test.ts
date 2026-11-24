import { describe, expect, it } from 'vitest';

import { isDefaultToolEnabled, rebaseDefaultToolsConfig, setDefaultToolEnabled } from '../src/lib/defaultTools';

describe('default tool config', () => {
  it('combines the allowlist and denylist when resolving switch state', () => {
    expect(isDefaultToolEnabled(undefined, 'Bash')).toBe(true);
    expect(isDefaultToolEnabled({ enabled: [] }, 'Bash')).toBe(true);
    expect(isDefaultToolEnabled({ enabled: ['Read'] }, 'Bash')).toBe(false);
    expect(isDefaultToolEnabled({ enabled: ['Read', 'Bash'] }, 'Bash')).toBe(true);
    expect(isDefaultToolEnabled({ disabled: ['Bash'] }, 'Bash')).toBe(false);
    expect(isDefaultToolEnabled({ enabled: ['Bash'], disabled: ['Bash'] }, 'Bash')).toBe(false);
  });

  it('disables and reenables a tool without an allowlist', () => {
    const disabled = setDefaultToolEnabled(undefined, 'Bash', false);
    expect(disabled).toEqual({ enabled: undefined, disabled: ['Bash'] });
    expect(setDefaultToolEnabled(disabled, 'Bash', true)).toEqual({ enabled: undefined, disabled: [] });
  });

  it('adds a reenabled tool to a non-empty allowlist', () => {
    const config = { enabled: ['Read'], disabled: ['Bash'] };
    expect(setDefaultToolEnabled(config, 'Bash', true)).toEqual({
      enabled: ['Bash', 'Read'],
      disabled: [],
    });
  });

  it('preserves rules outside the visible catalog and removes duplicates', () => {
    const config = {
      enabled: ['Read', 'mcp__example__*'],
      disabled: ['Write', 'mcp__example__*', 'Bash'],
    };
    expect(setDefaultToolEnabled(config, 'Bash', false)).toEqual({
      enabled: ['Read', 'mcp__example__*'].toSorted((left, right) => left.localeCompare(right)),
      disabled: ['Write', 'mcp__example__*', 'Bash'].toSorted((left, right) => left.localeCompare(right)),
    });
    expect(setDefaultToolEnabled(config, 'Bash', true)).toEqual({
      enabled: ['Read', 'mcp__example__*', 'Bash'].toSorted((left, right) => left.localeCompare(right)),
      disabled: ['Write', 'mcp__example__*'].toSorted((left, right) => left.localeCompare(right)),
    });
  });
});


describe('rebaseDefaultToolsConfig', () => {
  it('replays a draft denial onto a concurrent update without re-enabling tools disabled elsewhere', () => {
    expect(
      rebaseDefaultToolsConfig(
        { disabled: [] },
        { disabled: ['Write'] },
        { disabled: ['Bash'] },
      ),
    ).toEqual({ enabled: undefined, disabled: ['Bash', 'Write'] });
  });

  it('replays a draft re-enable onto a concurrent update while keeping other denials intact', () => {
    expect(
      rebaseDefaultToolsConfig(
        { disabled: ['Write'] },
        { disabled: [] },
        { disabled: ['Write', 'Bash'] },
      ),
    ).toEqual({ enabled: undefined, disabled: ['Bash'] });
  });

  it('preserves concurrent allowlist additions and untouched glob rules', () => {
    expect(
      rebaseDefaultToolsConfig(
        { enabled: ['Read'], disabled: ['mcp__example__*'] },
        { enabled: ['Bash', 'Read'], disabled: ['mcp__example__*'] },
        { enabled: ['Edit', 'Read'], disabled: ['Write'] },
      ),
    ).toEqual({ enabled: ['Bash', 'Edit', 'Read'], disabled: ['Write'] });
  });

  it('treats an empty allowlist as unrestricted when computing the draft diff', () => {
    expect(
      rebaseDefaultToolsConfig(
        { enabled: [] },
        { enabled: [], disabled: ['Bash'] },
        { enabled: ['Read'] },
      ),
    ).toEqual({ enabled: ['Read'], disabled: ['Bash'] });
  });
});
