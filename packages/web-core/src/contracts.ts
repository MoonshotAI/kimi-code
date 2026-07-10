export interface Tracer {
  restRequest?(info: unknown): void;
  restFailure?(info: unknown): void;
  wsEvent?(info: unknown): void;
}
export const noopTracer: Tracer = {};

export interface CredentialStore {
  getToken(): string | undefined;
  markAuthRequired?(): void;
}

export interface ResolveImage {
  (src: string): string;
}
