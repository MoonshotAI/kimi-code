export class HistoryHeights {
  private tree: number[] = [];
  private sizes: number[] = [];

  reset(sizes: number[]): void {
    this.sizes = sizes.slice();
    this.tree = [0, ...sizes];
    for (let i = 1; i < this.tree.length; i++) {
      const parent = i + (i & -i);
      if (parent < this.tree.length) this.tree[parent]! += this.tree[i]!;
    }
  }

  get length(): number {
    return this.sizes.length;
  }

  get(index: number): number {
    return this.sizes[index] ?? 0;
  }

  set(index: number, size: number): void {
    const delta = size - (this.sizes[index] ?? 0);
    this.sizes[index] = size;
    for (let i = index + 1; i < this.tree.length; i += i & -i) this.tree[i]! += delta;
  }

  top(index: number): number {
    let value = 0;
    for (let i = index; i > 0; i -= i & -i) value += this.tree[i] ?? 0;
    return value;
  }

  at(offset: number): number {
    let index = 0;
    let total = 0;
    for (let bit = 2 ** Math.floor(Math.log2(Math.max(1, this.sizes.length))); bit > 0; bit >>= 1) {
      const next = index + bit;
      if (next < this.tree.length && total + this.tree[next]! <= offset) {
        index = next;
        total += this.tree[next]!;
      }
    }
    return Math.min(index, Math.max(0, this.sizes.length - 1));
  }
}
