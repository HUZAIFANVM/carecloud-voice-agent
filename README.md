

A multilingual (English / Urdu / Spanish) phone-based AI agent ("Huzaifa") that registers new U.S. patients through natural conversation, saves them to a persistent database, and exposes the records through a REST API and a small dashboard. Everything is built on free tiers.

| | |
|---|---|
| **Phone number** | **+1 (628) 215-9106** |
| **API base URL** | https://carecloud-api-production-0606.up.railway.app |
| **Dashboard** | https://carecloud-api-production-0606.up.railway.app/ |
| **Try it** | `curl https://carecloud-api-production-0606.up.railway.app/patients` |

## Architecture

```
 Caller ──phone──▶ Vapi (free US number, speech-to-text, text-to-speech)
                     │  POST /vapi/k/<secret>/chat/completions   (Custom LLM, every caller turn)
                     │  POST /vapi/k/<secret>/webhook            (end-of-call report)
                     ▼
 ┌──────────────────────── Node.js / Express (this repo) ────────────────────────┐
 │ telephony/vapiRoutes.js     Vapi adapter: OpenAI-style SSE in/out, auth        │
 │ services/conversationService.js   call lifecycle, silence, transcripts         │
 │ agent/agent.js              brain: LLM turn → validate → read-back → save      │
 │   agent/prompt.js           documented system prompt                            │
 │   agent/llm.js              OpenAI-compatible client (Groq), model fallback    │
 │   agent/speech.js           server-generated read-back & fixed phrases (en/es) │
 │   agent/scripted.js         no-LLM fallback flow (call never goes silent)      │
 │ services/patientService.js  single data layer used by API *and* agent          │
 │ routes/patients.js          REST API          routes/calls.js  transcripts+sim │
 │ validation.js (zod)  ──▶  db.js (SQLite with CHECK constraints)                │
 └─────────────────────────────────────────────────────────────────────────────────┘
```

**Key design decision: the LLM interprets, the server decides.** On each turn the model returns structured JSON (`updates`, `intent`, `reply`). The server then:

1. validates every field update with the same zod schema the REST API uses, rejecting bad values and having the agent re-prompt for that specific field;
2. checks the phone number against existing patients (returning-caller detection);
3. generates the read-back text itself, so the caller confirms exactly what will be stored;
4. writes to the database only after a confirmed read-back, and reports the real outcome (success or a graceful error) to the caller.

A hallucinated "you're all set" can never reach a caller unless the write actually happened.

## Tech stack (and why)

