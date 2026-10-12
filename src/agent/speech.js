/**
 * Server-owned spoken text: greeting, read-back, save outcomes, and fallback prompts.
 * The read-back is generated here (not by the LLM) so what the caller confirms is
 * exactly what will be written to the database.
 */
const STATE_FULL_NAMES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
  DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan',
  MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire',
  NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma',
  OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee',
  TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin',
  WY: 'Wyoming', DC: 'the District of Columbia'
};

const MONTHS = {
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  es: ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'],
  ur: ['جنوری', 'فروری', 'مارچ', 'اپریل', 'مئی', 'جون', 'جولائی', 'اگست', 'ستمبر', 'اکتوبر', 'نومبر', 'دسمبر']
};

const SEX_LABELS = {
  es: { Male: 'masculino', Female: 'femenino', Other: 'otro', 'Decline to Answer': 'prefiere no decir' },
  ur: { Male: 'مرد', Female: 'خاتون', Other: 'دیگر', 'Decline to Answer': 'بتانا نہیں چاہتے' }
};
const speakSex = (sex, language) => SEX_LABELS[language]?.[sex] || sex.toLowerCase();

const FIELD_LABELS = {
  en: {
    first_name: 'first name', last_name: 'last name', date_of_birth: 'date of birth', sex: 'sex', phone_number: 'phone number',
    email: 'email', address_line_1: 'street address', address_line_2: 'apartment or unit', city: 'city', state: 'state',
    zip_code: 'ZIP code', insurance_provider: 'insurance provider', insurance_member_id: 'insurance member ID',
    preferred_language: 'preferred language', emergency_contact_name: 'emergency contact name',
    emergency_contact_phone: 'emergency contact phone number'
  },
  es: {
    first_name: 'nombre', last_name: 'apellido', date_of_birth: 'fecha de nacimiento', sex: 'sexo', phone_number: 'número de teléfono',
    email: 'correo electrónico', address_line_1: 'dirección', address_line_2: 'apartamento o unidad', city: 'ciudad', state: 'estado',
    zip_code: 'código postal', insurance_provider: 'aseguradora', insurance_member_id: 'número de miembro del seguro',
    preferred_language: 'idioma preferido', emergency_contact_name: 'contacto de emergencia',
    emergency_contact_phone: 'teléfono del contacto de emergencia'
  },
  ur: {
    first_name: 'پہلا نام', last_name: 'خاندانی نام', date_of_birth: 'تاریخ پیدائش', sex: 'جنس', phone_number: 'فون نمبر',
    email: 'ای میل', address_line_1: 'گلی کا پتہ', address_line_2: 'اپارٹمنٹ یا یونٹ', city: 'شہر', state: 'ریاست',
    zip_code: 'زپ کوڈ', insurance_provider: 'انشورنس کمپنی', insurance_member_id: 'انشورنس ممبر آئی ڈی',
    preferred_language: 'ترجیحی زبان', emergency_contact_name: 'ایمرجنسی رابطے کا نام',
    emergency_contact_phone: 'ایمرجنسی رابطے کا فون نمبر'
  }
};

// Questions used by the scripted fallback flow and as a deterministic safety net.
const QUESTIONS = {
  en: {
    first_name: 'What is your first name?', last_name: 'And your last name?',
    date_of_birth: 'What is your date of birth, including the year?',
    sex: 'What is your sex? You can say male, female, other, or decline to answer.',
    phone_number: 'What is the best ten digit phone number to reach you?', address_line_1: 'What is your street address?',
    city: 'What city is that in?', state: 'And which state?', zip_code: 'What is your ZIP code?'
  },
  es: {
    first_name: '¿Cuál es su nombre?', last_name: '¿Y su apellido?',
    date_of_birth: '¿Cuál es su fecha de nacimiento, incluyendo el año?',
    sex: '¿Cuál es su sexo? Puede decir masculino, femenino, otro, o prefiero no decir.',
    phone_number: '¿Cuál es el mejor número de teléfono de diez dígitos para contactarle?', address_line_1: '¿Cuál es su dirección?',
    city: '¿En qué ciudad?', state: '¿Y en qué estado?', zip_code: '¿Cuál es su código postal?'
  },
  ur: {
    first_name: 'آپ کا پہلا نام کیا ہے؟', last_name: 'اور آپ کا خاندانی نام؟',
    date_of_birth: 'آپ کی تاریخ پیدائش کیا ہے، سال کے ساتھ؟',
    sex: 'آپ کی جنس کیا ہے؟ آپ مرد، خاتون، دیگر، یا نہیں بتانا چاہتے کہہ سکتے ہیں۔',
    phone_number: 'آپ سے رابطے کے لیے دس ہندسوں کا فون نمبر کیا ہے؟', address_line_1: 'آپ کا گلی کا پتہ کیا ہے؟',
    city: 'یہ کس شہر میں ہے؟', state: 'اور کون سی ریاست؟', zip_code: 'آپ کا زپ کوڈ کیا ہے؟'
  }
};

