export type Promisify<T> = [T] extends [Promise<any>] ? T : Promise<T>;
export type PromisifyMethods<T> = {
  [K in keyof T]: T[K] extends (...args: infer Args) => infer Return
    ? (...args: Args) => Promisify<Return>
    : never;
};

export type Promisable<T> = [T] extends [Promise<any>] ? T | Awaited<T> : T | Promise<T>;
export type PromisableMethods<T> = {
  [K in keyof T]: T[K] extends (...args: infer Args) => infer Return
    ? (...args: Args) => Promisable<Return>
    : never;
};
