import { describe, expect, it } from 'vitest';

import { rendererTrackEventSchema } from '../../src/shared/track-events';

describe('plugin capability guide telemetry schema', () => {
  it('accepts the five PRD guide events with valid payloads', () => {
    const samples = [
      {
        event: 'webbridge_guide_show',
        properties: { plugin_id: 'kimi-webbridge', entry: 'install' },
      },
      {
        event: 'webbridge_guide_click',
        properties: { plugin_id: 'kimi-webbridge', action: 'chrome', connected: false },
      },
      {
        event: 'webbridge_guide_click',
        properties: { plugin_id: 'kimi-webbridge', action: 'done', connected: true },
      },
      {
        event: 'webbridge_connect_result',
        properties: { plugin_id: 'kimi-webbridge', connected: true, duration_ms: 4_200 },
      },
      {
        event: 'webbridge_connect_result',
        properties: { plugin_id: 'kimi-webbridge', connected: false },
      },
      {
        event: 'cu_permission_click',
        properties: { plugin_id: 'kimi-cu', entry: 'detail' },
      },
      {
        event: 'cu_permission_result',
        properties: {
          plugin_id: 'kimi-cu',
          accessibility_granted: true,
          screen_granted: false,
          result: 'partial',
        },
      },
    ];

    for (const sample of samples) {
      expect(rendererTrackEventSchema.safeParse(sample).success, sample.event).toBe(true);
    }
  });

  it('rejects invalid plugin ids, actions, and missing required booleans', () => {
    const invalid = [
      {
        event: 'webbridge_guide_show',
        properties: { plugin_id: 'other', entry: 'install' },
      },
      {
        event: 'webbridge_guide_click',
        properties: { plugin_id: 'kimi-webbridge', action: 'firefox', connected: false },
      },
      {
        event: 'webbridge_guide_click',
        properties: { plugin_id: 'kimi-webbridge', action: 'done' },
      },
      {
        event: 'cu_permission_result',
        properties: {
          plugin_id: 'kimi-cu',
          accessibility_granted: false,
          screen_granted: false,
          result: 'denied',
        },
      },
    ];

    for (const sample of invalid) {
      expect(rendererTrackEventSchema.safeParse(sample).success, sample.event).toBe(false);
    }
  });
});
