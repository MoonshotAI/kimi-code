#!/usr/bin/env -S npx tsx
/**
 * Scope-rule lint over the analyzed dep graph.
 *
 * The analyzer resolves each edge's target token to a concrete impl by
 * walking the source's scope tree (source scope → App). If no visible
 * binding exists, the edge is marked `unresolved` — meaning at runtime the
 * DI container would fail to satisfy the dependency from the source's
 * scope. That's exactly the scope-rule violation we want to lint against:
 *
 *   Scope tree:  App > Session > Agent   (App outermost / longest-lived)
 *
 *  - `ctor` edge unresolved     → **error**: container will crash on
 *                                  instantiation.
 *  - `accessor` edge unresolved → **warning**: only fails at `.get()`-time,
 *                                  and calls made under an active inner
 *                                  scope may resolve correctly if the
 *                                  accessor was passed in from that inner
 *                                  scope. Still worth flagging as an
 *                                  implicit dependency on runtime nesting.
 *  - Resolved edges are legal by construction — the analyzer only resolves
 *    if a binding is visible from the source scope.
 *  - `publish` / `subscribe` / `emit` / `on` route through the event bus
 *    token, which is itself ctor-injected; the ctor edge already carries
 *    the check.
 *
 * Usage:
 *   pnpm dep-graph:lint         # errors → exit 1
 *   pnpm dep-graph:lint --warn  # also fail on warnings
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { SNAPSHOT_PATH, SRC_ROOT, analyze } from './analyzer/analyze';
import type { Edge, Graph, ServiceNode } from './analyzer/types';

interface Violation {
  severity: 'error' | 'warning';
  edge: Edge;
  from: ServiceNode;
}

function loadGraph(): Graph {
  if (existsSync(SNAPSHOT_PATH)) {
    const snapMtime = statSync(SNAPSHOT_PATH).mtimeMs;
    const srcMtime = latestMtime(SRC_ROOT);
    if (snapMtime >= srcMtime) {
      return JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as Graph;
    }
  }
  return analyze({ generatedAt: 'lint' });
}

function latestMtime(dir: string): number {
  let latest = 0;
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.name.endsWith('.ts')) {
        const m = statSync(abs).mtimeMs;
        if (m > latest) latest = m;
      }
    }
  };
  walk(dir);
  return latest;
}

function lint(graph: Graph): Violation[] {
  const byId = new Map<string, ServiceNode>();
  for (const s of graph.services) byId.set(s.id, s);

  const violations: Violation[] = [];
  for (const edge of graph.edges) {
    if (!edge.unresolved) continue;
    const from = byId.get(edge.from);
    if (!from) continue;
    if (edge.kind === 'ctor') {
      violations.push({ severity: 'error', edge, from });
    } else if (edge.kind === 'accessor') {
      violations.push({ severity: 'warning', edge, from });
    }
  }
  return violations;
}

function main(): number {
  const failOnWarn = process.argv.includes('--warn');
  const graph = loadGraph();
  const violations = lint(graph);

  const errors = violations.filter((v) => v.severity === 'error');
  const warnings = violations.filter((v) => v.severity === 'warning');

  const report = (v: Violation): void => {
    console.log(
      `  [${v.severity.toUpperCase()} ${v.from.scope}→?] ${v.from.impl} (${v.from.token}) --${v.edge.kind}--> ${v.edge.token}  (no binding visible from ${v.from.scope})`,
    );
    for (const ref of v.edge.refs) {
      console.log(`      ${ref.file}:${ref.line}`);
    }
  };

  if (errors.length > 0) {
    console.log(
      `\n${errors.length} scope-rule ERROR(s) — ctor edge cannot be resolved from source scope:`,
    );
    for (const v of errors) report(v);
  }
  if (warnings.length > 0) {
    console.log(
      `\n${warnings.length} scope-rule warning(s) — accessor edge cannot be resolved from source scope (only safe if the accessor is passed in from an inner scope):`,
    );
    for (const v of warnings) report(v);
  }

  const summary = `\ndep-graph:lint — services=${graph.services.length} edges=${graph.edges.length} errors=${errors.length} warnings=${warnings.length}`;
  console.log(summary);

  if (errors.length > 0) return 1;
  if (failOnWarn && warnings.length > 0) return 1;
  return 0;
}

process.exit(main());
