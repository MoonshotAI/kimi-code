export interface JSONObject {
  readonly [key: string]: JSONValue;
}

export type JSONValue = string | number | boolean | null | readonly JSONValue[] | JSONObject;

export type CustomBody = JSONObject;

type MutableObject = Record<string, unknown>;

function setOwn(target: MutableObject, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

export function applyCustomBody(
  generated: Readonly<Record<string, unknown>>,
  customBody: CustomBody | undefined,
): MutableObject {
  const result = cloneValue(generated) as MutableObject;
  if (customBody === undefined) return result;

  for (const [key, value] of Object.entries(customBody)) {
    setOwn(result, key, mergeValue(result[key], value));
  }
  return result;
}

export function resolveCustomBodyStream(customBody: CustomBody | undefined, fallback: boolean): boolean {
  const stream = customBody?.['stream'];
  return typeof stream === 'boolean' ? stream : fallback;
}

export function withoutCustomBodyStream(customBody: CustomBody | undefined): CustomBody | undefined {
  if (typeof customBody?.['stream'] !== 'boolean') return customBody;
  const result: MutableObject = {};
  for (const [key, value] of Object.entries(customBody)) {
    if (key !== 'stream') setOwn(result, key, value);
  }
  return result as CustomBody;
}

function mergeValue(generated: unknown, patch: JSONValue): unknown {
  if (isObject(generated) && isObject(patch)) {
    const result = cloneValue(generated) as MutableObject;
    for (const [key, value] of Object.entries(patch)) {
      setOwn(result, key, mergeValue(result[key], value));
    }
    return result;
  }
  return cloneValue(patch);
}

function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (isObject(value)) {
    const result: MutableObject = {};
    for (const [key, item] of Object.entries(value)) {
      setOwn(result, key, cloneValue(item));
    }
    return result;
  }
  return value;
}

function isObject(value: unknown): value is MutableObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
