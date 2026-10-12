const { ZodError } = require('zod');
const { REQUIRED_FIELDS, OPTIONAL_FIELDS, PATIENT_FIELDS, validateField } = require('../validation');
const { SYSTEM_PROMPT } = require('./prompt');
const { text, buildReadBack, buildCorrectionReadBack, fieldLabel, question } = require('./speech');
const { scriptedTurn, nextQuestion } = require('./scripted');

const INTENTS = new Set(['continue', 'read_back', 'confirm_save', 'start_over', 'accept_update', 'decline_update', 'end_call']);
const HISTORY_TURNS = 16;

function newState() {
  return {
    language: 'en',
    phase: 'collecting', // collecting -> confirming -> done
    data: {},
    optional_offered: false,
    mode: 'create', // or 'update' once a returning caller opts to update their record
    target_patient_id: null,
    existing: null,
    existing_decision: null, // null | 'pending' | 'update' | 'new'
    dup_checked_phone: null,
    save_failures: 0,
    pending_field: 'full_name', // used by the scripted fallback only
    no_input: 0,
    last_prompt: ''
  };
}

const missingRequired = state => REQUIRED_FIELDS.filter(field => !state.data[field]);

/**
 * The conversation brain. Each caller utterance goes through `respond`, which:
 *   1. asks the LLM to interpret it (structured JSON: field updates + intent + reply),
 *   2. validates every field update server-side, rejecting bad values,
 *   3. runs duplicate detection when a phone number arrives,
 *   4. only writes to the database after a server-generated read-back is confirmed.
 * If the LLM is unavailable it degrades to a scripted question-by-question flow.
 */
