require('dotenv').config();
const path = require('path');

const env = process.env;

module.exports = {
  port: Number(env.PORT || 3000),
  databasePath: env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'carecloud.db'),
  seedData: env.SEED_DATA !== 'false',
  // Shown on the dashboard so staff know which number to call.
  publicPhoneNumber: env.PUBLIC_PHONE_NUMBER || '',

  vapi: {
    // Shared secret Vapi sends as "Authorization: Bearer <secret>" (set it as the Custom LLM
    // API key and the Server URL secret in the Vapi dashboard). Empty = no auth check.
    secret: env.VAPI_SECRET || ''
  },

  // Any OpenAI-compatible chat completions endpoint works. Defaults target Groq's
  // free tier; see README for Gemini / OpenRouter / Ollama alternatives.
  llm: {
    baseUrl: (env.LLM_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, ''),
    apiKey: env.LLM_API_KEY || env.GROQ_API_KEY || '',
    model: env.LLM_MODEL || 'openai/gpt-oss-120b',
    // Tried in order when the primary model is rate-limited or down (each has its own free quota).
    fallbackModels: (env.LLM_FALLBACK_MODELS ?? 'openai/gpt-oss-20b').split(',').map(m => m.trim()).filter(Boolean),
    timeoutMs: Number(env.LLM_TIMEOUT_MS || 7000),
    // Only sent when set (Groq gpt-oss supports low/medium/high; other providers may reject it).
    reasoningEffort: env.LLM_REASONING_EFFORT || ''
  }
};
