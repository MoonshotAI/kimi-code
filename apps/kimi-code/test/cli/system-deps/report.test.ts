import { describe, expect, it } from 'vitest';

import type { DependencyStatus } from '#/cli/system-deps/check';
import { getDependency } from '#/cli/system-deps/registry';
import { buildDependencyReportLines, startupDependencyWarnings } from '#/cli/system-deps/report';

function status(id: 'ripgrep' | 'fd' | 'shell', over: Partial<DependencyStatus>): DependencyStatus {
  return {
    dependency: getDependency(id),
    available: true,
    detail: 'ok',
    shouldWarnAtStartup: false,
    ...over,
  };
}

// Minimal palette — only the fields the renderer reads.
const COLORS = {
  primary: '#ffffff',
  text: '#ffffff',
  textDim: '#888888',
  success: '#00ff00',
  warning: '#ffaa00',
  error: '#ff0000',
} as never;

describe('startupDependencyWarnings', () => {
  it('emits only dependencies flagged to warn at startup', () => {
    const warnings = startupDependencyWarnings([
      status('ripgrep', { shouldWarnAtStartup: false }),
      status('fd', { shouldWarnAtStartup: true, available: false, detail: 'missing outside git' }),
      status('shell', { shouldWarnAtStartup: true, available: false, detail: 'no git bash' }),
    ]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('fd');
    expect(warnings[0]).toContain('missing outside git');
    expect(warnings[1]).toContain('shell');
  });

  it('returns nothing when all dependencies are healthy', () => {
    expect(
      startupDependencyWarnings([status('ripgrep', {}), status('fd', {}), status('shell', {})]),
    ).toEqual([]);
  });
});

describe('buildDependencyReportLines', () => {
  it('renders a header plus one line per dependency', () => {
    const lines = buildDependencyReportLines({
      colors: COLORS,
      statuses: [status('ripgrep', {}), status('fd', { available: false }), status('shell', {})],
    });
    expect(lines[0]).toContain('System dependencies');
    expect(lines).toHaveLength(4);
    expect(lines.join('\n')).toContain('ripgrep (rg)');
    expect(lines.join('\n')).toContain('fd');
    expect(lines.join('\n')).toContain('shell');
  });
});
