/**
 * Test fixture for the op-uniqueness scanner: intentionally declares the same
 * Op type twice. This file is read as TEXT by `op-uniqueness.test.ts` (it is
 * never imported or executed), so the duplicate `defineOp` below does not throw
 * here — it exists purely to prove the scanner flags a planted duplicate.
 */

import { z } from 'zod';

import { defineModel } from '#/wire/model';

const FixtureModel = defineModel('fixture', () => ({}));

FixtureModel.defineOp('fixture.planted', { schema: z.object({}), apply: (s) => s });
FixtureModel.defineOp('fixture.planted', { schema: z.object({}), apply: (s) => s });
