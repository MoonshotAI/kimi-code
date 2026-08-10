/**
 * Base error class for the kaos package.
 */
export class KaosError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KaosError';
  }
}

/**
 * Equivalent to Python's ValueError — indicates an invalid argument was passed.
 */
export class KaosValueError extends KaosError {
  constructor(message: string) {
    super(message);
    this.name = 'KaosValueError';
  }
}

/**
 * Equivalent to Python's FileExistsError — indicates a file or directory already exists.
 */
export class KaosFileExistsError extends KaosError {
  constructor(message: string) {
    super(message);
    this.name = 'KaosFileExistsError';
  }
}

/**
 * Thrown by `detectEnvironment` on Windows when no Git Bash install can be
 * located. Carries the list of paths that were probed so callers can include
 * them in install hints.
 */
export class KaosShellNotFoundError extends KaosError {
  constructor(message: string) {
    super(message);
    this.name = 'KaosShellNotFoundError';
  }
}
