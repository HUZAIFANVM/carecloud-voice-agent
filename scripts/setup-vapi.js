#!/usr/bin/env node
/**
 * One-command Vapi setup: creates (or updates) the "Ava" assistant pointing at this
 * server as its Custom LLM, then attaches a free Vapi US phone number to it.
 *
 *   npm run setup:vapi                       # uses PUBLIC_BASE_URL from .env
 *   npm run setup:vapi -- https://abc.trycloudflare.com
 *
 * Re-run it whenever your public URL changes (quick tunnels get a new URL each start);
 * it updates the same assistant and number instead of creating new ones.
 * Needs VAPI_API_KEY (Vapi dashboard -> Organization -> API Keys -> *private* key).
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { text } = require('../src/agent/speech');

const API = 'https://api.vapi.ai';
const STATE_FILE = path.join(__dirname, '..', 'data', 'vapi.json');

const apiKey = process.env.VAPI_API_KEY;
const secret = process.env.VAPI_SECRET;
const baseUrl = (process.argv[2] || process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');

function fail(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}
if (!apiKey) fail('VAPI_API_KEY is missing in .env (use the PRIVATE key from the Vapi dashboard).');
if (!secret || secret.startsWith('change-me')) fail('Set VAPI_SECRET in .env to a long random string.');
if (!/^https:\/\//.test(baseUrl)) fail('Pass your public HTTPS URL (e.g. from `npm run tunnel`) as an argument or set PUBLIC_BASE_URL.');

async function vapi(method, route, body) {
  const response = await fetch(API + route, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const raw = await response.text();
  const data = raw ? JSON.parse(raw) : null;
  if (!response.ok) {
    const error = new Error(`${method} ${route} -> HTTP ${response.status}: ${raw.slice(0, 500)}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

const loadState = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } };
const saveState = state => { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); };

function assistantBody({ withSpeechOptions }) {
  const body = {
    name: 'CareCloud Intake - Ava',
    firstMessage: text('en').greeting, // must match the server's greeting (it is stored in the transcript)
    model: {
      provider: 'custom-llm',
      url: `${baseUrl}/vapi/k/${secret}`, // Vapi appends /chat/completions
      model: 'carecloud-intake-agent'
    },
    // Our closing lines end with these words; Vapi hangs up after speaking them.
    endCallPhrases: ['Goodbye', 'Adiós'],
    server: { url: `${baseUrl}/vapi/k/${secret}/webhook` },
    serverMessages: ['end-of-call-report'],
    silenceTimeoutSeconds: 30,
    maxDurationSeconds: 900
  };
  if (withSpeechOptions) {
    // Multilingual transcription so "hablo español" works; voice is optional.
    body.transcriber = { provider: 'deepgram', model: process.env.VAPI_TRANSCRIBER_MODEL || 'nova-3', language: 'multi' };
    if (process.env.VAPI_VOICE_ID) body.voice = { provider: process.env.VAPI_VOICE_PROVIDER || 'vapi', voiceId: process.env.VAPI_VOICE_ID };
  }
  return body;
}

async function upsertAssistant(state) {
  const save = async body => (state.assistantId
    ? vapi('PATCH', `/assistant/${state.assistantId}`, body)
    : vapi('POST', '/assistant', body));
  try {
    return await save(assistantBody({ withSpeechOptions: true }));
  } catch (error) {
    if (error.status === 404 && state.assistantId) { delete state.assistantId; return upsertAssistant(state); }
    if (error.status !== 400) throw error;
    console.warn(`! Vapi rejected the transcriber/voice options, retrying with Vapi defaults.\n  ${error.message}`);
    return save(assistantBody({ withSpeechOptions: false }));
  }
}

async function attachPhoneNumber(state, assistantId) {
  if (state.phoneNumberId) {
    try { return await vapi('PATCH', `/phone-number/${state.phoneNumberId}`, { assistantId }); } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
  const existing = (await vapi('GET', '/phone-number')) || [];
  const free = existing.find(n => n.provider === 'vapi');
  if (free) return vapi('PATCH', `/phone-number/${free.id}`, { assistantId });
  // Vapi requires an area code; free inventory varies, so try a few common ones.
  const areaCodes = process.env.VAPI_AREA_CODE ? [process.env.VAPI_AREA_CODE] : ['415', '628', '650', '312', '646', '213', '512', '737', '206', '303'];
  let lastError;
  for (const numberDesiredAreaCode of areaCodes) {
    try {
      return await vapi('POST', '/phone-number', { provider: 'vapi', assistantId, name: 'CareCloud Intake', numberDesiredAreaCode });
    } catch (error) {
      lastError = error;
      if (error.status !== 400) throw error;
      console.warn(`! Area code ${numberDesiredAreaCode} unavailable: ${error.message.slice(0, 160)}`);
    }
  }
  throw lastError;
}

(async () => {
  const state = loadState();
  const health = await fetch(`${baseUrl}/health`).then(r => r.json()).catch(() => null);
  if (!health?.data?.status) console.warn(`! ${baseUrl}/health is not reachable. Start the server and tunnel first, or Vapi calls will fail.`);
  else console.log(`✔ Server reachable at ${baseUrl} (LLM: ${health.data.llm})`);

  const assistant = await upsertAssistant(state);
  state.assistantId = assistant.id;
  saveState(state);
  console.log(`✔ Assistant ready: ${assistant.id}`);

  const phone = await attachPhoneNumber(state, assistant.id);
  state.phoneNumberId = phone.id;
  state.phoneNumber = phone.number || phone.sipUri || null;
  saveState(state);
  console.log(`✔ Phone number ${state.phoneNumber || '(being provisioned, check the Vapi dashboard)'} -> assistant`);
  if (phone.status && phone.status !== 'active') console.log(`  Number status: ${phone.status} (free numbers can take a few minutes to activate)`);
  console.log(`\nCall it now. Dashboard: ${baseUrl}/   API: ${baseUrl}/patients\n`);
})().catch(error => fail(error.message));
