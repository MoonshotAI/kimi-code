/**
 * `question` domain barrel — re-exports the question contract (`question`) and
 * its scoped service (`questionService`). Importing this barrel registers the
 * `IQuestionService` binding into the scope registry.
 */

export * from './question';
export * from './questionService';
