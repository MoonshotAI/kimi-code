import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  telemetryCoverageTierRoots,
  telemetryDomainExemptions,
  telemetryDomainKnownGaps,
  telemetryPseudoDomains,
} from '#/app/telemetry/coverage';
import {
  agentTelemetryContextProperties,
  telemetryEventDefinitions,
  type TelemetryEventProperties,
} from '#/app/telemetry/events';

const NAME_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

describe('telemetry event registry', () => {
  it('uses snake_case event names', () => {
    for (const name of Object.keys(telemetryEventDefinitions)) {
      expect(name, `event name "${name}"`).toMatch(NAME_PATTERN);
    }
  });

  it('documents owner, comment, and snake_case properties for every event', () => {
    for (const [name, definition] of Object.entries(telemetryEventDefinitions)) {
      const { meta } = definition;
      expect(meta.owner.length, `${name}: owner`).toBeGreaterThan(0);
      expect(meta.comment.length, `${name}: comment`).toBeGreaterThan(0);
      for (const property of Object.keys(meta.properties)) {
        expect(property, `${name}.${property}`).toMatch(NAME_PATTERN);
      }
      for (const comment of Object.values(meta.properties)) {
        expect(comment.length, `${name}: property comment`).toBeGreaterThan(0);
      }
    }
  });

  it('declares Agent identity once as ambient context', () => {
    expect(agentTelemetryContextProperties).toEqual({
      agent_id: 'Agent id (main or subagent scope id)',
    });
    for (const [name, definition] of Object.entries(telemetryEventDefinitions)) {
      if (definition.context === 'agent') {
        expect(
          definition.meta.properties,
          `${name}: agent-scope events keep agent_id out of the payload`,
        ).not.toHaveProperty('agent_id');
      }
    }
    expect(telemetryEventDefinitions.goal_created.context).toBe('agent');
    expect(telemetryEventDefinitions.image_compress.context).toBe('none');
    expectTypeOf<TelemetryEventProperties<'goal_created'>>().toMatchTypeOf<{
      agent_id: string;
    }>();
  });
});

describe('telemetry domain coverage', () => {
  const srcDir = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', 'src');
  const tierRoots = new Set<string>(telemetryCoverageTierRoots);

  const domains: string[] = [];
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (!tierRoots.has(entry.name)) {
      domains.push(entry.name);
      continue;
    }
    for (const sub of readdirSync(join(srcDir, entry.name), { withFileTypes: true })) {
      if (sub.isDirectory()) {
        domains.push(`${entry.name}/${sub.name}`);
      }
    }
  }
  const domainSet = new Set(domains);
  const validDomains = new Set([...domains, ...telemetryPseudoDomains]);
  const eventDomains = new Set(
    Object.values(telemetryEventDefinitions).map((definition) => definition.meta.domain),
  );

  it('accounts for every source domain with an event, an exemption, or a known gap', () => {
    for (const domain of domains) {
      const covered = eventDomains.has(domain);
      const exempt = domain in telemetryDomainExemptions;
      const gap = domain in telemetryDomainKnownGaps;
      expect(
        covered || exempt || gap,
        `${domain}: register an event with this domain, or list it in src/app/telemetry/coverage.ts`,
      ).toBe(true);
      expect(
        [covered, exempt, gap].filter(Boolean).length,
        `${domain}: a domain with events must not also appear in exemptions or known gaps`,
      ).toBe(1);
    }
  });

  it('references only existing domains, with non-empty reasons', () => {
    for (const domain of eventDomains) {
      expect(validDomains.has(domain), `event domain "${domain}"`).toBe(true);
    }
    for (const [domain, reason] of Object.entries(telemetryDomainExemptions)) {
      expect(domainSet.has(domain), `exemption "${domain}"`).toBe(true);
      expect(reason.length, `exemption "${domain}" reason`).toBeGreaterThan(0);
    }
    for (const [domain, reason] of Object.entries(telemetryDomainKnownGaps)) {
      expect(domainSet.has(domain), `known gap "${domain}"`).toBe(true);
      expect(reason.length, `known gap "${domain}" reason`).toBeGreaterThan(0);
    }
    const overlap = Object.keys(telemetryDomainExemptions).filter(
      (domain) => domain in telemetryDomainKnownGaps,
    );
    expect(overlap, 'exemptions and known gaps must be disjoint').toEqual([]);
  });
});
