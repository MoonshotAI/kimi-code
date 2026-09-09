#!/usr/bin/env node

/**
 * effort-cli.mjs - Command Line Interface for Kimi Effort Plugin
 * 
 * Provides commands to inspect, detect, and configure reasoning effort
 * for models in Kimi Code CLI.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import configManager from './config-manager.mjs';

// Dynamically import effort-detector.mjs if available, or fall back to heuristic detection
let detectModelEffort = null;
try {
  const detectorModule = await import('./effort-detector.mjs');
  detectModelEffort = detectorModule.detectModelEffort;
} catch (err) {
  // If effort-detector.mjs is not yet available, provide a fallback detector
  detectModelEffort = async (providerConfig, modelName, modelConfig, options = {}) => {
    const name = (modelName || '').toLowerCase();
    
    // Heuristics sniffing
    if (/o[13]|gpt-[56]|sol|astra/.test(name)) {
      return {
        isReasoningModel: true,
        supportedEfforts: ['low', 'medium', 'high'],
        defaultEffort: 'high',
        detectionMethod: 'heuristic',
        details: 'Matched OpenAI/advanced reasoning model pattern'
      };
    }
    if (/claude-3-7|claude-opus-4|sonnet/.test(name)) {
      return {
        isReasoningModel: true,
        supportedEfforts: ['low', 'medium', 'high', 'max'],
        defaultEffort: 'high',
        detectionMethod: 'heuristic',
        details: 'Matched Anthropic Claude reasoning model pattern'
      };
    }
    if (/gemini-2\.0-flash-thinking|gemini-2\.5|gemini-3/.test(name)) {
      return {
        isReasoningModel: true,
        supportedEfforts: ['low', 'high'],
        defaultEffort: 'high',
        detectionMethod: 'heuristic',
        details: 'Matched Google Gemini reasoning model pattern'
      };
    }
    if (/deepseek-r1|r1|qwq/.test(name)) {
      return {
        isReasoningModel: true,
        supportedEfforts: ['default', 'high'],
        defaultEffort: 'high',
        detectionMethod: 'heuristic',
        details: 'Matched DeepSeek / QwQ reasoning model pattern'
      };
    }
    if (/gpt-4o|claude-3-5-haiku/.test(name)) {
      return {
        isReasoningModel: false,
        supportedEfforts: [],
        defaultEffort: null,
        detectionMethod: 'heuristic',
        details: 'Known non-reasoning model'
      };
    }

    return {
      isReasoningModel: false,
      supportedEfforts: [],
      defaultEffort: null,
      detectionMethod: 'heuristic',
      details: 'Unrecognized model pattern, no reasoning capabilities detected'
    };
  };
}

// ANSI styling helpers
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m'
};

const c = {
  bold: (t) => `${colors.bold}${t}${colors.reset}`,
  dim: (t) => `${colors.dim}${t}${colors.reset}`,
  red: (t) => `${colors.red}${t}${colors.reset}`,
  green: (t) => `${colors.green}${t}${colors.reset}`,
  yellow: (t) => `${colors.yellow}${t}${colors.reset}`,
  blue: (t) => `${colors.blue}${t}${colors.reset}`,
  magenta: (t) => `${colors.magenta}${t}${colors.reset}`,
  cyan: (t) => `${colors.cyan}${t}${colors.reset}`,
  gray: (t) => `${colors.gray}${t}${colors.reset}`,
  tag: (t, color = colors.cyan) => `${color}[${t}]${colors.reset}`
};

/**
 * Print command usage / help message
 */
function printHelp() {
  console.log(`
${c.bold('kimi-effort')} - Automatic reasoning effort detection & adjustment CLI

${c.bold('USAGE:')}
  effort-cli.mjs <command> [arguments]

${c.bold('COMMANDS:')}
  ${c.cyan('status')} [model]        Show current active model or specified model's reasoning status
  ${c.cyan('detect')} [model|all]    Run capability detection on specified model or all models
  ${c.cyan('set')} <effort> [model]  Set thinking effort level for active model or specified model
  ${c.cyan('list')}                  List all configured models, provider, and detected effort options
  ${c.cyan('help')}                  Display this help message

${c.bold('EXAMPLES:')}
  node effort-cli.mjs status
  node effort-cli.mjs detect all
  node effort-cli.mjs detect "openai/gpt-5.6-sol"
  node effort-cli.mjs set high
  node effort-cli.mjs set medium "cpa-claude/claude-opus-4-8"
  node effort-cli.mjs list
`);
}

/**
 * Command: status [model]
 */
