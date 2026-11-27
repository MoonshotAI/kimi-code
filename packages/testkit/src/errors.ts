export class TestkitError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TestkitError';
  }
}

export class WaitTimeoutError extends TestkitError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'WaitTimeoutError';
  }
}

export class FakeModelClosedError extends TestkitError {
  constructor() {
    super('The fake model was closed before the awaited event happened');
    this.name = 'FakeModelClosedError';
  }
}

export class KapInvariantError extends TestkitError {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super([`The KAP conversation broke ${problems.length} protocol invariant(s) by the end of the test:`, ...problems.map((problem) => `- ${problem}`)].join('\n'));
    this.name = 'KapInvariantError';
    this.problems = problems;
  }
}

export class FakeModelVerificationError extends TestkitError {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super([`The fake model found ${problems.length} problem(s):`, ...problems.map((problem) => `- ${problem}`)].join('\n'));
    this.name = 'FakeModelVerificationError';
    this.problems = problems;
  }
}
