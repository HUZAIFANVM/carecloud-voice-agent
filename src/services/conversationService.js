const { text } = require('../agent/speech');

const MAX_SILENT_TURNS = 3;

/**
 * Channel-agnostic call lifecycle: start, take a turn, end. The Vapi adapter and
 * the browser simulator both call into this, so they behave identically.
 */
function createConversationService({ agent, calls, log }) {
  function start({ callSid, channel = 'phone', fromNumber = null }) {
    const existing = calls.get(callSid);
    if (existing && existing.status === 'in_progress' && existing.state.last_prompt) {
      // A retried first request (or a restart mid-call): repeat, don't reset.
      return { reply: existing.state.last_prompt, language: existing.state.language };
    }
    const state = agent.newState();
    const reply = agent.greeting(state);
    state.last_prompt = reply;
    const call = calls.create({ callSid, channel, fromNumber, state });
    call.transcript.push({ role: 'agent', text: reply, at: new Date().toISOString() });
    calls.save(call);
    log('call_started', { callSid, channel, fromNumber });
    return { reply, language: state.language };
  }

  async function turn(callSid, utterance) {
    let call = calls.get(callSid);
    if (!call) {
      start({ callSid });
      call = calls.get(callSid);
    }
    const { state } = call;
    if (call.status !== 'in_progress') {
      return { reply: text(state.language).alreadyFinished, hangup: true, language: state.language };
    }

    const speech = String(utterance || '').trim();
    let result;
    if (!speech) {
      state.no_input += 1;
      result = state.no_input >= MAX_SILENT_TURNS
        ? { reply: text(state.language).noInputGoodbye, hangup: true, outcome: { status: 'abandoned' } }
        : { reply: `${text(state.language).noInput} ${state.last_prompt}` };
    } else {
      state.no_input = 0;
      const history = [...call.transcript];
      call.transcript.push({ role: 'caller', text: speech, at: new Date().toISOString() });
      result = await agent.respond(state, history, speech);
    }

    if (!result.reply) result.reply = text(state.language).retryUnderstanding;
    if (speech) state.last_prompt = result.reply;
    call.transcript.push({ role: 'agent', text: result.reply, at: new Date().toISOString() });

    if (result.outcome) {
      call.status = result.outcome.status;
      if (result.outcome.patient) call.patient_id = result.outcome.patient.patient_id;
      // Observability requirement: the final collected payload is always logged.
      log(`registration_${result.outcome.status}`, {
        callSid, mode: state.mode, patient: result.outcome.patient || null, collected: state.data
      });
    }
    log('call_turn', { callSid, caller: speech || null, agent: result.reply, phase: state.phase, language: state.language });
    calls.save(call);
    return { reply: result.reply, hangup: Boolean(result.hangup), language: state.language, patient_id: call.patient_id || null };
  }

  // Called from Vapi's end-of-call report when the line drops or the caller hangs up.
  function end(callSid, reason) {
    const call = calls.get(callSid);
    if (!call || call.status !== 'in_progress') return;
    call.status = 'abandoned';
    call.transcript.push({ role: 'system', text: `Call ended before completion (${reason}).`, at: new Date().toISOString() });
    calls.save(call);
    log('registration_abandoned', { callSid, reason, collected: call.state.data });
  }

  return { start, turn, end };
}

module.exports = { createConversationService };
