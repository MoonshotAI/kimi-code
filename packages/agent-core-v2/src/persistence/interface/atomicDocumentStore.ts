import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { type IDisposable } from '#/_base/di/lifecycle';
import { type Event } from '#/_base/event';

export interface DocumentCodec {
  readonly format: string;
  encode(value: unknown): Uint8Array;
  decode(bytes: Uint8Array): unknown;
}

export interface IAtomicDocumentStore {
  readonly _serviceBrand: undefined;

  get<T>(scope: string, key: string): Promise<T | undefined>;
  set<T>(scope: string, key: string, value: T): Promise<void>;
  delete(scope: string, key: string): Promise<void>;
  list(scope: string, prefix?: string): Promise<readonly string[]>;
  watch(scope: string, key: string): Event<void>;
  acquire(scope: string, key: string): IDisposable;
}

export const IAtomicDocumentStore: ServiceIdentifier<IAtomicDocumentStore> =
  createDecorator<IAtomicDocumentStore>('atomicDocumentStore');

export const IAtomicTomlDocumentStore: ServiceIdentifier<IAtomicDocumentStore> =
  createDecorator<IAtomicDocumentStore>('atomicTomlDocumentStore');
