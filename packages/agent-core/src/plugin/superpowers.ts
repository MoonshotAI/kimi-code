// Compatibility shims for plugins that predate Kimi's manifest fields.
// Each shim MUST be removable once the upstream plugin ships a Kimi-aware
// manifest. This file is intentionally a registry of named exceptions, not
// a pattern-matching system.

import type { PluginDiagnostic, PluginManifest, PluginRecord } from './types';

const SUPERPOWERS_BOOTSTRAP_SKILL = 'using-superpowers';

export function applyCompatShims(record: PluginRecord): PluginRecord {
  if (record.state !== 'ok' || record.manifest === undefined) return record;
  if (record.id !== 'superpowers') return record;
  if (record.manifest.bootstrap !== undefined) return record;
  const manifest: PluginManifest = {
    ...record.manifest,
    bootstrap: { skill: SUPERPOWERS_BOOTSTRAP_SKILL },
  };
  const diagnostic: PluginDiagnostic = {
    severity: 'info',
    code: 'compat.bootstrap.synthesized',
    message:
      `Synthesized bootstrap { skill: "${SUPERPOWERS_BOOTSTRAP_SKILL}" } for ` +
      'the superpowers plugin until upstream ships a Kimi-aware manifest.',
  };
  return {
    ...record,
    manifest,
    diagnostics: [...record.diagnostics, diagnostic],
  };
}
