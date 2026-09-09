import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Resolves the path to Kimi Code config.toml.
 * Respects KIMI_CODE_HOME if set, otherwise defaults to ~/.kimi-code/config.toml.
 */
export function getConfigPath() {
  const baseDir = process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
  return path.join(baseDir, 'config.toml');
}

/**
 * Escapes a string for TOML if needed, or unquotes a TOML string.
 */
function unquote(str) {
  if (!str) return '';
  const trimmed = str.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Formats a key for TOML table header: e.g. [models."foo/bar"] or [models.foo]
 */
export function formatSectionKey(prefix, key) {
  if (/^[A-Za-z0-9_-]+$/.test(key)) {
    return `${prefix}.${key}`;
  }
  return `${prefix}."${key}"`;
}

/**
 * Parses simple TOML string values, booleans, numbers, and string arrays.
 */
function parseTomlValue(valStr) {
  const trimmed = valStr.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  if (/^-?\d+\.\d+$/.test(trimmed)) return parseFloat(trimmed);
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];
    // Split by comma
    return inner.split(',').map(item => unquote(item.trim())).filter(x => x.length > 0);
  }
  return trimmed;
}

/**
 * Parses the raw TOML string into a structured JavaScript object.
 * Extracts top-level keys, [providers.*], [models.*], [thinking], etc.
 */
export function parseToml(content) {
  const lines = content.split(/\r?\n/);
  const result = {
    providers: {},
    models: {},
    thinking: {}
  };

  let currentSection = null; // e.g. { type: 'providers', key: 'custom' } or { type: 'thinking' }

  for (let line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    // Section header: [something] or [something."nested"]
    const sectionMatch = trimmed.match(/^\[([A-Za-z0-9_.-]+|"[^"]+"|[A-Za-z0-9_-]+\."[^"]+")\]$/);
    if (sectionMatch) {
      const header = sectionMatch[1];
      if (header === 'thinking') {
        currentSection = { type: 'thinking' };
        result.thinking = result.thinking || {};
      } else if (header.startsWith('providers.')) {
        let key = header.slice('providers.'.length);
        key = unquote(key);
        result.providers[key] = result.providers[key] || {};
        currentSection = { type: 'providers', key };
      } else if (header.startsWith('models.')) {
        let key = header.slice('models.'.length);
        key = unquote(key);
        result.models[key] = result.models[key] || {};
        currentSection = { type: 'models', key };
      } else {
        currentSection = { type: 'other', key: header };
        result[header] = result[header] || {};
      }
      continue;
    }

    // Key-value pair: key = value
    const kvMatch = trimmed.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
    if (kvMatch) {
      const key = kvMatch[1];
      const rawVal = kvMatch[2];
      const parsedVal = parseTomlValue(rawVal);

      if (!currentSection) {
        result[key] = parsedVal;
      } else if (currentSection.type === 'providers' && currentSection.key) {
        result.providers[currentSection.key][key] = parsedVal;
      } else if (currentSection.type === 'models' && currentSection.key) {
        result.models[currentSection.key][key] = parsedVal;
      } else if (currentSection.type === 'thinking') {
        result.thinking[key] = parsedVal;
      } else if (currentSection.type === 'other' && currentSection.key) {
        result[currentSection.key][key] = parsedVal;
      }
    }
  }

  return result;
}

/**
 * Reads and parses ~/.kimi-code/config.toml (or KIMI_CODE_HOME).
 * Returns { raw: string, config: object, path: string }
 */
export function loadConfig(customPath = null) {
  const filePath = customPath || getConfigPath();
  if (!fs.existsSync(filePath)) {
    return {
      raw: '',
      config: { providers: {}, models: {}, thinking: {} },
      path: filePath
    };
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const config = parseToml(raw);
  return {
    raw,
    config,
    path: filePath
  };
}

/**
 * Finds the line range [startIndex, endIndex) of a specific section in the TOML string.
 * Section header format can be [models.alias] or [models."alias"] or [thinking]
 */
function findSectionRange(lines, sectionHeaderRegex) {
  let startIndex = -1;
  let endIndex = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (startIndex === -1) {
      if (sectionHeaderRegex.test(line)) {
        startIndex = i;
      }
    } else {
      // If we see another section header, this section has ended
      if (/^\[[^\]]+\]$/.test(line)) {
        endIndex = i;
        break;
      }
    }
  }

  return { startIndex, endIndex };
}

