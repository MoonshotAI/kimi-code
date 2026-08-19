import { ulid } from 'ulid';

export function newMessageId(): string {
  return `msg_${ulid()}`;
}
