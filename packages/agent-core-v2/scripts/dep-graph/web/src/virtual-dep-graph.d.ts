/// <reference types="vite/client" />

declare module 'virtual:dep-graph' {
  import type { Graph } from '../../analyzer/types';
  const graph: Graph;
  export default graph;
}
