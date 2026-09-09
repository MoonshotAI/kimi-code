/**
 * effort-detector.mjs
 * Core detection module for reasoning/thinking capabilities in third-party LLM providers.
 *
 * Supports:
 * 1. Active Probing / Live Capability Probe (OpenAI, Anthropic, Google-GenAI)
 * 2. Provider Metadata Inspection (e.g. OpenRouter /v1/models supported_parameters)
 * 3. Intelligent Heuristics Sniffing (when network is unavailable or probe is inconclusive)
 */

/**
 * Standard effort levels:
 * - OpenAI-style: ["low", "medium", "high"]
 * - Extended / Anthropic-style: ["low", "medium", "high", "max"]
 * - Binary / Simple: ["low", "high"]
 * - Fixed / R1-style: ["default", "high"]
 */

/**
 * Normalizes a base URL to strip trailing slashes.
 */
function normalizeBaseUrl(url) {
  if (!url) return '';
  return url.trim().replace(/\/+$/, '');
}

/**
 * Create a timeout signal for fetch requests.
 */
function createTimeoutSignal(timeoutMs = 5000) {
  return AbortSignal.timeout(timeoutMs);
}

/**
 * Intelligent Heuristics Sniffing based on model identifier patterns.
 *
 * @param {string} modelName - e.g. "gpt-5.6-sol", "claude-3-7-sonnet", "deepseek-r1"
 * @returns {{ isReasoningModel: boolean, supportedEfforts: string[], defaultEffort: string, details: string }}
 */
export function detectByHeuristics(modelName) {
  if (!modelName || typeof modelName !== 'string') {
    return {
      isReasoningModel: false,
      supportedEfforts: [],
      defaultEffort: '',
      detectionMethod: 'heuristic',
      details: 'Empty or invalid model name.'
    };
  }

  const lower = modelName.toLowerCase();

  // Explicit non-reasoning models / exclusions
  // Check these first to avoid false positives (e.g., claude-3-5-haiku vs claude-3-7)
  const nonReasoningPatterns = [
    /gpt-4o(?:-mini|-20\d{2}-\d{2}-\d{2})?(?:$|[^a-z0-9])/i,
    /gpt-4-turbo/i,
    /gpt-3\.5/i,
    /claude-3-5-(?:haiku|sonnet)/i,
    /claude-3-(?:opus|haiku|sonnet)/i,
    /gemini-1\.5-(?:flash|pro)/i,
    /gemini-1\.0/i,
    /llama-3/i,
    /mistral/i,
    /qwen-2\.5-coder/i
  ];

  // Specific check: if it matches non-reasoning pattern and not an override reasoning pattern
  // E.g. "claude-3-5-sonnet" vs "claude-3-7-sonnet"
  for (const pattern of nonReasoningPatterns) {
    if (pattern.test(lower) && !lower.includes('thinking') && !lower.includes('reasoning') && !lower.includes('r1')) {
      return {
        isReasoningModel: false,
        supportedEfforts: [],
        defaultEffort: '',
        detectionMethod: 'heuristic',
        details: `Heuristics identified non-reasoning model pattern (${modelName}).`
      };
    }
  }

  // 1. OpenAI-style reasoning models:
  // o1, o1-mini, o1-preview, o3, o3-mini, o3-pro, gpt-5, gpt-5.6-sol, gpt-6, gpt-6-astra, sol, astra
  const openaiReasoningRegex = /(?:^|[\/_-])(?:o1|o3|o3-mini|o4|gpt-5|gpt-6|sol|astra)(?:$|[\/:-])/i;
  if (openaiReasoningRegex.test(lower) || lower.includes('gpt-5') || lower.includes('gpt-6') || lower.includes('o3-mini') || lower.includes('o1-mini') || lower.includes('o1-preview') || lower.includes('o1-') || lower === 'o1' || lower === 'o3') {
    return {
      isReasoningModel: true,
      supportedEfforts: ['low', 'medium', 'high'],
      defaultEffort: 'medium',
      detectionMethod: 'heuristic',
      details: `Heuristics identified OpenAI-style reasoning model (${modelName}).`
    };
  }

  // 2. Anthropic thinking models:
  // claude-3-7, claude-opus-4, claude-4, sonnet (newer), or models with "thinking" and "claude"
  const anthropicThinkingRegex = /claude-3-7|claude-opus-4|claude-4|claude-sonnet-4/i;
  if (anthropicThinkingRegex.test(lower) || (lower.includes('claude') && (lower.includes('opus-4') || lower.includes('3-7') || lower.includes('3.7')))) {
    return {
      isReasoningModel: true,
      supportedEfforts: ['low', 'medium', 'high', 'max'],
      defaultEffort: 'high',
      detectionMethod: 'heuristic',
      details: `Heuristics identified Anthropic thinking model (${modelName}).`
    };
  }

  // 3. Google-GenAI thinking models:
  // gemini-2.0-flash-thinking, gemini-2.5, gemini-3, gemini-3.8
  const googleThinkingRegex = /gemini-2\.0-flash-thinking|gemini-2\.5|gemini-3/i;
  if (googleThinkingRegex.test(lower)) {
    return {
      isReasoningModel: true,
      supportedEfforts: ['low', 'high'],
      defaultEffort: 'high',
      detectionMethod: 'heuristic',
      details: `Heuristics identified Google Gemini thinking model (${modelName}).`
    };
  }

  // 4. DeepSeek R1 / QwQ / other reasoning models:
  // deepseek-r1, r1, qwq, skywork-o1
  const deepseekR1Regex = /deepseek-r1|(?:\b|[\/_-])r1(?:\b|[\/_-])|qwq|reasoner|thinking/i;
  if (deepseekR1Regex.test(lower)) {
    return {
      isReasoningModel: true,
      supportedEfforts: ['default', 'high'],
      defaultEffort: 'high',
      detectionMethod: 'heuristic',
      details: `Heuristics identified DeepSeek-R1/QwQ style reasoning model (${modelName}).`
    };
  }

  // Default fallback: not a reasoning model
  return {
    isReasoningModel: false,
    supportedEfforts: [],
    defaultEffort: '',
    detectionMethod: 'heuristic',
    details: `No reasoning model patterns matched for ${modelName}.`
  };
}

