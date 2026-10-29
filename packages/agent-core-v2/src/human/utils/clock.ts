let impl: () => number = () => performance.now();

export function clock(): number {
  return impl();
}

export function setClock(next?: () => number): void {
  impl = next ?? (() => performance.now());
}
