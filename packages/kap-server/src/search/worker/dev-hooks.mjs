// Resolve hook for the DEV search worker (`--experimental-transform-types`).
//
// The worker entry's import closure runs from TypeScript source in dev and
// tests. minidb's internals import sibling modules with `.js` specifiers
// while the files on disk are `.ts` (the repo builds with bundler module
// resolution), and Node's native type stripping does no specifier remapping
// — so retry a missing relative `.js` specifier as `.ts` here. Registered by
// register-dev-hooks.mjs via `--import`; never bundled (the bundled worker
// is plain JS and needs no hook).
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (
      error?.code === 'ERR_MODULE_NOT_FOUND' &&
      (specifier.startsWith('./') || specifier.startsWith('../')) &&
      /\.m?js$/.test(specifier)
    ) {
      return nextResolve(specifier.replace(/\.m?js$/, '.ts'), context);
    }
    throw error;
  }
}