function createAgent({ patients, llm, log }) {
  function greeting(state) {
    return text(state.language).greeting;
  }

  function buildMessages(state, history, utterance, serverNotes) {
    const context = {
      phase: state.phase,
      language: state.language,
      collected: state.data,
      missing_required: missingRequired(state),
      optional_fields_not_collected: OPTIONAL_FIELDS.filter(field => !state.data[field]),
      optional_offered: state.optional_offered,
      mode: state.mode,
      existing_patient: state.existing && { first_name: state.existing.first_name, last_name: state.existing.last_name },
      existing_patient_decision: state.existing_decision,
      server_notes: serverNotes
    };
    const lines = history.slice(-HISTORY_TURNS).map(entry => `${entry.role === 'agent' ? 'Huzaifa' : 'Caller'}: ${entry.text}`);
    return [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `CURRENT STATE:\n${JSON.stringify(context)}\n\nCONVERSATION SO FAR:\n${lines.join('\n')}\n\nCALLER JUST SAID: "${utterance}"\n\nRespond with the JSON object only.`
      }
    ];
  }

  function sanitize(raw) {
    const updates = raw && typeof raw.updates === 'object' && raw.updates !== null ? raw.updates : {};
    return {
      updates,
      intent: INTENTS.has(raw?.intent) ? raw.intent : 'continue',
      language: ['en', 'es', 'ur'].includes(raw?.language) ? raw.language : null,
      offered_optional: raw?.offered_optional === true,
      reply: typeof raw?.reply === 'string' ? raw.reply.trim() : ''
    };
  }

  function applyUpdates(state, updates) {
    const notes = [];
    const rejected = [];
    const changedFields = [];
    for (const [field, value] of Object.entries(updates)) {
      if (!PATIENT_FIELDS.includes(field)) continue;
      if (value === null || value === '') {
        if (OPTIONAL_FIELDS.includes(field) && state.data[field]) { delete state.data[field]; changedFields.push(field); }
        continue;
      }
      const result = validateField(field, value);
      if (result.ok) {
        if (state.data[field] !== result.value) { state.data[field] = result.value; changedFields.push(field); }
      } else {
        rejected.push({ field, error: result.error });
        notes.push(`The ${field} value "${value}" was rejected: it ${result.error}. Explain this kindly and ask for the ${field} again.`);
        if (state.data[field]) delete state.data[field];
      }
    }
    return { notes, rejected, changedFields };
  }

  function checkDuplicate(state) {
    const phone = state.data.phone_number;
    if (state.mode !== 'create' || state.existing_decision || !phone || state.dup_checked_phone === phone) return false;
    state.dup_checked_phone = phone;
    const existing = patients.findByPhone(phone);
    if (!existing) return false;
    state.existing = { patient_id: existing.patient_id, first_name: existing.first_name, last_name: existing.last_name };
    state.existing_decision = 'pending';
    return true;
  }

  function acceptUpdate(state) {
    const existing = state.existing && patients.get(state.existing.patient_id);
    if (!existing) { state.existing_decision = 'new'; return; }
    const current = {};
    for (const field of PATIENT_FIELDS) if (existing[field]) current[field] = existing[field];
    // A new street address makes the old apartment/unit meaningless.
    if (state.data.address_line_1 && state.data.address_line_1 !== existing.address_line_1) delete current.address_line_2;
    // Anything said on this call wins over what is on file.
    state.data = { ...current, ...state.data };
    state.mode = 'update';
    state.target_patient_id = existing.patient_id;
    state.existing_decision = 'update';
    state.optional_offered = true;
  }

  function resetState(state) {
    const fresh = newState();
    fresh.language = state.language;
    fresh.pending_field = null;
    Object.assign(state, fresh);
  }

  function readBackOrAsk(state, fallbackReply) {
    if (missingRequired(state).length === 0 && state.existing_decision !== 'pending') {
      state.phase = 'confirming';
      return { reply: buildReadBack(state.data, state.language) };
    }
    return { reply: fallbackReply || nextQuestion(state) };
  }

  function save(state) {
    try {
      // In update mode state.data is the complete, confirmed record, so send every field
      // (absent = null) rather than a partial patch that would keep removed values.
      const fullRecord = Object.fromEntries(PATIENT_FIELDS.map(field => [field, state.data[field] ?? null]));
      const patient = state.mode === 'update'
        ? patients.update(state.target_patient_id, fullRecord)
        : patients.create(state.data);
      if (!patient) throw new Error('Patient record to update no longer exists');
      state.phase = 'done';
      const t = text(state.language);
      return {
        reply: state.mode === 'update' ? t.updated(patient.first_name) : t.saved(patient.first_name),
        hangup: true,
        outcome: { status: 'completed', patient }
      };
    } catch (error) {
      state.save_failures += 1;
      log('patient_save_failed', { error: error.message, attempt: state.save_failures, data: state.data });
      if (error instanceof ZodError) {
        // Should not happen (fields are validated as they arrive), but if it does, re-ask that field.
        const field = error.issues[0]?.path[0];
        if (field) delete state.data[field];
        state.phase = 'collecting';
        return { reply: text(state.language).invalidField(fieldLabel(field, state.language), error.issues[0].message) };
      }
      if (state.save_failures >= 2) {
        return { reply: text(state.language).saveFailedFinal, hangup: true, outcome: { status: 'failed' } };
      }
      return { reply: text(state.language).saveFailedRetry }; // phase stays 'confirming', so "yes" retries
    }
  }

  async function llmTurn(state, history, utterance) {
    const turn = sanitize(await llm.completeJson(buildMessages(state, history, utterance, [])));
    state.pending_field = null; // the LLM is driving; any scripted question is stale
    if (turn.language) state.language = turn.language;
    if (turn.offered_optional) state.optional_offered = true;

    if (turn.intent === 'start_over') { resetState(state); return { reply: turn.reply || text(state.language).startOver }; }
    if (turn.intent === 'end_call') return { reply: turn.reply || text(state.language).goodbye, hangup: true, outcome: { status: 'abandoned' } };
    if (turn.intent === 'accept_update' && state.existing_decision === 'pending') acceptUpdate(state);
    if (turn.intent === 'decline_update' && state.existing_decision === 'pending') state.existing_decision = 'new';

    const wasConfirming = state.phase === 'confirming';
    const { notes, rejected, changedFields } = applyUpdates(state, turn.updates);
    if (state.mode === 'update' && changedFields.includes('address_line_1') && !('address_line_2' in turn.updates) && state.data.address_line_2) {
      delete state.data.address_line_2; // moved: the old unit number no longer applies
      changedFields.push('address_line_2');
    }
    if (wasConfirming && (changedFields.length || rejected.length)) state.phase = 'collecting';

    if (checkDuplicate(state)) {
      // Fixed wording (from the spec) so the returning-patient question is never skipped or garbled.
      return { reply: text(state.language).duplicate(state.existing.first_name, state.existing.last_name) };
    }

    if (notes.length) {
      // Second pass so the reply addresses exactly the field the server rejected.
      const serverNotes = notes;
      try {
        const second = sanitize(await llm.completeJson(buildMessages(state, history, utterance, serverNotes)));
        if (second.reply) return { reply: second.reply };
      } catch (error) {
        log('llm_error', { stage: 'server_notes_pass', error: error.message });
      }
      return { reply: text(state.language).invalidField(fieldLabel(rejected[0].field, state.language), rejected[0].error) };
    }

    if (wasConfirming && changedFields.length && missingRequired(state).length === 0) {
      // Correction during confirmation: read back just what changed (server-generated, so the
      // caller confirms exactly what will be saved) and stay in the confirming phase.
      state.phase = 'confirming';
      return { reply: buildCorrectionReadBack(changedFields, state.data, state.language) };
    }

    if (turn.intent === 'confirm_save') {
      if (state.phase === 'confirming' && missingRequired(state).length === 0) return save(state);
      return readBackOrAsk(state, turn.reply); // not confirmed against a read-back yet
    }
    if (turn.intent === 'read_back') return readBackOrAsk(state, turn.reply);
    return { reply: turn.reply || nextQuestion(state) || text(state.language).retryUnderstanding };
  }

  function fallbackTurn(state, utterance) {
    const result = scriptedTurn(state, utterance);
    if (result.action === 'start_over') { resetState(state); state.pending_field = 'full_name'; return { reply: text(state.language).startOver }; }
    if (result.action === 'save') return save(state);
    if (result.action === 'read_back') return readBackOrAsk(state);
    return { reply: result.reply };
  }

  async function respond(state, history, utterance) {
    if (llm.enabled) {
      try {
        return await llmTurn(state, history, utterance);
      } catch (error) {
        log('llm_error', { stage: 'primary', error: error.message });
        // No scripted question is outstanding yet (the LLM was driving), so we can't
        // parse this utterance; ask the next field explicitly and parse the answer next turn.
        if (!state.pending_field && state.phase === 'collecting') {
          const field = REQUIRED_FIELDS.find(f => !state.data[f]);
          if (field) { state.pending_field = field; return { reply: `${text(state.language).retryUnderstanding} ${question(field, state.language)}` }; }
        }
      }
    }
    // Keep the call alive with the scripted flow rather than going silent.
    return fallbackTurn(state, utterance);
  }

  return { newState, greeting, respond };
}

module.exports = { createAgent };