async function handleStatus(targetModelAlias) {
  const { config, path: configPath } = configManager.loadConfig();

  let modelAlias = targetModelAlias;
  let isSessionActive = false;
  if (!modelAlias) {
    const current = configManager.getCurrentModelInfo(null);
    modelAlias = current.activeModelAlias;
    if (modelAlias && modelAlias !== config.default_model) {
      isSessionActive = true;
    }
  }

  if (!modelAlias) {
    console.error(c.red('Error: No active model found in config.toml or specified.'));
    process.exit(1);
  }

  const modelEntry = config.models ? config.models[modelAlias] : null;
  if (!modelEntry && targetModelAlias) {
    console.error(c.red(`Error: Model "${targetModelAlias}" not found in config.toml.`));
    process.exit(1);
  }

  const providerKey = modelEntry ? modelEntry.provider : null;
  const providerConfig = (providerKey && config.providers) ? config.providers[providerKey] : null;
  const actualModelName = modelEntry ? (modelEntry.model || modelAlias) : modelAlias;

  const thinkingConfig = config.thinking || {};
  const thinkingEnabled = thinkingConfig.enabled !== false;
  const globalEffort = thinkingConfig.effort || null;
  const modelDefaultEffort = modelEntry ? (modelEntry.default_effort || null) : null;
  const currentEffort = modelDefaultEffort || globalEffort || 'medium';

  const capabilities = (modelEntry && Array.isArray(modelEntry.capabilities)) ? modelEntry.capabilities : [];
  const hasThinkingCap = capabilities.includes('thinking');
  const supportedEfforts = (modelEntry && Array.isArray(modelEntry.support_efforts)) ? modelEntry.support_efforts : [];

  console.log(`\n${c.bold('=== Kimi Code Reasoning Effort Status ===')}\n`);
  console.log(`  ${c.bold('Config File:')}     ${configPath}`);
  
  let aliasTag = '';
  if (!targetModelAlias) {
    if (isSessionActive) {
      aliasTag = c.green(' (active in current session)');
    } else if (modelAlias === config.default_model) {
      aliasTag = c.dim(' (default_model in config.toml)');
    }
  }
  console.log(`  ${c.bold('Model Alias:')}     ${c.cyan(modelAlias)}${aliasTag}`);
  console.log(`  ${c.bold('Actual Model:')}    ${actualModelName}`);
  console.log(`  ${c.bold('Provider:')}        ${providerKey ? c.blue(providerKey) : c.dim('(unknown)')} ${providerConfig ? c.dim(`[${providerConfig.type || 'openai'}]`) : ''}`);
  
  const statusStr = thinkingEnabled ? c.green('Enabled') : c.red('Disabled');
  const capStr = hasThinkingCap ? c.green('Supported') : c.yellow('Not marked');
  console.log(`  ${c.bold('Thinking State:')}  ${statusStr} (Capability: ${capStr})`);

  console.log(`  ${c.bold('Current Effort:')}  ${c.bold(c.cyan(currentEffort))}${modelDefaultEffort ? c.dim(' (model default)') : (globalEffort ? c.dim(' (global thinking.effort)') : c.dim(' (fallback)'))}`);
  
  if (supportedEfforts.length > 0) {
    console.log(`  ${c.bold('Supported Levels:')} [ ${supportedEfforts.map(e => (e === 'max' ? c.bold(c.magenta('max')) : (e === currentEffort ? c.bold(c.green(e)) : e))).join(', ')} ]`);
  } else {
    console.log(`  ${c.bold('Supported Levels:')} ${c.yellow('Not detected yet')} ${c.dim('(Run "effort-cli.mjs detect" to detect)')}`);
  }

  // Helpful guidance for model switching in TUI
  console.log(`\n  ${c.bold(c.yellow('💡 Notice on /effort in TUI:'))}`);
  console.log(`  When switching models in an active session, run ${c.bold(c.cyan('/reload'))} in Kimi Code`);
  console.log(`  to ensure the in-memory TUI picker reflects this model's latest effort levels (e.g. max).\n`);
}

/**
 * Command: detect [model|all]
 */
