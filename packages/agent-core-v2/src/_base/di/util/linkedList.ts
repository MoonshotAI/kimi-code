/**
 * `di` domain (L0) — `LinkedList` with O(1) push/removal for parked event listeners.
 */

class Node<E> {
  static readonly Undefined = new Node<unknown>(undefined);

  element: E;
  next: Node<E> | typeof Node.Undefined;
  prev: Node<E> | typeof Node.Undefined;

  constructor(element: E) {
    this.element = element;
    this.next = Node.Undefined;
    this.prev = Node.Undefined;
  }
}

export class LinkedList<E> {
  private _first: Node<E> | typeof Node.Undefined = Node.Undefined;
  private _last: Node<E> | typeof Node.Undefined = Node.Undefined;
  private _size: number = 0;

  get size(): number {
    return this._size;
  }

  isEmpty(): boolean {
    return this._first === Node.Undefined;
  }

  push(element: E): () => void {
    const newNode = new Node(element);
    if (this._first === Node.Undefined) {
      this._first = newNode;
      this._last = newNode;
    } else {
      const oldLast = this._last as Node<E>;
      this._last = newNode;
      newNode.prev = oldLast;
      oldLast.next = newNode;
    }
    this._size += 1;

    let didRemove = false;
    return () => {
      if (!didRemove) {
        didRemove = true;
        this._remove(newNode);
      }
    };
  }

  shift(): E | undefined {
    if (this._first === Node.Undefined) {
      return undefined;
    }
    const node = this._first as Node<E>;
    this._remove(node);
    return node.element;
  }

  private _remove(node: Node<E>): void {
    if (node.prev !== Node.Undefined && node.next !== Node.Undefined) {
      const anchor = node.prev as Node<E>;
      anchor.next = node.next;
      (node.next as Node<E>).prev = anchor;
    } else if (node.prev === Node.Undefined && node.next === Node.Undefined) {
      this._first = Node.Undefined;
      this._last = Node.Undefined;
    } else if (node.next === Node.Undefined) {
      this._last = (this._last as Node<E>).prev!;
      (this._last as Node<E>).next = Node.Undefined;
    } else if (node.prev === Node.Undefined) {
      this._first = (this._first as Node<E>).next!;
      (this._first as Node<E>).prev = Node.Undefined;
    }
    this._size -= 1;
  }

  *[Symbol.iterator](): Iterator<E> {
    let node = this._first;
    while (node !== Node.Undefined) {
      yield (node as Node<E>).element;
      node = (node as Node<E>).next;
    }
  }
}
