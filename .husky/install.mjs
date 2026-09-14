import { existsSync } from 'node:fs';

if (
  process.env.NODE_ENV === 'production' ||
  process.env.CI === 'true' ||
  process.env.npm_config_production === 'true' ||
  !existsSync('.git')
) {
  process.exit(0);
}

try {
  const husky = (await import('husky')).default;
  console.log(husky());
} catch (error) {
  if (error && error.code === 'ERR_MODULE_NOT_FOUND') process.exit(0);
  throw error;
}