const TEXT = {
  en: {
    greeting: "Hi, thanks for calling CareCloud! I'm Huzaifa, and I can get you registered as a new patient in just a few minutes. Para español, diga español. Urdu ke liye, Urdu kahiye. To start, could I get your first and last name?",
    noInput: "Sorry, I didn't catch that.",
    noInputGoodbye: "I'm having trouble hearing you, so I'll end the call for now. Please call back any time. Goodbye!",
    startOver: "No problem, let's start fresh. What's your first and last name?",
    goodbye: 'No problem. Thanks for calling CareCloud. Goodbye!',
    saved: name => `You're all set, ${name}! Your registration is saved, and we look forward to seeing you. Thanks for calling CareCloud. Goodbye!`,
    updated: name => `You're all set, ${name}! I've updated your information. Thanks for calling CareCloud. Goodbye!`,
    saveFailedRetry: "I'm sorry, I ran into a problem saving your information on our end. Would you like me to try again?",
    saveFailedFinal: "I'm really sorry, our system isn't able to save your registration right now. Nothing was lost on your side; please call back a little later, or the front desk can finish it with you. Goodbye.",
    invalidField: (label, error) => `Hmm, that ${label} doesn't look right, it ${error}. Could you tell me your ${label} again?`,
    duplicate: (first, last) => `It looks like we already have a record for ${first} ${last}. Would you like to update your information instead?`,
    technical: "Sorry, give me just a moment. Let's keep going.",
    retryUnderstanding: "Sorry, I didn't quite get that. Could you say it again?",
    readBackIntro: 'Okay, let me read that back to make sure I have it right.',
    readBackQuestion: 'Is all of that correct, or is there anything you would like to change?',
    correctionIntro: 'Got it, I updated that.',
    removed: label => `${label} removed`,
    correctionQuestion: 'Everything else stays the same. Is everything correct now?',
    alreadyFinished: 'This call has already been completed. Thank you, goodbye!'
  },
  es: {
    greeting: '¡Hola, gracias por llamar a CareCloud! Soy Huzaifa y puedo registrarle como paciente nuevo en unos minutos. Para empezar, ¿me puede dar su nombre y apellido?',
    noInput: 'Perdón, no le escuché.',
    noInputGoodbye: 'Tengo problemas para escucharle, así que terminaré la llamada por ahora. Puede llamar de nuevo cuando quiera. ¡Adiós!',
    startOver: 'Claro, empecemos de nuevo. ¿Cuál es su nombre y apellido?',
    goodbye: 'Está bien. Gracias por llamar a CareCloud. ¡Adiós!',
    saved: name => `¡Listo, ${name}! Su registro quedó guardado y esperamos verle pronto. Gracias por llamar a CareCloud. ¡Adiós!`,
    updated: name => `¡Listo, ${name}! Actualicé su información. Gracias por llamar a CareCloud. ¡Adiós!`,
    saveFailedRetry: 'Lo siento, tuve un problema al guardar su información. ¿Quiere que lo intente de nuevo?',
    saveFailedFinal: 'Lo siento mucho, nuestro sistema no puede guardar su registro en este momento. Por favor llame un poco más tarde. Adiós.',
    invalidField: (label, error) => `Mmm, ese dato de ${label} no parece correcto. ¿Me puede repetir su ${label}?`,
    duplicate: (first, last) => `Parece que ya tenemos un registro para ${first} ${last}. ¿Le gustaría actualizar su información en lugar de crear uno nuevo?`,
    technical: 'Perdón, un momento. Sigamos.',
    retryUnderstanding: 'Perdón, no entendí bien. ¿Me lo puede repetir?',
    readBackIntro: 'Muy bien, déjeme confirmar sus datos.',
    readBackQuestion: '¿Todo está correcto, o hay algo que quiera cambiar?',
    correctionIntro: 'Perfecto, ya lo actualicé.',
    removed: label => `${label} eliminado`,
    correctionQuestion: 'Todo lo demás queda igual. ¿Ahora está todo correcto?',
    alreadyFinished: 'Esta llamada ya terminó. Gracias, ¡adiós!'
  },
  // Urdu closings also end with "Goodbye": it is in the Vapi assistant's endCallPhrases.
  ur: {
    greeting: 'السلام علیکم، کیئر کلاؤڈ کال کرنے کا شکریہ! میں حذیفہ ہوں، اور چند منٹوں میں آپ کو نئے مریض کے طور پر رجسٹر کر سکتا ہوں۔ شروع کرنے کے لیے، اپنا پورا نام بتائیں؟',
    noInput: 'معاف کیجیے، میں سن نہیں سکا۔',
    noInputGoodbye: 'مجھے آپ کی آواز نہیں آ رہی، اس لیے میں ابھی کال ختم کر رہا ہوں۔ آپ کسی بھی وقت دوبارہ کال کر سکتے ہیں۔ اللہ حافظ، Goodbye!',
    startOver: 'کوئی بات نہیں، نئے سرے سے شروع کرتے ہیں۔ آپ کا پورا نام کیا ہے؟',
    goodbye: 'کوئی بات نہیں۔ کیئر کلاؤڈ کال کرنے کا شکریہ۔ اللہ حافظ، Goodbye!',
    saved: name => `بہت شکریہ ${name}! آپ کی رجسٹریشن محفوظ ہو گئی ہے، ہم آپ سے ملنے کے منتظر ہیں۔ اللہ حافظ، Goodbye!`,
    updated: name => `بہت شکریہ ${name}! میں نے آپ کی معلومات اپ ڈیٹ کر دی ہیں۔ اللہ حافظ، Goodbye!`,
    saveFailedRetry: 'معذرت، آپ کی معلومات محفوظ کرنے میں ہماری طرف سے مسئلہ آیا۔ کیا میں دوبارہ کوشش کروں؟',
    saveFailedFinal: 'بہت معذرت، ہمارا سسٹم ابھی آپ کی رجسٹریشن محفوظ نہیں کر پا رہا۔ براہ کرم تھوڑی دیر بعد دوبارہ کال کریں۔ اللہ حافظ، Goodbye.',
    invalidField: label => `معاف کیجیے، یہ ${label} درست نہیں لگ رہا۔ کیا آپ اپنا ${label} دوبارہ بتا سکتے ہیں؟`,
    duplicate: (first, last) => `لگتا ہے ہمارے پاس پہلے سے ${first} ${last} کا ریکارڈ موجود ہے۔ کیا آپ نیا ریکارڈ بنانے کے بجائے اپنی معلومات اپ ڈیٹ کرنا چاہیں گے؟`,
    technical: 'معاف کیجیے، ایک لمحہ۔ آگے چلتے ہیں۔',
    retryUnderstanding: 'معاف کیجیے، میں ٹھیک سے سمجھ نہیں سکا۔ کیا آپ دوبارہ بتا سکتے ہیں؟',
    readBackIntro: 'ٹھیک ہے، میں آپ کی معلومات دہرا دیتا ہوں۔',
    readBackQuestion: 'کیا یہ سب درست ہے، یا آپ کچھ تبدیل کرنا چاہیں گے؟',
    correctionIntro: 'ٹھیک ہے، میں نے اپ ڈیٹ کر دیا۔',
    removed: label => `${label} ہٹا دیا گیا`,
    correctionQuestion: 'باقی سب ویسا ہی ہے۔ کیا اب سب درست ہے؟',
    alreadyFinished: 'یہ کال مکمل ہو چکی ہے۔ شکریہ، اللہ حافظ!'
  }
};

