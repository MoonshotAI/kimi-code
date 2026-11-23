import { shallowRef } from 'vue';

export const dockHeightPx = shallowRef<number | null>(null);

export function publishDockHeightPx(px: number): void {
  dockHeightPx.value = px;
}

export interface DockMetricsSink {
  setDockHeight(px: number): void;
}

export interface DockMetricsSource {
  offsetHeight: number;
}

export function createDockMetricsPublisher(
  sink: DockMetricsSink,
): (dock: DockMetricsSource | null | undefined) => void {
  let publishedHeight: number | null = null;
  return (dock) => {
    const height = dock?.offsetHeight ?? 0;
    if (publishedHeight !== height) {
      publishedHeight = height;
      sink.setDockHeight(height);
    }
  };
}