async function handleDetect(target) {
  const { config, path: configPath } = configManager.loadConfig();
  const models = config.models || {};
  const modelKeys = Object.keys(models);

  if (modelKeys.length === 0) {
    console.log(c.yellow(`No models found configured in ${configPath}.`));
    return;
  }

  let targets = [];
  if (!target || target === 'all') {
    targets = modelKeys;
  } else if (models[target]) {
    targets = [target];
  } else {
    // If target is not a key directly, check if target matches a model name
    const found = modelKeys.find(k => k === target || (models[k] && models[k].model === target));
    if (found) {
      targets = [found];
    } else {
      console.error(c.red(`Error: Model "${target}" is not defined in config.toml.`));
      process.exit(1);
    }
  }

  console.log(`\n${c.bold('=== Running Reasoning Capability Detection ===')}`);
  console.log(c.dim(`Targeting ${targets.length} model(s)...`));

  const results = [];

  for (const alias of targets) {
    const modelEntry = models[alias] || {};
    const providerKey = modelEntry.provider;
    const providerConfig = providerKey && config.providers ? config.providers[providerKey] : null;
    const modelName = modelEntry.model || alias;

    process.stdout.write(`\n${c.cyan('•')} Probing ${c.bold(alias)} (${modelName})... `);

    try {
      const probeResult = await detectModelEffort(providerConfig, modelName, modelEntry, { timeout: 5000 });
      results.push({
        alias,
        modelName,
        provider: providerKey || '-',
        isReasoning: probeResult.isReasoningModel,
        supportedEfforts: probeResult.supportedEfforts || [],
        defaultEffort: probeResult.defaultEffort,
        method: probeResult.detectionMethod || 'heuristic',
        details: probeResult.details || ''
      });

      if (probeResult.isReasoningModel) {
        console.log(c.green('Reasoning Model'));
        console.log(`  ${c.dim('Efforts:')}   [ ${(probeResult.supportedEfforts || []).join(', ')} ] (default: ${probeResult.defaultEffort || 'medium'})`);
        console.log(`  ${c.dim('Method:')}    ${probeResult.detectionMethod} (${probeResult.details})`);
      } else {
        console.log(c.gray('Non-reasoning Model'));
        console.log(`  ${c.dim('Details:')}   ${probeResult.details}`);
      }

      // Save to config.toml
      configManager.saveModelEffort(
        alias,
        probeResult.supportedEfforts || [],
        probeResult.defaultEffort
      );
    } catch (err) {
      console.log(c.red('Failed'));
      console.error(`  ${c.red('Error:')} ${err.message}`);
      results.push({
        alias,
        modelName,
        provider: providerKey || '-',
        isReasoning: false,
        supportedEfforts: [],
        defaultEffort: null,
        method: 'error',
        details: err.message
      });
    }
  }

  // Summary Table
  console.log(`\n${c.bold('=== Detection Summary & Configuration Updated ===')}\n`);
  
  // Table column widths
  const colAlias = Math.max(12, ...results.map(r => r.alias.length));
  const colProvider = Math.max(10, ...results.map(r => r.provider.length));
  const colReasoning = 10;
  const colEfforts = Math.max(18, ...results.map(r => `[${r.supportedEfforts.join(', ')}]`.length));
  const colMethod = 10;

  const header = `| ${'Model Alias'.padEnd(colAlias)} | ${'Provider'.padEnd(colProvider)} | ${'Reasoning'.padEnd(colReasoning)} | ${'Supported Efforts'.padEnd(colEfforts)} | ${'Method'.padEnd(colMethod)} |`;
  const sep = `|-${'-'.repeat(colAlias)}-|-${'-'.repeat(colProvider)}-|-${'-'.repeat(colReasoning)}-|-${'-'.repeat(colEfforts)}-|-${'-'.repeat(colMethod)}-|`;

  console.log(header);
  console.log(sep);
  for (const r of results) {
    const reasoningText = r.isReasoning ? 'Yes' : 'No';
    const effortsText = r.supportedEfforts.length > 0 ? `[${r.supportedEfforts.join(', ')}]` : '[]';
    console.log(`| ${r.alias.padEnd(colAlias)} | ${r.provider.padEnd(colProvider)} | ${reasoningText.padEnd(colReasoning)} | ${effortsText.padEnd(colEfforts)} | ${r.method.padEnd(colMethod)} |`);
  }

  console.log(`\n${c.green('✔')} Successfully updated config at ${c.dim(configPath)}.`);
  console.log(`${c.cyan('Tip:')} Use ${c.bold('/reload')} in Kimi Code CLI to apply config changes.\n`);
}

/**
 * Command: set <effort> [model]
 */