/**
 * Helper to update or insert key-values in a slice of lines, preserving formatting.
 */
function updateKeyValueInLines(lines, key, newValueFormatted, insertAtEnd = true) {
  const keyRegex = new RegExp(`^(\\s*)${key}\\s*=.*$`);
  let found = false;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(keyRegex);
    if (match) {
      const indent = match[1];
      lines[i] = `${indent}${key} = ${newValueFormatted}`;
      found = true;
      break;
    }
  }

  if (!found) {
    if (insertAtEnd) {
      // Find the last non-empty line
      let lastContentIdx = lines.length - 1;
      while (lastContentIdx >= 0 && lines[lastContentIdx].trim() === '') {
        lastContentIdx--;
      }
      lines.splice(lastContentIdx + 1, 0, `${key} = ${newValueFormatted}`);
    } else {
      lines.splice(1, 0, `${key} = ${newValueFormatted}`);
    }
  }
}

/**
 * Updates the specified model alias section in config.toml with:
 * - support_efforts = [...]
 * - default_effort = "..."
 * If capabilities does not include "thinking", appends "thinking" if it's a reasoning model (support_efforts.length > 0).
 * Preserves comments, indentation, and structure.
 */
export function saveModelEffort(modelAlias, supportedEfforts, defaultEffort, customPath = null) {
  const filePath = customPath || getConfigPath();
  const { raw } = loadConfig(filePath);
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  let lines = raw.length > 0 ? raw.split(/\r?\n/) : [];

  // Match [models.alias] or [models."alias"]
  const escapedAlias = modelAlias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sectionHeaderRegex = new RegExp(`^\\[models\\.(?:"${escapedAlias}"|${escapedAlias})\\]$`);

  let { startIndex, endIndex } = findSectionRange(lines, sectionHeaderRegex);

  // If the model section does not exist, create it
  if (startIndex === -1) {
    const header = /^[A-Za-z0-9_-]+$/.test(modelAlias)
      ? `[models.${modelAlias}]`
      : `[models."${modelAlias}"]`;
    if (lines.length > 0 && lines[lines.length - 1].trim() !== '') {
      lines.push('');
    }
    startIndex = lines.length;
    lines.push(header);
    endIndex = lines.length;
  }

  // Extract section lines
  const sectionLines = lines.slice(startIndex, endIndex);

  // 1. Update support_efforts
  const formattedEfforts = `[ ${supportedEfforts.map(e => `"${e}"`).join(', ')} ]`;
  updateKeyValueInLines(sectionLines, 'support_efforts', formattedEfforts);

  // 2. Update default_effort if provided
  if (defaultEffort !== undefined && defaultEffort !== null) {
    updateKeyValueInLines(sectionLines, 'default_effort', `"${defaultEffort}"`);
  }

  // 3. Ensure capabilities has "thinking" if supportedEfforts has elements
  if (supportedEfforts && supportedEfforts.length > 0) {
    const capRegex = /^(\s*)capabilities\s*=\s*(.*)$/;
    let capIndex = -1;
    let capLineMatch = null;

    for (let i = 0; i < sectionLines.length; i++) {
      const match = sectionLines[i].match(capRegex);
      if (match) {
        capIndex = i;
        capLineMatch = match;
        break;
      }
    }

    if (capIndex !== -1) {
      const indent = capLineMatch[1];
      const parsedCaps = parseTomlValue(capLineMatch[2]);
      if (Array.isArray(parsedCaps)) {
        if (!parsedCaps.includes('thinking')) {
          parsedCaps.push('thinking');
          sectionLines[capIndex] = `${indent}capabilities = [ ${parsedCaps.map(c => `"${c}"`).join(', ')} ]`;
        }
      }
    } else {
      // Add capabilities = [ "thinking" ]
      updateKeyValueInLines(sectionLines, 'capabilities', '[ "thinking" ]');
    }
  }

  // Replace old section with updated sectionLines
  lines.splice(startIndex, endIndex - startIndex, ...sectionLines);

  const updatedContent = lines.join(eol);
  fs.writeFileSync(filePath, updatedContent, 'utf8');
  return true;
}

