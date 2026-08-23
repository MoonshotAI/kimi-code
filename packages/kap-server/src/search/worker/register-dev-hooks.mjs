// Registers the dev search worker's module hooks (see dev-hooks.mjs).
// Passed to the worker via execArgv `--import <this file>`; the specifier is
// resolved relative to this file, so the hook module rides along regardless
// of the process cwd. Never bundled.
import { register } from 'node:module';

register('./dev-hooks.mjs', import.meta.url);
