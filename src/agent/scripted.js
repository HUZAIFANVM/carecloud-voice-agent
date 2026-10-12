const { REQUIRED_FIELDS, validateField } = require('../validation');
const { text, question, fieldLabel } = require('./speech');

/**
 * Degraded-mode flow used when no LLM key is configured or the LLM call fails.
 * Asks required fields one at a time and does light parsing of the spoken answer.
 * It is intentionally simple: the goal is "the call never goes silent", not parity.
 */
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function parseSpokenDate(input) {
  const lower = input.toLowerCase().replace(/(\d+)(st|nd|rd|th)\b/g, '$1');
  const numeric = lower.match(/(\d{1,2})[/\-. ](\d{1,2})[/\-. ](\d{4})/);
  if (numeric) return `${numeric[1].padStart(2, '0')}/${numeric[2].padStart(2, '0')}/${numeric[3]}`;
  const monthIndex = MONTHS.findIndex(m => lower.includes(m));
  const day = lower.match(/\b(\d{1,2})\b/);
  const year = lower.match(/\b(\d{4})\b/);
  if (monthIndex >= 0 && day && year) return `${String(monthIndex + 1).padStart(2, '0')}/${day[1].padStart(2, '0')}/${year[1]}`;
  return input;
}

function parseAnswer(field, speech) {
  const cleaned = speech.trim().replace(/[.!?]+$/, '');
  switch (field) {
    case 'first_name':
    case 'last_name': {
      // "My name is John" -> "John"; spelled "J O H N" -> "John".
      const words = cleaned.replace(/^(my (first |last )?name is|it's|it is|i'm|i am)\s+/i, '').split(/\s+/);
      const joined = words.every(w => w.length === 1) ? words.join('') : words[words.length > 1 && field === 'last_name' ? words.length - 1 : 0];
      return joined.charAt(0).toUpperCase() + joined.slice(1).toLowerCase();
    }
    case 'date_of_birth': return parseSpokenDate(cleaned);
    case 'sex': {
      const lower = cleaned.toLowerCase();
      if (/female|woman|femenino|mujer|خاتون|عورت|aurat|khatoon/.test(lower)) return 'Female';
      if (/\bmale\b|\bman\b|masculino|hombre|مرد|\bmard\b/.test(lower)) return 'Male';
      if (/decline|prefer not|no decir|نہیں بتانا/.test(lower)) return 'Decline to Answer';
      if (/other|otro|دیگر/.test(lower)) return 'Other';
      return cleaned;
    }
    case 'phone_number': return cleaned.replace(/\D/g, '');
    case 'zip_code': return cleaned.replace(/[^\d-]/g, '');
    default: return cleaned;
  }
}

// After "Is that correct, or anything to change?", "no, that's all" also means confirmed.
const isYes = speech => /\b(yes|yeah|yep|correct|right|sure|s[ií]|correcto|claro|perfect|looks good|all good|that's all|nothing|jee|ji|haan|han|theek)\b|جی|ہاں|درست|ٹھیک/i.test(speech);
const isStartOver = speech => /start over|start again|begin again|empezar de nuevo/i.test(speech);

function nextQuestion(state) {
  const field = REQUIRED_FIELDS.find(f => !state.data[f]);
  state.pending_field = field || null;
  return field ? question(field, state.language) : null;
}

/** Returns { action, reply } where action is 'ask' | 'read_back' | 'save' | 'start_over'. */
function scriptedTurn(state, speech) {
  // Language switching without an LLM: explicit requests or Urdu script.
  const requested = /espa[nñ]ol|spanish/i.test(speech) ? 'es'
    : /urdu|اردو|[\u0600-\u06FF]/i.test(speech) ? 'ur'
      : /\benglish\b/i.test(speech) ? 'en' : null;
  if (requested && requested !== state.language) {
    state.language = requested;
    return { action: 'ask', reply: nextQuestion(state) || text(requested).readBackQuestion };
  }
  if (isStartOver(speech)) return { action: 'start_over' };

  if (state.phase === 'confirming') {
    return isYes(speech) ? { action: 'save' } : { action: 'start_over' };
  }

  if (state.pending_field === 'full_name') {
    // The greeting asks for first and last name together.
    const words = speech.trim().replace(/[.!?]+$/, '').replace(/^(my name is|it's|it is|this is|i'm|i am)\s+/i, '').split(/\s+/);
    const first = validateField('first_name', parseAnswer('first_name', words[0] || ''));
    const last = validateField('last_name', parseAnswer('first_name', words.slice(1).join(' ').split(/\s+/).pop() || ''));
    if (first.ok) state.data.first_name = first.value;
    if (last.ok && words.length > 1) state.data.last_name = last.value;
  } else if (state.pending_field) {
    const field = state.pending_field;
    const result = validateField(field, parseAnswer(field, speech));
    if (!result.ok) {
      const label = fieldLabel(field, state.language);
      return { action: 'ask', reply: text(state.language).invalidField(label, result.error) };
    }
    state.data[field] = result.value;
  }
  const reply = nextQuestion(state);
  return reply ? { action: 'ask', reply } : { action: 'read_back' };
}

module.exports = { scriptedTurn, nextQuestion };