/**
 * Updates [thinking] effort = "..." and/or default_effort in the model entry.
 * If modelAlias is provided, updates default_effort in that model entry as well.
 */
export function setThinkingEffort(effortLevel, modelAlias = null, customPath = null) {
  const filePath = customPath || getConfigPath();
  const { raw } = loadConfig(filePath);
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  let lines = raw.length > 0 ? raw.split(/\r?\n/) : [];

  // 1. Update [thinking] section: effort = "..."
  const thinkingHeaderRegex = /^\[thinking\]$/;
  let { startIndex, endIndex } = findSectionRange(lines, thinkingHeaderRegex);

  if (startIndex === -1) {
    if (lines.length > 0 && lines[lines.length - 1].trim() !== '') {
      lines.push('');
    }
    startIndex = lines.length;
    lines.push('[thinking]');
    lines.push(`effort = "${effortLevel}"`);
    endIndex = lines.length;
  } else {
    const sectionLines = lines.slice(startIndex, endIndex);
    updateKeyValueInLines(sectionLines, 'effort', `"${effortLevel}"`);
    lines.splice(startIndex, endIndex - startIndex, ...sectionLines);
  }

  // 2. If modelAlias is provided, update default_effort in [models.<modelAlias>]
  if (modelAlias) {
    const escapedAlias = modelAlias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const modelHeaderRegex = new RegExp(`^\\[models\\.(?:"${escapedAlias}"|${escapedAlias})\\]$`);
    const modelRange = findSectionRange(lines, modelHeaderRegex);
    if (modelRange.startIndex !== -1) {
      const modelLines = lines.slice(modelRange.startIndex, modelRange.endIndex);
      updateKeyValueInLines(modelLines, 'default_effort', `"${effortLevel}"`);
      lines.splice(modelRange.startIndex, modelRange.endIndex - modelRange.startIndex, ...modelLines);
    }
  }

  const updatedContent = lines.join(eol);
  fs.writeFileSync(filePath, updatedContent, 'utf8');
  return true;
}

/**
 * Attempts to detect the currently active model from the most recent Kimi Code session.
 */
