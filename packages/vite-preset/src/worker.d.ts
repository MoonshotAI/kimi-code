// Vite's `?worker&type=module` imports — not declared in `vite/client`,
// which only covers `?worker`, `?worker&inline`, and `?worker&url` for classic
// workers. ES module workers need this additional declaration so TypeScript
// can resolve the import without errors.
declare module '*?worker&type=module' {
  const WorkerFactory: new () => Worker;
  export default WorkerFactory;
}
