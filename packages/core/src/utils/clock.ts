/**
 * Monotonic clock used to time LLM requests; `setClock` swaps the time source.
 */

let impl: () => number = () => performance.now();

export function clock(): number {
  return impl();
}

export function setClock(next?: () => number): void {
  impl = next ?? (() => performance.now());
}
