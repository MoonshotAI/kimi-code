import { describe, expect, it } from 'vitest';

import { normalizePluginId, PLUGIN_NAME_REGEX } from '#/app/plugin/types';

describe('plugin/types', () => {
  describe('PLUGIN_NAME_REGEX', () => {
    it('accepts lowercase alphanumeric names', () => {
      expect(PLUGIN_NAME_REGEX.test('my-plugin')).toBe(true);
      expect(PLUGIN_NAME_REGEX.test('tool_1')).toBe(true);
    });

    it('rejects names starting with a dash or underscore', () => {
      expect(PLUGIN_NAME_REGEX.test('-bad')).toBe(false);
      expect(PLUGIN_NAME_REGEX.test('_bad')).toBe(false);
    });

    it('rejects uppercase and empty names', () => {
      expect(PLUGIN_NAME_REGEX.test('Bad')).toBe(false);
      expect(PLUGIN_NAME_REGEX.test('')).toBe(false);
    });
  });

  describe('normalizePluginId', () => {
    it('lowercases the name', () => {
      expect(normalizePluginId('My-Plugin')).toBe('my-plugin');
    });
  });
});
