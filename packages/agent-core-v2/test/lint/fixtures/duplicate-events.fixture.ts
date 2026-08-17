/**
 * Test fixture for the event-uniqueness scanner: intentionally declares the
 * same durable event type twice. This file is read as TEXT by
 * `event-uniqueness.test.ts` (it is never imported or executed), so the
 * duplicate declaration does not throw here — it exists purely to prove the
 * scanner flags a planted duplicate.
 */

import { z } from 'zod';

import { Event2 } from '#/app/event/event2';

export class FixturePlantedA extends Event2<Record<string, never>> {
  static override readonly type = 'fixture.planted';
  static override readonly durable = true;
  static override readonly schema = z.object({});
}

export class FixturePlantedB extends Event2<Record<string, never>> {
  static override readonly type = 'fixture.planted';
  static override readonly durable = true;
  static override readonly schema = z.object({});
}