/**
 * Queries provider models metadata (e.g. OpenRouter /v1/models or standard /models)
 * to check if the model lists supported_parameters or reasoning parameters.
 */
export async function probeProviderMetadata(providerConfig, modelName, options = {}) {
  const timeoutMs = options.timeout || 5000;
  const baseUrl = normalizeBaseUrl(providerConfig?.base_url);
  const apiKey = providerConfig?.api_key || '';

  if (!baseUrl) {
    return null;
  }

  // Try standard /models or /v1/models endpoint
  // If baseUrl already ends with /v1, we query /models. If not, try /models or /v1/models
  const endpoints = [];
  if (baseUrl.endsWith('/v1')) {
    endpoints.push(`${baseUrl}/models`);
  } else {
    endpoints.push(`${baseUrl}/v1/models`, `${baseUrl}/models`);
  }

  for (const url of endpoints) {
    try {
      const headers = {
        'Accept': 'application/json'
      };
      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }

      const res = await fetch(url, {
        method: 'GET',
        headers,
        signal: createTimeoutSignal(timeoutMs)
      });

      if (!res.ok) {
        continue;
      }

      const data = await res.json();
      if (!data || (!Array.isArray(data.data) && !Array.isArray(data))) {
        continue;
      }

      const modelsList = Array.isArray(data.data) ? data.data : data;
      // Search for model matching modelName or model
      const target = modelsList.find(m => {
        const id = m.id || m.name;
        if (!id) return false;
        return id === modelName || id.toLowerCase() === modelName.toLowerCase() || id.endsWith('/' + modelName);
      });

      if (target) {
        // OpenRouter or compatible metadata: target.supported_parameters
        if (Array.isArray(target.supported_parameters)) {
          const hasReasoningEffort = target.supported_parameters.includes('reasoning_effort');
          const hasIncludeReasoning = target.supported_parameters.includes('include_reasoning');
          const hasThinking = target.supported_parameters.includes('thinking');

          if (hasReasoningEffort) {
            return {
              isReasoningModel: true,
              supportedEfforts: ['low', 'medium', 'high'],
              defaultEffort: 'medium',
              detectionMethod: 'metadata',
              details: `Provider metadata declared supported_parameters including 'reasoning_effort'.`
            };
          }

          if (hasThinking) {
            return {
              isReasoningModel: true,
              supportedEfforts: ['low', 'medium', 'high', 'max'],
              defaultEffort: 'high',
              detectionMethod: 'metadata',
              details: `Provider metadata declared supported_parameters including 'thinking'.`
            };
          }

          if (hasIncludeReasoning) {
            return {
              isReasoningModel: true,
              supportedEfforts: ['default', 'high'],
              defaultEffort: 'high',
              detectionMethod: 'metadata',
              details: `Provider metadata declared supported_parameters including 'include_reasoning'.`
            };
          }
        }

        // Check for reasoning or thinking in architecture / description / capabilities
        const desc = JSON.stringify(target).toLowerCase();
        if (desc.includes('reasoning') || desc.includes('thinking')) {
          // Cross-verify with heuristics
          const h = detectByHeuristics(modelName);
          if (h.isReasoningModel) {
            return {
              ...h,
              detectionMethod: 'metadata',
              details: `Provider model metadata mentions reasoning/thinking capabilities.`
            };
          }
        }
      }
    } catch {
      // Ignore network errors or timeouts during metadata probe
    }
  }

  return null;
}

