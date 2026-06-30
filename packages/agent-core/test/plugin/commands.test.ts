import { describe, expect, it } from 'vitest';

import { expandCommandArguments, parseCommandText } from '../../src/plugin/commands';

describe('parseCommandText', () => {
  it('parses frontmatter description and body', () => {
    const def = parseCommandText({
      text: '---\ndescription: Deploy to Vercel\n---\nDeploy this. Args: $ARGUMENTS',
      commandPath: '/p/commands/deploy.md',
      pluginId: 'my-plugin',
    });
    expect(def).toEqual({
      pluginId: 'my-plugin',
      name: 'deploy',
      description: 'Deploy to Vercel',
      body: 'Deploy this. Args: $ARGUMENTS',
      path: '/p/commands/deploy.md',
    });
  });

  it('uses frontmatter name over the filename', () => {
    const def = parseCommandText({
      text: '---\nname: ship\ndescription: Ship it\n---\nbody',
      commandPath: '/p/commands/deploy.md',
      pluginId: 'p',
    });
    expect(def.name).toBe('ship');
  });

  it('falls back to filename for name and first body line for description', () => {
    const def = parseCommandText({
      text: 'Deploy this project to Vercel.\n\nMore details.',
      commandPath: '/p/commands/deploy.md',
      pluginId: 'p',
    });
    expect(def.name).toBe('deploy');
    expect(def.description).toBe('Deploy this project to Vercel.');
    expect(def.body).toBe('Deploy this project to Vercel.\n\nMore details.');
  });

  it('handles an empty body with a default description', () => {
    const def = parseCommandText({
      text: '',
      commandPath: '/p/commands/x.md',
      pluginId: 'p',
    });
    expect(def.name).toBe('x');
    expect(def.description).toBe('No description provided.');
    expect(def.body).toBe('');
  });
});

describe('expandCommandArguments', () => {
  it('replaces $ARGUMENTS with the typed args', () => {
    expect(expandCommandArguments('Deploy $ARGUMENTS now', 'prod')).toBe('Deploy prod now');
  });

  it('appends args when there is no placeholder', () => {
    expect(expandCommandArguments('Deploy now', 'prod')).toBe('Deploy now\n\nARGUMENTS: prod');
  });

  it('leaves the body unchanged when there is no placeholder and no args', () => {
    expect(expandCommandArguments('Deploy now', '')).toBe('Deploy now');
  });
});
