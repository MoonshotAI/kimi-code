import type { TSchema } from 'typebox';
import type { TsdownPlugin } from 'tsdown';

export function browserValidatorModule(schemas: TSchema[]): string;
export function browserAotPlugin(): TsdownPlugin;