async function handleSet(effortLevel, targetModelAlias) {
  if (!effortLevel) {
    console.error(c.red('Error: Effort level argument is required (e.g. low, medium, high, max).'));
    console.log(c.dim('Usage: node effort-cli.mjs set <effort> [model]'));
    process.exit(1);
  }

  const { config, path: configPath } = configManager.loadConfig();
  let modelAlias = targetModelAlias;

  if (!modelAlias) {
    const current = configManager.getCurrentModelInfo();
    modelAlias = current.activeModelAlias;
  }

  if (!modelAlias) {
    console.error(c.red('Error: No active model found in config.toml and no model specified.'));
    process.exit(1);
  }

  const modelEntry = (config.models && config.models[modelAlias]) || null;
  const supportedEfforts = (modelEntry && Array.isArray(modelEntry.support_efforts))
    ? modelEntry.support_efforts
    : [];

  // Normalize effort input
  const effort = effortLevel.toLowerCase().trim();

  // Validate effort against supportedEfforts if known
  if (supportedEfforts.length > 0) {
    if (!supportedEfforts.includes(effort)) {
      console.error(c.red(`Error: "${effort}" is not supported by model "${modelAlias}".`));
      console.log(`Available supported effort levels: [ ${supportedEfforts.map(e => c.cyan(e)).join(', ')} ]`);
      process.exit(1);
    }
  } else {
    // If not detected yet, validate against standard effort levels
    const standardLevels = ['none', 'low', 'medium', 'high', 'max', 'default'];
    if (!standardLevels.includes(effort)) {
      console.warn(c.yellow(`Warning: "${effort}" is not a recognized standard effort level [${standardLevels.join(', ')}]. Proceeding anyway.`));
    }
  }

  // Update config
  configManager.setThinkingEffort(effort, modelAlias);

  console.log(`\n${c.green('✔')} Successfully updated thinking effort for model ${c.bold(c.cyan(modelAlias))}:`);
  console.log(`  ${c.bold('New Effort Level:')}  ${c.bold(c.green(effort))}`);
  console.log(`  ${c.bold('Target Config:')}     ${c.dim(configPath)}`);
  console.log(`\n${c.yellow('Notice:')} Please run ${c.bold('/reload')} in Kimi Code CLI to reload the configuration.\n`);
}

/**
 * Command: list
 */
async function handleList() {
  const { config, path: configPath } = configManager.loadConfig();
  const models = config.models || {};
  const modelKeys = Object.keys(models);

  console.log(`\n${c.bold('=== Configured Models & Effort Capabilities ===')}\n`);
  console.log(`${c.dim('Config file:')} ${configPath}`);
  console.log(`${c.dim('Default model:')} ${config.default_model || '(none)'}\n`);

  if (modelKeys.length === 0) {
    console.log(c.yellow('No models defined in [models.*] sections.\n'));
    return;
  }

  const rows = modelKeys.map(alias => {
    const m = models[alias];
    const isDefault = alias === config.default_model;
    const provider = m.provider || '-';
    const actualModel = m.model || alias;
    const supported = Array.isArray(m.support_efforts) ? m.support_efforts : [];
    const isReasoning = supported.length > 0 || (Array.isArray(m.capabilities) && m.capabilities.includes('thinking'));
    const defaultEffort = m.default_effort || config.thinking?.effort || '-';

    return {
      alias: isDefault ? `${alias} (*)` : alias,
      provider,
      actualModel,
      isReasoning: isReasoning ? 'Yes' : 'No',
      efforts: supported.length > 0 ? `[${supported.join(', ')}]` : (isReasoning ? '(unprobed)' : 'None'),
      currentEffort: defaultEffort
    };
  });

  const colAlias = Math.max(14, ...rows.map(r => r.alias.length));
  const colProvider = Math.max(10, ...rows.map(r => r.provider.length));
  const colReasoning = 10;
  const colEfforts = Math.max(18, ...rows.map(r => r.efforts.length));
  const colCurrent = 12;

  const header = `| ${'Model Alias'.padEnd(colAlias)} | ${'Provider'.padEnd(colProvider)} | ${'Reasoning'.padEnd(colReasoning)} | ${'Supported Efforts'.padEnd(colEfforts)} | ${'Effort'.padEnd(colCurrent)} |`;
  const sep = `|-${'-'.repeat(colAlias)}-|-${'-'.repeat(colProvider)}-|-${'-'.repeat(colReasoning)}-|-${'-'.repeat(colEfforts)}-|-${'-'.repeat(colCurrent)}-|`;

  console.log(header);
  console.log(sep);
  for (const r of rows) {
    console.log(`| ${r.alias.padEnd(colAlias)} | ${r.provider.padEnd(colProvider)} | ${r.isReasoning.padEnd(colReasoning)} | ${r.efforts.padEnd(colEfforts)} | ${r.currentEffort.padEnd(colCurrent)} |`);
  }

  console.log(`\n${c.dim('(*) marks current default_model')}`);
  console.log(`${c.dim('Run "node effort-cli.mjs detect all" to probe and update capabilities.')}\n`);
}

/**
 * Main CLI entry point
 */
async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'help';

  switch (command.toLowerCase()) {
    case 'status': {
      const model = args[1] || null;
      await handleStatus(model);
      break;
    }
    case 'detect':
    case 'probe': {
      const target = args[1] || 'all';
      await handleDetect(target);
      break;
    }
    case 'set': {
      const effort = args[1] || null;
      const model = args[2] || null;
      await handleSet(effort, model);
      break;
    }
    case 'list':
    case 'ls': {
      await handleList();
      break;
    }
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      break;
    default:
      console.error(c.red(`Unknown command: "${command}"`));
      printHelp();
      process.exit(1);
  }
}

main().catch(err => {
  console.error(c.red(`Unhandled CLI Error: ${err.message}`));
  if (process.env.DEBUG) {
    console.error(err.stack);
  }
  process.exit(1);
});
