import { describe, expect, it } from 'vitest';

import { BROWSER_SEARCH_ENGINES } from '../../src/shared/browser-search';
import { rendererTrackEventSchema } from '../../src/shared/track-events';

function parse(key: string, value: unknown) {
  return rendererTrackEventSchema.safeParse({ event: 'settings_changed', properties: { key, value, source_panel: 'settings' } });
}

const ACCEPTED: Record<string, readonly string[]> = {
  'browser-agent-control': ['on', 'off'],
  'browser-subagent-control': ['on', 'off'],
  'browser-search-engine': Object.keys(BROWSER_SEARCH_ENGINES),
  'browser-ask-where-to-save': ['on', 'off'],
  'browser-agent-download-location': ['default', 'custom'],
  'browser-agent-download-limit': ['100mb', '500mb', '1gb', '5gb', 'unlimited'],
  'browser-default-zoom': ['75', '90', '100', '110', '125', '150'],
  'browser-user-agent': ['default', 'custom'],
  'browser-user-agent-presets': ['added', 'removed'],
  'font-ui': ['same', 'system', 'kimi', 'custom'],
  'font-transcript': ['same', 'system', 'kimi', 'custom'],
  'font-code': ['same', 'system', 'kimi', 'custom'],
  'font-terminal': ['same', 'system', 'kimi', 'custom'],
  'font-terminal-size': ['default', '9', '13', '20', '32'],
  'running-send-mode': ['steer', 'queue'],
  'context-inspector': ['on', 'off'],
  'beta-features': ['on', 'off'],
  'notify-user': ['on', 'off'],
  tower: ['on', 'off'],
  'browser-tab-title': [
    'workspace-session',
    'session-workspace',
    'workspace',
    'session',
    'none',
  ],
};

const REJECTED: Record<string, readonly unknown[]> = {
  'browser-search-engine': ['yahoo', 'https://www.google.com/search?q=secret'],
  'browser-agent-download-location': ['/Users/me/Downloads'],
  'browser-agent-download-limit': ['104857600', 123],
  'browser-default-zoom': ['0.9', '95', 1],
  'browser-user-agent': ['Mozilla/5.0 (Macintosh)'],
  'browser-user-agent-presets': ['Staging'],
  'font-ui': ['default', 'Inter', 'JetBrains Mono'],
  'font-code': ['Fira Code'],
  'font-terminal-size': ['8', '33', '13.5', '013', 13, 'Menlo'],
  'running-send-mode': ['auto', ''],
  'context-inspector': ['true', true],
  'beta-features': ['1', ''],
  'notify-user': ['enabled', false],
  tower: ['yes', 1],
  'browser-tab-title': ['custom', ''],
};

describe('settings_changed browser and font keys', () => {
  for (const [key, values] of Object.entries(ACCEPTED)) {
    it(`accepts every allowed ${key} value`, () => {
      for (const value of values) expect(parse(key, value).success, value).toBe(true);
    });
  }

  for (const [key, values] of Object.entries(REJECTED)) {
    it(`rejects names, paths and free text for ${key}`, () => {
      for (const value of values) expect(parse(key, value).success, String(value)).toBe(false);
    });
  }

  it('rejects per-surface size keys other than the terminal', () => {
    expect(parse('font-ui-size', '13').success).toBe(false);
  });
});
