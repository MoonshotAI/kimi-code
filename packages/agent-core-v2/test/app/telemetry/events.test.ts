import { describe, expect, it } from 'vitest';

import { telemetryEventDefinitions } from '#/app/telemetry/events';

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
});
