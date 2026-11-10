export interface DateInjectionDisclosure {
  readonly kind: 'date';
  readonly renderGeneration: number;
  readonly localDate: string;
  readonly timeZone: string;
}