| Layer | Choice | Why |
|---|---|---|
| Telephony + STT/TTS | **Vapi** (Custom LLM mode) | Free US numbers and trial credit, no phone verification. Handles barge-in/interruptions, endpointing and voices, while our server keeps full control of the logic. |
| LLM | **Groq** `openai/gpt-oss-120b`, fallback `gpt-oss-20b` | Free tier, ~0.5–1 s per turn (important on a phone line), JSON mode. Any OpenAI-compatible endpoint works (Gemini, OpenRouter, Ollama) through env vars. |
| Backend | Node.js 22 + Express | Small, familiar, one process. |
| Database | SQLite via built-in `node:sqlite` | No native module to compile, survives restarts on a Railway volume, schema enforced with CHECK constraints. |
| Validation | zod | One schema shared by the API and the voice agent. |
| Hosting | Railway + volume | Always-on Node process with a persistent disk (Vercel's serverless functions have no persistent filesystem for SQLite). |

## Features

- Natural conversation: out-of-order answers, several fields in one sentence, spelled names ("Q-U-R-E-S-H-I"), spoken dates and emails.
- Validation with field-specific re-prompts (future DOB, 7-digit phone, bad ZIP or state, and so on).
- Server-generated read-back before saving. Corrections during confirmation read back only the changed field.
- Optional fields are offered once, after the required fields (insurance, emergency contact, language, email).
- **Bonus: duplicate detection.** A phone number that matches an existing patient prompts: "It looks like we already have a record for Ayesha Khan. Would you like to update your information instead?"
- **Bonus: multilingual (English by default, Urdu, Spanish).** The agent detects the caller's language on every turn and answers in it: Urdu (Urdu script, Roman Urdu, or Hindi-script transcripts), Spanish ("hablo español"), or English. The read-back and fixed phrases are localized, and stored values stay in standard English formats. On the phone, Deepgram `multi` transcribes and an OpenAI voice (`onyx`) speaks all three languages.
- **Bonus: transcripts.** Every call's transcript and state are stored in the `calls` table and linked to the patient (`GET /calls`).
- **Bonus: dashboard.** `/` shows patients and call transcripts, plus a browser test chat (typed, or voice in Chrome) using the same agent.
- **Bonus: automated tests.** 23 tests covering the API, agent flows, failure modes and the Vapi protocol (`npm test`).
- Resilience: per-call state is persisted in SQLite (a restart mid-call resumes), and a model fallback chain handles rate limits. If no LLM is available, a scripted flow takes over. On a DB write failure the caller is told and offered a retry. Silence gets 3 re-prompts and then a polite hang-up. Dropped calls are marked `abandoned` with the partial data logged. "Start over" works at any point.

## REST API

All responses use the envelope `{ "data": ..., "error": null }`.

| Method | Endpoint | Notes |
|---|---|---|
| GET | `/patients` | Optional `?last_name=` (case-insensitive), `?date_of_birth=MM/DD/YYYY`, `?phone_number=` (any format) |
| GET | `/patients/:id` | 400 if not a UUID, 404 if missing or deleted |
| POST | `/patients` | 201 + `Location` header; 422 with per-field `details` on invalid input; unknown fields are rejected |
| PUT | `/patients/:id` | Partial update; the merged record is re-validated |
| DELETE | `/patients/:id` | Soft delete (`deleted_at`); the row stays in the DB |
| GET | `/calls`, `/calls/:sid` | Call transcripts and state |
| GET | `/health` | Status and active LLM |

```bash
curl -X POST $API/patients -H 'Content-Type: application/json' -d '{
  "first_name":"Ayesha","last_name":"Khan","date_of_birth":"04/12/1985","sex":"Female",
  "phone_number":"(555) 201-3344","address_line_1":"1 Main St","city":"Austin","state":"TX","zip_code":"78701"}'
curl "$API/patients?last_name=doe"
```

Inputs are normalized: phone to 10 digits, state to an uppercase code (full names accepted), email lowercased, blanks to `NULL`, and `preferred_language` defaults to English.

## Setup

### Local

```bash
npm install
cp .env.example .env        # add LLM_API_KEY (free at https://console.groq.com/keys) and a random VAPI_SECRET
npm start                   # http://localhost:3000
npm test
```

Without an LLM key the agent still works using the scripted fallback flow.

### Deploy to Railway

```bash
npm i -g @railway/cli
railway login
railway init                                   # create a project
railway up --detach                            # deploy this folder
railway volume add --mount-path /data          # persistent disk for SQLite
railway variables --set DATABASE_PATH=/data/carecloud.db --set LLM_API_KEY=... --set VAPI_SECRET=... \
  --set LLM_MODEL=openai/gpt-oss-120b --set LLM_FALLBACK_MODELS=openai/gpt-oss-20b --set LLM_REASONING_EFFORT=low
railway domain                                 # gives https://<app>.up.railway.app
```

### Connect the phone number (Vapi)

1. Create a free account at https://dashboard.vapi.ai and copy your **private** API key into `.env` as `VAPI_API_KEY`.
2. Run `npm run setup:vapi -- https://<app>.up.railway.app`

The script creates or updates the assistant (Custom LLM → this server, greeting, `endCallPhrases`, multilingual transcriber, end-of-call webhook) and attaches a free Vapi number. It prints the number. Re-running it updates the same assistant and number.

<details><summary>Manual dashboard setup instead</summary>

Create an assistant with:
- **Model:** provider *Custom LLM*, URL `https://<app>/vapi/k/<VAPI_SECRET>`, model `carecloud-intake-agent`
- **First message:** the greeting from `src/agent/speech.js` (`TEXT.en.greeting`)
- **Transcriber:** Deepgram `nova-3`, language `multi`
- **End call phrases:** `Goodbye`, `Adiós`
- **Server URL:** `https://<app>/vapi/k/<VAPI_SECRET>/webhook`, with server message `end-of-call-report`

Then go to Phone Numbers → create a free Vapi number → assign the assistant.
</details>

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `PORT` | no | Default 3000 (Railway sets it) |
| `DATABASE_PATH` | no | Default `./data/carecloud.db`; use `/data/carecloud.db` on Railway |
| `SEED_DATA` | no | `true` inserts 2 demo patients into an empty DB |
| `LLM_API_KEY` | yes* | Groq (or other provider) key. *Without it the scripted fallback is used |
| `LLM_BASE_URL` / `LLM_MODEL` | no | Any OpenAI-compatible endpoint/model |
| `LLM_FALLBACK_MODELS` | no | Comma-separated models tried on rate limit or outage |
| `LLM_REASONING_EFFORT` | no | `low` for Groq gpt-oss (keeps latency down) |
| `LLM_TIMEOUT_MS` | no | Per-request timeout, default 7000 |
| `VAPI_SECRET` | yes (prod) | Shared secret in the Vapi URLs (also accepted as a Bearer token) |
| `VAPI_API_KEY` | setup only | Used by `npm run setup:vapi`; never needed by the server |
| `PUBLIC_BASE_URL` | setup only | Default URL for `setup:vapi` |

## Prompt engineering

The system prompt lives in [`src/agent/prompt.js`](src/agent/prompt.js), with a header comment explaining each choice:

- **Structured output only.** The JSON shape is `{updates, intent, language, offered_optional, reply}`, so the model never decides on its own whether a record was saved.
- **Full state every turn.** The model sees what has been collected, what is missing, and any server validation notes, so corrections and out-of-order answers are simple overwrites.
- **Phone-friendly speech.** Under ~35 words, one question at a time, no lists or markdown, and every reply ends with the next question.
- **Normalization rules.** Spoken dates to MM/DD/YYYY, spelled letters joined into names, "dot"/"at" turned into emails, state names to codes.
- **Two-pass validation.** When the server rejects a value, a second LLM call receives `server_notes` and asks again for just that field naturally. If that call fails, a fixed sentence is used.
- **Fixed wording where precision matters.** The greeting, read-back, duplicate question and save outcomes are server text (`speech.js`).

## Observability

JSON-lines logs on stdout (`railway logs`). Every turn is logged as `call_turn`. The final collected payload is logged as `registration_completed`, `registration_abandoned` or `registration_failed`. Errors are logged as `llm_error` and `patient_save_failed`. Full transcripts are available at `GET /calls`.

## Known limitations and trade-offs

- **Free-tier rate limits.** Groq allows about 8k tokens/minute per model. The fallback model doubles that, and when both are exhausted the call degrades to the scripted flow instead of failing. A paid tier removes this.
- **Vapi free numbers** have daily call limits and can't call internationally. Vapi credit ($10 trial) pays for its speech services.
- **Two LLM calls on a rejected value** add about 0.5 s on those turns, traded for natural re-prompts.
- **SQLite** means a single instance. That's fine at this scale; switch to Postgres to run multiple replicas.
- **Urdu on the phone:** Deepgram `multi` has no dedicated Urdu model, so spoken Urdu is transcribed through its Hindi support (often in Devanagari or Roman script). The LLM understands that reliably, but accuracy for names and addresses spoken in Urdu is lower than in English. A dedicated Urdu STT (e.g. Azure `ur-IN`) would improve it, at the cost of English accuracy on a single assistant.
- **Duplicate detection** uses the phone number only, as the spec suggests. Family members who share a number can choose "new registration".
- No authentication on the REST API (out of scope for the challenge). It does have input validation, a body size limit and parameterized SQL.
- `node:sqlite` is marked experimental in Node 22 (its warning is suppressed in npm scripts).

## Next steps

- Appointment scheduling after registration (mock availability through an extra intent).
- API-key auth on `/patients` and `/calls`.
- Postgres plus a migration tool for multi-instance deploys.
- Prompt and latency tuning against recorded real-call transcripts, and evaluation fixtures for the LLM turns.