// Per-language sentence pieces for the read-back.
const READ_BACK = {
  en: {
    identity: (d, dob, sex) => `Your name is ${d.first_name} ${d.last_name}, born ${dob}, sex ${sex}.`,
    phone: 'Phone number', address: 'Address', email: 'Email', insurance: 'Insurance', memberId: 'member ID',
    emergency: 'Emergency contact', language: 'Preferred language', end: '.', sep: ', '
  },
  es: {
    identity: (d, dob, sex) => `Su nombre es ${d.first_name} ${d.last_name}, nacido el ${dob}, sexo ${sex}.`,
    phone: 'Teléfono', address: 'Dirección', email: 'Correo', insurance: 'Seguro', memberId: 'número de miembro',
    emergency: 'Contacto de emergencia', language: 'Idioma preferido', end: '.', sep: ', '
  },
  ur: {
    identity: (d, dob, sex) => `آپ کا نام ${d.first_name} ${d.last_name} ہے، تاریخ پیدائش ${dob}، جنس ${sex}۔`,
    phone: 'فون نمبر', address: 'پتہ', email: 'ای میل', insurance: 'انشورنس', memberId: 'ممبر آئی ڈی',
    emergency: 'ایمرجنسی رابطہ', language: 'ترجیحی زبان', end: '۔', sep: '، '
  }
};

