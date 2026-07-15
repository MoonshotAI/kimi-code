/**
 * `model` domain (L2) — `IModelResolver` contract.
 *
 * Resolves a Model id (or a routing name / alias) into a runnable Model
 * god-object. Reads Model / Provider / Platform records from `config`, plus
 * OAuth tokens through `auth`. Bound at App scope — resolution is stateless
 * and shared across sessions.
 *
 * Two lookup shapes:
 *  - `resolve(id)`   — the primary path; takes the globally-unique Model id
 *    that appears as `[models.<id>]` in config.
 *  - `findByName(n)` — reverse map; returns every Model id whose `name` or
 *    `aliases` match. Callers doing many-to-many routing use this to score
 *    candidates before picking one to `resolve`.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { Model } from './modelInstance';

export interface IModelResolver {
  readonly _serviceBrand: undefined;

  resolve(id: string): Model;
  findByName(name: string): readonly string[];
}

export const IModelResolver: ServiceIdentifier<IModelResolver> =
  createDecorator<IModelResolver>('modelResolver');
