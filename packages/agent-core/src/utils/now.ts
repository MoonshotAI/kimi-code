let impl: () => number = Date.now;

export function now(): number {
  return impl();
}

export function setNow(next?: () => number): void {
  impl = next ?? Date.now;
}
