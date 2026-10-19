import { describe, expect, it } from 'vitest';

import { normalizePluginId, PLUGIN_NAME_REGEX } from '#/app/plugin/types';

describe('plugin/types', () => {
  describe('PLUGIN_NAME_REGEX', () => {
    it('accepts lowercase alphanumeric names', () => {
      expect(PLUGIN_NAME_REGEX.test('my-plugin')).toBe(true);
      expect(PLUGIN_NAME_REGEX.test('tool_1')).toBe(true);
    });

    it('accepts uppercase, leading dash or underscore, dotted segments, and @ suffixes', () => {
      expect(PLUGIN_NAME_REGEX.test('My-Plugin')).toBe(true);
      expect(PLUGIN_NAME_REGEX.test('-lead')).toBe(true);
      expect(PLUGIN_NAME_REGEX.test('_lead')).toBe(true);
      expect(PLUGIN_NAME_REGEX.test('lark.docs')).toBe(true);
      expect(PLUGIN_NAME_REGEX.test('name@beta')).toBe(true);
    });

    it('rejects empty names and names with illegal characters or empty segments', () => {
      expect(PLUGIN_NAME_REGEX.test('')).toBe(false);
      expect(PLUGIN_NAME_REGEX.test('bad name')).toBe(false);
      expect(PLUGIN_NAME_REGEX.test('.lead')).toBe(false);
      expect(PLUGIN_NAME_REGEX.test('trail.')).toBe(false);
      expect(PLUGIN_NAME_REGEX.test('a..b')).toBe(false);
      expect(PLUGIN_NAME_REGEX.test('a@b@c')).toBe(false);
      expect(PLUGIN_NAME_REGEX.test('name@1.0')).toBe(false);
    });
  });

  describe('normalizePluginId', () => {
    it('lowercases the name', () => {
      expect(normalizePluginId('My-Plugin')).toBe('my-plugin');
    });
  });
});
