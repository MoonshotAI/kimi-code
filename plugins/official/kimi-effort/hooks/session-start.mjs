#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helper to safely import sibling scripts across platforms (Windows, Linux, macOS)
async function importModules() {
  const configManagerPath = path.resolve(__dirname, '../scripts/config-manager.mjs');
  const effortDetectorPath = path.resolve(__dirname, '../scripts/effort-detector.mjs');

  let configManager = null;
  let effortDetector = null;

  if (fs.existsSync(configManagerPath)) {
    try {
      configManager = await import(pathToFileURL(configManagerPath).href);
    } catch {
      // fail-open
    }
  }

  if (fs.existsSync(effortDetectorPath)) {
    try {
      effortDetector = await import(pathToFileURL(effortDetectorPath).href);
    } catch {
      // fail-open
    }
  }

  return { configManager, effortDetector };
}

// Timeout helper with unref to avoid keeping the event loop alive
function timeoutPromise(ms) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    if (timer.unref) timer.unref();
  });
}

// Read stdin event data safely with a short timeout (session_id, etc.)
async function readStdin(timeoutMs = 250) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve(null);
      return;
    }

    let input = '';
    const timer = setTimeout(() => {
      try { process.stdin.pause(); } catch {}
      resolve(null);
    }, timeoutMs);
    if (timer.unref) timer.unref();

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      input += chunk;
    });

    process.stdin.on('end', () => {
      clearTimeout(timer);
      try {
        resolve(input.trim() ? JSON.parse(input) : null);
      } catch {
        resolve(null);
      }
    });

    process.stdin.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

async function main() {
  // Budget maximum 2.4s total so the hook always finishes well under 3 seconds
  const maxTotalBudgetMs = 2400;
  const startTime = Date.now();

  try {
    // 1. Read stdin event data (session_id, etc.) if piped
    const stdinData = await Promise.race([
      readStdin(250),
      timeoutPromise(300).then(() => null)
    ]);

    // 2. Load config-manager and effort-detector modules
    const { configManager, effortDetector } = await importModules();

    if (!configManager) {
      return;
    }

    // 3. Check current active model in ~/.kimi-code/config.toml
    const currentModelInfo = configManager.getCurrentModelInfo();
    if (!currentModelInfo || !currentModelInfo.activeModelAlias) {
      return;
    }

    const {
      activeModelAlias,
      modelName,
      modelConfig,
      providerConfig,
      supportedEfforts
    } = currentModelInfo;

    // Check if support_efforts is already configured and has elements
    const hasConfiguredEfforts = Array.isArray(supportedEfforts) && supportedEfforts.length > 0;

    if (hasConfiguredEfforts) {
      // Already configured, nothing to do
      return;
    }

    // If detector is not available, fail-open
    if (!effortDetector || !effortDetector.detectModelEffort) {
      return;
    }

    // Calculate remaining time budget for detection probe
    const elapsed = Date.now() - startTime;
    const remainingBudget = Math.max(400, maxTotalBudgetMs - elapsed);
    const probeTimeout = Math.min(1000, remainingBudget - 200);

    // 4. Run automatic detection using effort-detector.mjs
    // We pass probeTimeout and timeout options
    const detectPromise = effortDetector.detectModelEffort(
      providerConfig,
      modelName,
      modelConfig,
      {
        timeout: probeTimeout,
        probeTimeout: probeTimeout
      }
    );

    const result = await Promise.race([
      detectPromise,
      timeoutPromise(remainingBudget).then(() => null)
    ]);

    if (result) {
      const detectedSupported = result.supportedEfforts || [];
      const detectedDefault = result.defaultEffort || (detectedSupported[0] || 'medium');

      // Update config.toml with detected support_efforts and default_effort
      if (typeof configManager.saveModelEffort === 'function') {
        configManager.saveModelEffort(activeModelAlias, detectedSupported, detectedDefault);
      }

      // Print informative status so Kimi Code can log or display it
      if (detectedSupported.length > 0) {
        console.log(
          `[kimi-effort] Detected reasoning capabilities for "${activeModelAlias}": ` +
          `efforts=[${detectedSupported.join(', ')}], default="${detectedDefault}" ` +
          `(method: ${result.detectionMethod || 'heuristic'})`
        );
      } else {
        console.log(`[kimi-effort] Detected "${activeModelAlias}" as standard non-reasoning model.`);
      }
    }
  } catch {
    // Fail-open: never crash or block session start
  }
}

// Fail-open execution with clean exit code 0
await main();
process.exitCode = 0;
