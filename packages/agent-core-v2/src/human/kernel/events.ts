export interface RuntimeEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface ScopedEvent extends RuntimeEvent {
  readonly vetoed: boolean;
  readonly vetoReason?: string;
  veto(reason: string): void;
}

export type EventHandler<E extends RuntimeEvent = RuntimeEvent> = (event: E) => void;

export type Unsubscribe = () => void;

export function envelope<E extends RuntimeEvent>(event: E): E & ScopedEvent {
  const scoped = Object.create(event) as E & ScopedEvent;
  let vetoed = false;
  let vetoReason: string | undefined;
  Object.defineProperties(scoped, {
    vetoed: { get: () => vetoed, enumerable: true },
    vetoReason: { get: () => vetoReason, enumerable: true },
    veto: {
      value: (reason: string) => {
        vetoed = true;
        vetoReason = reason;
      },
      enumerable: true,
    },
  });
  return scoped;
}
