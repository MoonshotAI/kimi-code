export class OAuthError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'OAuthError';
  }
}

export class OAuthUnauthorizedError extends OAuthError {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthUnauthorizedError';
  }
}

export class OAuthAccessDeniedError extends OAuthError {
  constructor(message = 'Authorization denied.') {
    super(message);
    this.name = 'OAuthAccessDeniedError';
  }
}

export class OAuthConnectionError extends OAuthError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'OAuthConnectionError';
  }
}

export class DeviceCodeExpiredError extends OAuthError {
  constructor(message = 'Device code expired.') {
    super(message);
    this.name = 'DeviceCodeExpiredError';
  }
}

export class DeviceCodeTimeoutError extends OAuthError {
  constructor(message = 'Device authorization timed out locally.') {
    super(message);
    this.name = 'DeviceCodeTimeoutError';
  }
}

export class RetryableRefreshError extends OAuthError {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableRefreshError';
  }
}
