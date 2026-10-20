export interface TowerInboxSignal {
  readonly from: string;
  readonly to: string;
  readonly subject: string;
}

export interface TowerHub {
  publish(signal: TowerInboxSignal): void;
  subscribe(listener: (signal: TowerInboxSignal) => void): () => void;
}

export function createTowerHub(): TowerHub {
  const listeners = new Set<(signal: TowerInboxSignal) => void>();
  return {
    publish(signal) {
      for (const listener of listeners) listener(signal);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
