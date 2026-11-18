import { describe, expect, it } from 'vitest';

import {
  panelLauncherOrder,
  panelRegistry,
  type AgentTabPayload,
  type BtwTabPayload,
  type CompactionTabPayload,
  type FileTabPayload,
  type PanelTabType,
  type TermTabPayload,
} from '../src/panel/panelRegistry';
import type { TurnFileChange } from '@moonshot-ai/app-core/client';

const t = (key: string) => key;

const editChange: TurnFileChange = {
  path: '/repo/src/a.ts',
  added: 3,
  removed: 1,
};

describe('panel registry', () => {
  it('registers exactly the ten panel types', () => {
    expect(Object.keys(panelRegistry).sort()).toEqual(
      [
        'agent',
        'browser',
        'btw',
        'compaction',
        'diff',
        'file',
        'files',
        'inspector',
        'term',
        'turn-diff',
      ].sort(),
    );
    for (const [type, def] of Object.entries(panelRegistry)) {
      expect(def.type).toBe(type);
      expect(def.icon).toBeTruthy();
      expect(def.i18nKey).toBeTruthy();
    }
  });

  it('declares the expected policy and restorability per type', () => {
    const expected: Record<PanelTabType, { policy: string; restorable: boolean }> = {
      diff: { policy: 'singleton', restorable: true },
      file: { policy: 'keyed', restorable: true },
      files: { policy: 'singleton', restorable: true },
      agent: { policy: 'keyed', restorable: true },
      'turn-diff': { policy: 'singleton', restorable: true },
      compaction: { policy: 'keyed', restorable: true },
      btw: { policy: 'always', restorable: true },
      term: { policy: 'always', restorable: true },
      browser: { policy: 'always', restorable: true },
      inspector: { policy: 'singleton', restorable: true },
    };
    for (const [type, want] of Object.entries(expected)) {
      const def = panelRegistry[type as PanelTabType];
      expect(def.policy, `${type} policy`).toBe(want.policy);
      expect(def.restorable, `${type} restorable`).toBe(want.restorable);
      if (want.policy === 'keyed') expect(def.keyOf, `${type} keyOf`).toBeTypeOf('function');
    }
  });

  it('keys file tabs by path', () => {
    const keyOf = panelRegistry.file.keyOf!;
    expect(keyOf({ path: '/repo/a.ts' } satisfies FileTabPayload)).toBe('/repo/a.ts');
    expect(keyOf({ path: '/repo/a.ts', line: 3 })).toBe(keyOf({ path: '/repo/a.ts' }));
  });

  it('keys agent tabs by subagent id', () => {
    const keyOf = panelRegistry.agent.keyOf!;
    const payload: AgentTabPayload = { sessionId: 's1', subagentId: 'agent-1' };
    expect(keyOf(payload)).toBe('agent-1');
  });

  it('keys compaction tabs by turn id', () => {
    const keyOf = panelRegistry.compaction.keyOf!;
    expect(keyOf({ turnId: 'turn-9' } satisfies CompactionTabPayload)).toBe('turn-9');
  });

  it('derives file titles from the path basename', () => {
    expect(panelRegistry.file.title({ path: '/repo/src/a.ts' }, t)).toBe('a.ts');
    expect(panelRegistry.file.title({ path: 'C:\\repo\\b.ts' }, t)).toBe('b.ts');
  });

  it('titles singleton / generic tabs from their i18n keys', () => {
    expect(panelRegistry.diff.title(undefined, t)).toBe('panel.tabs.diff');
    expect(panelRegistry.agent.title(undefined, t)).toBe('panel.tabs.agent');
    expect(panelRegistry['turn-diff'].title({ turnId: 't1', change: editChange }, t)).toBe(
      'panel.tabs.turnDiff',
    );
    expect(panelRegistry.compaction.title({ turnId: 't1' }, t)).toBe('panel.tabs.compaction');
    expect(panelRegistry.browser.title(undefined, t)).toBe('panel.tabs.browser');
    expect(panelRegistry.browser.title({ browserId: 'browser-1', title: 'Example' }, t)).toBe('Example');
  });

  it('auto-numbers btw tab titles from the payload seq', () => {
    const title = panelRegistry.btw.title;
    expect(title({ parentId: 's1', agentId: 'a1', seq: 1 } satisfies BtwTabPayload, t)).toBe(
      'sideChat.title',
    );
    expect(title({ parentId: 's1', agentId: 'a2', seq: 2 } satisfies BtwTabPayload, t)).toBe(
      'sideChat.title 2',
    );
    expect(title({ parentId: 's1', agentId: 'a3', seq: 5 } satisfies BtwTabPayload, t)).toBe(
      'sideChat.title 5',
    );
  });

  it('prefers a term payload title and falls back to the type name', () => {
    expect(panelRegistry.term.title({ title: 'zsh — ~/repo' } satisfies TermTabPayload, t)).toBe(
      'zsh — ~/repo',
    );
    expect(panelRegistry.term.title(undefined, t)).toBe('panel.tabs.term');
  });

  it('orders launcher entries as diff, browser, term, files, btw, inspector with registry metadata', () => {
    expect([...panelLauncherOrder]).toEqual(['diff', 'browser', 'term', 'files', 'btw', 'inspector']);
    for (const type of panelLauncherOrder) {
      expect(panelRegistry[type].icon, `${type} icon`).toBeTruthy();
      expect(panelRegistry[type].i18nKey, `${type} i18nKey`).toBeTruthy();
    }
  });
});
