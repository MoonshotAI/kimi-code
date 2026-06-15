import { describe, expect, it } from 'vitest';

import { createPublishPackageJson } from '../../scripts/prepare-npm-package.mjs';

describe('prepare npm package manifest', () => {
  it('omits bundled runtime dependencies from the publish manifest', () => {
    const publishPackageJson = createPublishPackageJson();

    expect('dependencies' in publishPackageJson).toBe(false);
    expect(publishPackageJson.optionalDependencies).toEqual({
      '@mariozechner/clipboard': '^0.3.2',
    });
    expect(publishPackageJson.publishConfig).not.toHaveProperty('directory');
  });
});
