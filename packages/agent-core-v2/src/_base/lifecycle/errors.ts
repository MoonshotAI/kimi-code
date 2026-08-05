/**
 * `_base.lifecycle` — Ledger errors.
 */

export class LedgerDisposedError extends Error {
  constructor(
    readonly ledgerLabel: string,
    readonly operation: string,
    readonly ledgerState: 'disposing' | 'disposed',
  ) {
    super(
      `Ledger '${ledgerLabel}' is ${ledgerState}: cannot ${operation} on a ${ledgerState} ledger`,
    );
    this.name = 'LedgerDisposedError';
  }
}
