import { Type } from 'typebox';

export const BrowserIdSchema = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9:_-]+$' });
export const BrowserNonnegativeNumberSchema = Type.Number({ minimum: 0 });
export const BrowserRequestIdSchema = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
