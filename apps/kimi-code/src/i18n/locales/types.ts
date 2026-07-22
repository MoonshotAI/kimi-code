import en from './en';

/**
 * Widen every string leaf of the key tree to `string` while preserving the
 * exact key structure. This lets each locale carry different translated
 * values but forces it to implement the same key set as the English base.
 */
type LocaleShape<T> = {
  [K in keyof T]: T[K] extends string ? string : LocaleShape<T[K]>;
};

/**
 * The full translation key tree every locale must implement, derived from the
 * English base (`en`). Apply it in each locale file with
 * `... as const satisfies LocaleMessages` so a missing or stray key becomes a
 * compile error — complementing the runtime `locale-parity` test that lists
 * exactly which keys drifted.
 */
export type LocaleMessages = LocaleShape<typeof en>;
