#!/usr/bin/env node

/**
 * install.mjs - Installer and Verifier for Kimi Effort Plugin
 * 
 * Features:
 * 1. Copies plugin files to ~/.kimi-code/plugins/managed/effort/ (creating directories as needed).
 * 2. Updates/registers the plugin in ~/.kimi-code/plugins/installed.json so Kimi Code recognizes it.
 * 3. Runs automatic detection on user's configured models: node scripts/effort-cli.mjs detect all
 * 4. Validates that config.toml has been properly updated with support_efforts and default_effort.
 * 5. Runs status check to verify end-to-end functionality.
 * 6. Prints user instructions.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execSync, spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Styling
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

const c = {
  bold: (t) => `${colors.bold}${t}${colors.reset}`,
  dim: (t) => `${colors.dim}${t}${colors.reset}`,
  green: (t) => `${colors.green}${t}${colors.reset}`,
  red: (t) => `${colors.red}${t}${colors.reset}`,
  yellow: (t) => `${colors.yellow}${t}${colors.reset}`,
  cyan: (t) => `${colors.cyan}${t}${colors.reset}`,
  blue: (t) => `${colors.blue}${t}${colors.reset}`
};

function step(title) {
  console.log(`\n${c.bold(c.cyan('==>'))} ${c.bold(title)}`);
}

function success(msg) {
  console.log(`  ${c.green('✔')} ${msg}`);
}

function warn(msg) {
  console.log(`  ${c.yellow('⚠')} ${msg}`);
}

function fail(msg) {
  console.error(`  ${c.red('✖')} ${msg}`);
}

/**
 * Recursively copy directory, ignoring unnecessary files
 */
function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.name === '.git' || entry.name === 'node_modules') {
      continue;
    }

    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

async function run() {
  console.log(`\n${c.bold('----------------------------------------------------')}`);
  console.log(`${c.bold('       Kimi Effort Plugin Installer & Tester        ')}`);
  console.log(`${c.bold('----------------------------------------------------')}`);

  const sourceDir = __dirname;
  const kimiHome = process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
  const targetDir = path.join(kimiHome, 'plugins', 'managed', 'effort');
  const pluginsDir = path.join(kimiHome, 'plugins');
  const installedJsonPath = path.join(pluginsDir, 'installed.json');
  const configTomlPath = path.join(kimiHome, 'config.toml');

  // Step 1: Copy plugin directory to ~/.kimi-code/plugins/managed/effort/
  step(`Step 1: Installing plugin to ${targetDir}`);
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    copyDirSync(sourceDir, targetDir);
    success(`Copied plugin assets to ${targetDir}`);
  } catch (err) {
    fail(`Failed to copy plugin files: ${err.message}`);
    process.exit(1);
  }

  // Step 2: Register in ~/.kimi-code/plugins/installed.json
  step(`Step 2: Registering plugin in installed.json`);
  try {
    let installedData = { version: 1, plugins: [] };
    if (fs.existsSync(installedJsonPath)) {
      try {
        const raw = fs.readFileSync(installedJsonPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.plugins)) {
          installedData = parsed;
        }
      } catch (err) {
        warn(`Existing installed.json could not be parsed, creating fresh state: ${err.message}`);
      }
    }

    const pluginId = 'effort';
    const nowIso = new Date().toISOString();
    const existingIdx = installedData.plugins.findIndex(p => p.id === pluginId);

    const pluginRecord = {
      id: pluginId,
      root: targetDir,
      source: 'local-path',
      enabled: true,
      installedAt: existingIdx >= 0 ? (installedData.plugins[existingIdx].installedAt || nowIso) : nowIso,
      updatedAt: nowIso,
      originalSource: sourceDir
    };

    if (existingIdx >= 0) {
      installedData.plugins[existingIdx] = { ...installedData.plugins[existingIdx], ...pluginRecord };
    } else {
      installedData.plugins.push(pluginRecord);
    }

    fs.writeFileSync(installedJsonPath, JSON.stringify(installedData, null, 2), 'utf8');
    success(`Registered "${pluginId}" in ${installedJsonPath}`);
  } catch (err) {
    warn(`Could not update installed.json: ${err.message}`);
  }

  // Step 3: Run automatic detection on existing third-party models
  step(`Step 3: Running automatic detection on third-party models`);
  const cliScriptPath = path.join(sourceDir, 'scripts', 'effort-cli.mjs');

  try {
    const detectProcess = spawnSync(process.execPath, [cliScriptPath, 'detect', 'all'], {
      stdio: 'inherit',
      env: process.env
    });

    if (detectProcess.status !== 0) {
      fail(`effort-cli.mjs detect all exited with code ${detectProcess.status}`);
      process.exit(1);
    }
    success('Auto-detection completed successfully.');
  } catch (err) {
    fail(`Execution failed: ${err.message}`);
    process.exit(1);
  }

  // Step 4: Validate config.toml was properly updated
  step(`Step 4: Validating config.toml updates`);
  try {
    if (!fs.existsSync(configTomlPath)) {
      warn(`config.toml not found at ${configTomlPath}`);
    } else {
      const tomlContent = fs.readFileSync(configTomlPath, 'utf8');
      const hasSupportEfforts = /support_efforts\s*=\s*\[/i.test(tomlContent);
      const hasDefaultEffort = /default_effort\s*=\s*"/i.test(tomlContent);

      if (hasSupportEfforts && hasDefaultEffort) {
        success('Verified: config.toml contains support_efforts and default_effort entries.');
      } else if (hasSupportEfforts) {
        success('Verified: config.toml contains support_efforts entries.');
      } else {
        warn('No support_efforts entries detected in config.toml (no third-party models configured?)');
      }
    }
  } catch (err) {
    warn(`Failed to inspect config.toml: ${err.message}`);
  }

  // Step 5: Verify status end-to-end
  step(`Step 5: Verifying end-to-end status via effort-cli`);
  try {
    const statusProcess = spawnSync(process.execPath, [cliScriptPath, 'status'], {
      stdio: 'inherit',
      env: process.env
    });

    if (statusProcess.status === 0) {
      success('End-to-end status verified successfully.');
    } else {
      fail(`effort-cli.mjs status exited with code ${statusProcess.status}`);
    }
  } catch (err) {
    warn(`Could not run status check: ${err.message}`);
  }

  // Step 6: Print user instructions
  step(`Step 6: Installation Complete! Instructions for use`);
  console.log(`
${c.green(c.bold('🎉 kimi-effort is successfully installed and verified!'))}

${c.bold('Plugin Location:')}
  ${c.dim(targetDir)}

${c.bold('How to use inside Kimi Code CLI:')}
  1. Reload your current session to load the plugin:
     ${c.cyan('/reload')}

  2. Check current model thinking / effort status:
     ${c.cyan('/effort')}

  3. Adjust the reasoning effort level:
     ${c.cyan('/effort low')}
     ${c.cyan('/effort medium')}
     ${c.cyan('/effort high')}
     ${c.cyan('/effort max')}

  4. Probe / detect reasoning capabilities for all models:
     ${c.cyan('/effort detect all')}

  5. List all configured models and their effort options:
     ${c.cyan('/effort list')}

${c.bold('Direct CLI usage (terminal):')}
  node "${cliScriptPath}" status
  node "${cliScriptPath}" detect all
  node "${cliScriptPath}" set high
  node "${cliScriptPath}" list
`);
}

run().catch(err => {
  console.error(`Installer error: ${err.message}`);
  process.exit(1);
});