const text = language => TEXT[language] || TEXT.en;

// "5551234567" -> "5 5 5, 1 2 3, 4 5 6 7" so TTS reads digits individually with natural pauses.
function speakPhone(digits) {
  return `${digits.slice(0, 3).split('').join(' ')}, ${digits.slice(3, 6).split('').join(' ')}, ${digits.slice(6).split('').join(' ')}`;
}
const spell = value => String(value).split('').join(' ');

function speakDate(mmddyyyy, language) {
  const [month, day, year] = mmddyyyy.split('/').map(Number);
  const monthName = (MONTHS[language] || MONTHS.en)[month - 1];
  if (language === 'es') return `${day} de ${monthName} de ${year}`;
  if (language === 'ur') return `${day} ${monthName} ${year}`;
  return `${monthName} ${day}, ${year}`;
}

function buildReadBack(data, language) {
  const r = READ_BACK[language] || READ_BACK.en;
  const parts = [text(language).readBackIntro];
  parts.push(r.identity(data, speakDate(data.date_of_birth, language), speakSex(data.sex, language)));
  parts.push(`${r.phone} ${speakPhone(data.phone_number)}${r.end}`);
  const street = [data.address_line_1, data.address_line_2].filter(Boolean).join(r.sep);
  parts.push(`${r.address} ${[street, data.city, STATE_FULL_NAMES[data.state] || data.state, spell(data.zip_code)].join(r.sep)}${r.end}`);
  if (data.email) parts.push(`${r.email} ${data.email}${r.end}`);
  if (data.insurance_provider || data.insurance_member_id) {
    const id = data.insurance_member_id ? `${r.sep}${r.memberId} ${spell(data.insurance_member_id)}` : '';
    parts.push(`${r.insurance} ${data.insurance_provider || ''}${id}${r.end}`);
  }
  if (data.emergency_contact_name || data.emergency_contact_phone) {
    const phone = data.emergency_contact_phone ? `${r.sep}${speakPhone(data.emergency_contact_phone)}` : '';
    parts.push(`${r.emergency} ${data.emergency_contact_name || ''}${phone}${r.end}`);
  }
  if (data.preferred_language && data.preferred_language !== 'English') {
    parts.push(`${r.language} ${data.preferred_language}${r.end}`);
  }
  parts.push(text(language).readBackQuestion);
  return parts.join(' ');
}

// Spoken form of a single field value, using the same formatting as the full read-back.
function speakValue(field, value, language) {
  if (field === 'date_of_birth') return speakDate(value, language);
  if (field === 'phone_number' || field === 'emergency_contact_phone') return speakPhone(value);
  if (field === 'zip_code' || field === 'insurance_member_id') return spell(value);
  if (field === 'state') return STATE_FULL_NAMES[value] || value;
  if (field === 'sex') return language === 'en' ? value : speakSex(value, language);
  return value;
}

function buildCorrectionReadBack(fields, data, language) {
  const t = text(language);
  const parts = fields.map(field => (data[field]
    ? `${fieldLabel(field, language)}: ${speakValue(field, data[field], language)}`
    : t.removed(fieldLabel(field, language))));
  const r = READ_BACK[language] || READ_BACK.en;
  const sentence = parts.join(r.sep);
  return `${t.correctionIntro} ${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}${r.end} ${t.correctionQuestion}`;
}

const fieldLabel = (field, language) => (FIELD_LABELS[language] || FIELD_LABELS.en)[field] || field.replaceAll('_', ' ');
const question = (field, language) => (QUESTIONS[language] || QUESTIONS.en)[field];

module.exports = { text, buildReadBack, buildCorrectionReadBack, fieldLabel, question };
