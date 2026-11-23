import type { Static, TSchema, TObject } from 'typebox';
import { Value } from 'typebox/value';

const schemas = new WeakMap<object, TSchema>();

export function browserValidatorSchema(validator: object): TSchema {
  const schema = schemas.get(validator);
  if (schema === undefined) throw new Error('Unknown browser validator');
  return schema;
}

export function defineBrowserValidator<T extends TSchema>(schema: T) {
  const object = schema as TSchema & Partial<TObject>;
  const keys = object.type === 'object' ? Object.keys(object.properties ?? {}) : null;
  const validator = {
    Check(value: unknown): value is Static<T> {
      return Value.Check(schema, value);
    },
    Parse(value: unknown): Static<T> | null {
      if (!Value.Check(schema, value)) return null;
      return keys === null ? value : Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]])) as Static<T>;
    },
  };
  schemas.set(validator, schema);
  return validator;
}