function detectCurrentSessionModel(config) {
  try {
    const baseDir = process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
    const sessionsDir = path.join(baseDir, 'sessions');
    if (!fs.existsSync(sessionsDir)) return null;

    const wdEntries = fs.readdirSync(sessionsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name.startsWith('wd_'))
      .map(d => {
        const full = path.join(sessionsDir, d.name);
        return { path: full, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);

    if (wdEntries.length === 0) return null;

    for (const wd of wdEntries.slice(0, 3)) {
      const sessionEntries = fs.readdirSync(wd.path, { withFileTypes: true })
        .filter(d => d.isDirectory() && d.name.startsWith('session_'))
        .map(d => {
          const full = path.join(wd.path, d.name);
          return { path: full, mtime: fs.statSync(full).mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);

      if (sessionEntries.length === 0) continue;

      const latestSession = sessionEntries[0].path;
      const wirePath = path.join(latestSession, 'agents', 'main', 'wire.jsonl');
      if (!fs.existsSync(wirePath)) continue;

      const stat = fs.statSync(wirePath);
      const readSize = Math.min(stat.size, 65536); // read up to last 64KB
      const buffer = Buffer.alloc(readSize);
      const fd = fs.openSync(wirePath, 'r');
      fs.readSync(fd, buffer, 0, readSize, stat.size - readSize);
      fs.closeSync(fd);

      const text = buffer.toString('utf8');
      const matches = [...text.matchAll(/"model"\s*:\s*"([^"]+)"/g)];
      if (matches.length > 0) {
        for (let i = matches.length - 1; i >= 0; i--) {
          const candidate = matches[i][1];
          if (config && config.models && config.models[candidate]) {
            return candidate;
          }
          // Check if candidate matches model field inside any config.models entry
          if (config && config.models) {
            for (const [alias, m] of Object.entries(config.models)) {
              if (m.model === candidate || alias.endsWith('/' + candidate)) {
                return alias;
              }
            }
          }
        }
      }
    }
  } catch {
    // Fail silently if session inspection fails
  }
  return null;
}

/**
 * Determines the current active model from explicit argument, active session,
 * environment, or default_model, along with provider details and effort capabilities.
 */
export function getCurrentModelInfo(customPath = null, explicitModel = null) {
  const { config, path: filePath } = loadConfig(customPath);

  let activeAlias = null;

  // 1. Explicit model alias passed in
  if (explicitModel) {
    if (config.models && config.models[explicitModel]) {
      activeAlias = explicitModel;
    } else if (config.models) {
      // Fuzzy lookup by prefix/suffix
      const lower = explicitModel.toLowerCase();
      for (const alias of Object.keys(config.models)) {
        if (alias.toLowerCase() === lower || alias.toLowerCase().endsWith('/' + lower) || alias.toLowerCase().includes(lower)) {
          activeAlias = alias;
          break;
        }
      }
    }
    if (!activeAlias) activeAlias = explicitModel;
  }

  // 2. Environment variable
  if (!activeAlias) {
    activeAlias = process.env.KIMI_SESSION_MODEL || process.env.KIMI_MODEL;
  }

  // 3. Inspect recent active session wire.jsonl
  if (!activeAlias) {
    activeAlias = detectCurrentSessionModel(config);
  }

  // 4. Fallback to default_model in config.toml
  if (!activeAlias) {
    activeAlias = config.default_model;
  }

  // 5. First model defined in [models.*]
  const modelKeys = Object.keys(config.models || {});
  if (!activeAlias && modelKeys.length > 0) {
    activeAlias = modelKeys[0];
  }

  const modelEntry = (activeAlias && config.models && config.models[activeAlias]) || null;
  const providerKey = modelEntry ? modelEntry.provider : null;
  const providerConfig = (providerKey && config.providers && config.providers[providerKey]) || null;

  // Check thinking configuration
  const thinkingConfig = config.thinking || {};
  const globalEffort = thinkingConfig.effort || null;
  const modelDefaultEffort = modelEntry ? (modelEntry.default_effort || null) : null;
  const currentEffort = modelDefaultEffort || globalEffort || 'medium';

  const capabilities = (modelEntry && Array.isArray(modelEntry.capabilities)) ? modelEntry.capabilities : [];
  const thinkingCapability = capabilities.includes('thinking');
  const thinkingEnabled = thinkingConfig.enabled !== false; // defaults to true unless explicitly false

  const supportedEfforts = (modelEntry && Array.isArray(modelEntry.support_efforts))
    ? modelEntry.support_efforts
    : [];

  return {
    configPath: filePath,
    activeModelAlias: activeAlias,
    modelName: modelEntry ? (modelEntry.model || activeAlias) : activeAlias,
    modelConfig: modelEntry,
    providerName: providerKey,
    providerConfig: providerConfig,
    thinkingEnabled: thinkingEnabled,
    hasThinkingCapability: thinkingCapability,
    currentEffort: currentEffort,
    defaultEffort: modelDefaultEffort,
    globalEffort: globalEffort,
    supportedEfforts: supportedEfforts,
    isConfigured: !!modelEntry
  };
}

export default {
  getConfigPath,
  formatSectionKey,
  parseToml,
  loadConfig,
  saveModelEffort,
  setThinkingEffort,
  getCurrentModelInfo
};
