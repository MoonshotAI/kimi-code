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

  it('derives name from hyphenated filename', () => {
    const def = parseCommandText({
      text: '---\ndescription: My command\n---\nbody',
      commandPath: '/p/commands/my-command.md',
      pluginId: 'p',
    });
    expect(def.name).toBe('my-command');
  });

  it('handles malformed frontmatter gracefully', () => {
    const def = parseCommandText({
      text: '---\nno closing delimiter\nbody',
      commandPath: '/p/commands/invalid.md',
      pluginId: 'p',
    });
    expect(def.name).toBe('invalid');
    expect(def.description).toBe('no closing delimiter');
    expect(def.body).toBe('no closing delimiter');
  });

  it('accepts unicode and special characters in description and body', () => {
    const def = parseCommandText({
      text: '---\ndescription: Déployer 部署 🚀\n---\nBody with $pecial chars & more.',
      commandPath: '/p/commands/deploy.md',
      pluginId: 'p',
    });
    expect(def.description).toBe('Déployer 部署 🚀');
    expect(def.body).toBe('Body with $pecial chars & more.');
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

  it('replaces $ARGUMENTS in the middle of the body', () => {
    expect(expandCommandArguments('Run $ARGUMENTS now', 'npm test')).toBe('Run npm test now');
  });

  it('replaces multiple $ARGUMENTS occurrences', () => {
    expect(expandCommandArguments('$ARGUMENTS and $ARGUMENTS', 'x')).toBe('x and x');
  });

  it('preserves args with special characters when no placeholder', () => {
    expect(expandCommandArguments('Exec', '--flag="value" --path=/a/b')).toBe(
      'Exec\n\nARGUMENTS: --flag="value" --path=/a/b',
    );
  });
});