/**
 * Live Capability Probe for OpenAI-compatible providers.
 * Sends a minimal request with reasoning_effort to see if accepted or rejected.
 */
async function probeOpenAI(baseUrl, apiKey, targetModel, timeoutMs) {
  // If baseUrl already ends with /v1, append /chat/completions; otherwise /v1/chat/completions or /chat/completions
  let chatUrl = `${baseUrl}/chat/completions`;
  if (!baseUrl.endsWith('/v1') && !baseUrl.includes('/v1/')) {
    chatUrl = `${baseUrl}/v1/chat/completions`;
  }

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': apiKey ? `Bearer ${apiKey}` : ''
  };

  // Test 1: Probe with reasoning_effort: "low"
  try {
    const probeBody = {
      model: targetModel,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1,
      reasoning_effort: 'low'
    };

    const res = await fetch(chatUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(probeBody),
      signal: createTimeoutSignal(timeoutMs)
    });

    if (res.ok) {
      // 200 OK with reasoning_effort accepted!
      return {
        isReasoningModel: true,
        supportedEfforts: ['low', 'medium', 'high'],
        defaultEffort: 'medium',
        detectionMethod: 'probe',
        details: 'API probe succeeded: accepted reasoning_effort parameter ("low", "medium", "high").'
      };
    }

    const errText = await res.text();

    // If HTTP 400 or error indicates invalid/unknown parameter "reasoning_effort"
    if (res.status === 400) {
      if (
        errText.includes('reasoning_effort') ||
        errText.includes('unsupported parameter') ||
        errText.includes('extra fields not permitted') ||
        errText.includes('Unknown parameter')
      ) {
        // Explicitly rejected reasoning_effort
        return {
          isReasoningModel: false,
          supportedEfforts: [],
          defaultEffort: '',
          detectionMethod: 'probe',
          details: `API rejected reasoning_effort with 400: ${errText.slice(0, 150)}`
        };
      }
    }

    // If error is about model not found, rate limit, quota, or auth, probe is inconclusive
    return null;
  } catch {
    // Network error or timeout, probe is inconclusive
    return null;
  }
}

/**
 * Live Capability Probe for Anthropic-compatible providers.
 * Tests thinking parameter { type: "enabled", budget_tokens: 1024 }.
 */
