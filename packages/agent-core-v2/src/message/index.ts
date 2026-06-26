/**
 * `message` domain barrel — re-exports the message contract (`message`) and
 * its scoped service (`messageService`). Importing this barrel registers the
 * `IMessageService` binding into the scope registry.
 */

export * from './message';
export * from './messageService';
