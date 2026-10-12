/**
 * Minimal client for any OpenAI-compatible /chat/completions endpoint (Groq, Gemini's
 * OpenAI endpoint, OpenRouter, Ollama, OpenAI). Uses global fetch — no SDK dependency.
 *
 * Free tiers have tight per-model rate limits (Groq: ~8k tokens/minute), so on a 429,
 * 5xx or timeout we try the next model in the chain (each model has its own quota),
 * and if everything is rate-limited we wait briefly once. Throws if all attempts fail;
 * the agent then falls back to its scripted flow.
 */
const MAX_RATE_LIMIT_WAIT_MS = 3000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class LlmError extends Error {
  constructor(message, { status = null, retryAfterMs = null } = {}) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function createLlmClient({ baseUrl, apiKey, model, fallbackModels = [], timeoutMs, reasoningEffort }) {
  const enabled = Boolean(apiKey) || /localhost|127\.0\.0\.1/.test(baseUrl);
  const models = [model, ...fallbackModels.filter(m => m && m !== model)];

  async function request(modelName, messages) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({
          model: modelName, messages, temperature: 0.3, max_tokens: 1200, response_format: { type: 'json_object' },
          ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {})
        }),
        signal: controller.signal
      });
      if (!response.ok) {
        const retryAfter = Number(response.headers.get('retry-after'));
        throw new LlmError(`LLM HTTP ${response.status} (${modelName}): ${(await response.text()).slice(0, 200)}`, {
          status: response.status, retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null
        });
      }
      const body = await response.json();
      const content = body.choices?.[0]?.message?.content || '';
      // Some models wrap JSON in prose or code fences despite json mode; take the outermost object.
      const match = content.match(/\{[\s\S]*\}/);
      if (!match) throw new LlmError(`LLM returned non-JSON content (${modelName}): ${content.slice(0, 200)}`);
      return JSON.parse(match[0]);
    } catch (error) {
      if (error.name === 'AbortError') throw new LlmError(`LLM timeout after ${timeoutMs}ms (${modelName})`, { status: 408 });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  const retryable = error => error instanceof LlmError && (error.status === 429 || error.status === 408 || error.status >= 500 || error.status === null);

  async function completeJson(messages) {
    let lastError;
    for (const modelName of models) {
      try {
        return await request(modelName, messages);
      } catch (error) {
        lastError = error;
        if (!retryable(error)) throw error;
      }
    }
    if (lastError?.status === 429) {
      await sleep(Math.min(lastError.retryAfterMs || 1500, MAX_RATE_LIMIT_WAIT_MS));
      return request(models[0], messages);
    }
    throw lastError;
  }

  return { enabled, model, completeJson };
}

module.exports = { createLlmClient };