async function probeAnthropic(baseUrl, apiKey, targetModel, timeoutMs) {
  let messagesUrl = `${baseUrl}/messages`;
  if (baseUrl.endsWith('/v1')) {
    messagesUrl = `${baseUrl}/messages`;
  } else if (!baseUrl.includes('/v1')) {
    messagesUrl = `${baseUrl}/v1/messages`;
  }

  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01'
  };

  // Test thinking parameter
  try {
    const probeBody = {
      model: targetModel,
      max_tokens: 2048,
      thinking: {
        type: 'enabled',
        budget_tokens: 1024
      },
      messages: [{ role: 'user', content: 'hi' }]
    };

    const res = await fetch(messagesUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(probeBody),
      signal: createTimeoutSignal(timeoutMs)
    });

    if (res.ok) {
      return {
        isReasoningModel: true,
        supportedEfforts: ['low', 'medium', 'high', 'max'],
        defaultEffort: 'high',
        detectionMethod: 'probe',
        details: 'API probe succeeded: accepted Anthropic thinking budget parameters.'
      };
    }

    const errText = await res.text();
    if (res.status === 400) {
      if (
        errText.includes('thinking') ||
        errText.includes('budget_tokens') ||
        errText.includes('extra fields not permitted')
      ) {
        return {
          isReasoningModel: false,
          supportedEfforts: [],
          defaultEffort: '',
          detectionMethod: 'probe',
          details: `Anthropic API rejected thinking parameter with 400: ${errText.slice(0, 150)}`
        };
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Live Capability Probe for Google-GenAI providers.
 * Tests thinkingConfig (thinking_budget).
 */
async function probeGoogleGenAI(baseUrl, apiKey, targetModel, timeoutMs) {
  // Google GenAI REST: e.g. /v1beta/models/{model}:generateContent?key={apiKey}
  const url = `${baseUrl}/v1beta/models/${encodeURIComponent(targetModel)}:generateContent?key=${apiKey}`;

  try {
    const probeBody = {
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      generationConfig: {
        thinkingConfig: {
          thinkingBudget: 1024
        }
      }
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(probeBody),
      signal: createTimeoutSignal(timeoutMs)
    });

    if (res.ok) {
      return {
        isReasoningModel: true,
        supportedEfforts: ['low', 'high'],
        defaultEffort: 'high',
        detectionMethod: 'probe',
        details: 'API probe succeeded: accepted Google GenAI thinkingConfig parameter.'
      };
    }

    const errText = await res.text();
    if (res.status === 400 && (errText.includes('thinkingConfig') || errText.includes('thinkingBudget'))) {
      return {
        isReasoningModel: false,
        supportedEfforts: [],
        defaultEffort: '',
        detectionMethod: 'probe',
        details: `Google GenAI API rejected thinkingConfig with 400: ${errText.slice(0, 150)}`
      };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Performs active live capability probing on the provider/model.
 */
export async function probeModelEffort(providerConfig, targetModel, options = {}) {
  const timeoutMs = options.timeout || 5000;
  const providerType = (providerConfig?.type || 'openai').toLowerCase();
  const baseUrl = normalizeBaseUrl(providerConfig?.base_url);
  const apiKey = providerConfig?.api_key || '';

  if (!baseUrl) {
    return null;
  }

  if (providerType === 'openai') {
    return await probeOpenAI(baseUrl, apiKey, targetModel, timeoutMs);
  } else if (providerType === 'anthropic') {
    return await probeAnthropic(baseUrl, apiKey, targetModel, timeoutMs);
  } else if (providerType === 'google-genai') {
    return await probeGoogleGenAI(baseUrl, apiKey, targetModel, timeoutMs);
  }

  return null;
}

/**
 * Main detection function to inspect a provider and model.
 *
 * Steps:
 * 1. If options.skipProbe is not true, attempt Active Probing with minimal request.
 * 2. Attempt Provider Metadata inspection (/models, OpenRouter supported_parameters).
 * 3. Fallback to Intelligent Heuristics Sniffing (model identifier patterns).
 *
 * @param {object} providerConfig - Provider configuration from config.toml (type, base_url, api_key)
 * @param {string} modelName - Model name or identifier, e.g. "gpt-5.6-sol"
 * @param {object} modelConfig - Model configuration from config.toml (optional)
 * @param {object} options - Options { timeout?: number, skipProbe?: boolean, forceHeuristics?: boolean }
 * @returns {Promise<{ isReasoningModel: boolean, supportedEfforts: string[], defaultEffort: string, detectionMethod: "probe"|"metadata"|"heuristic", details: string }>}
 */
export async function detectModelEffort(providerConfig, modelName, modelConfig = {}, options = {}) {
  const actualModelName = modelConfig?.model || modelName;

  // If forceHeuristics requested
  if (options.forceHeuristics) {
    return detectByHeuristics(actualModelName);
  }

  // 1. Active Probing / Live Capability Probe
  if (!options.skipProbe && providerConfig && providerConfig.base_url) {
    try {
      const probeResult = await probeModelEffort(providerConfig, actualModelName, options);
      if (probeResult) {
        return probeResult;
      }
    } catch {
      // Inconclusive probe, proceed to metadata/heuristics
    }

    // 2. Query metadata endpoint (/models, OpenRouter supported_parameters)
    try {
      const metaResult = await probeProviderMetadata(providerConfig, actualModelName, options);
      if (metaResult) {
        return metaResult;
      }
    } catch {
      // Inconclusive metadata, proceed to heuristics
    }
  }

  // 3. Intelligent Heuristics Sniffing
  return detectByHeuristics(actualModelName);
}

export default {
  detectModelEffort,
  detectByHeuristics,
  probeProviderMetadata,
  probeModelEffort
};
