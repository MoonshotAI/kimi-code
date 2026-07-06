/**
 * Test fixture for the op-uniqueness scanner: intentionally declares the same
 * Op type twice. This file is read as TEXT by `op-uniqueness.test.ts` (it is
 * never imported or executed), so the duplicate `defineOp` below does not throw
 * here — it exists purely to prove the scanner flags a planted duplicate.
 */

import { defineModel, defineOp } from '#/wire';

const FixtureModel = defineModel('fixture', () => ({}));

defineOp(FixtureModel, 'fixture.planted', { apply: (s) => s });
defineOp(FixtureModel, 'fixture.planted', { apply: (s) => s });
