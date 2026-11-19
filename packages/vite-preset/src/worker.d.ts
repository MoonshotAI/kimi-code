declare module '*?worker&type=module' {
  const WorkerFactory: new () => Worker;
  export default WorkerFactory;
}
