import { defineConfig } from 'vitest/config';
import { vscodeProjects } from './vitest.projects';

export default defineConfig({
  test: {
    projects: vscodeProjects,
  },
});
