const { z } = require('zod');

const STATE_NAMES = {
  ALABAMA: 'AL', ALASKA: 'AK', ARIZONA: 'AZ', ARKANSAS: 'AR', CALIFORNIA: 'CA', COLORADO: 'CO', CONNECTICUT: 'CT',
  DELAWARE: 'DE', FLORIDA: 'FL', GEORGIA: 'GA', HAWAII: 'HI', IDAHO: 'ID', ILLINOIS: 'IL', INDIANA: 'IN', IOWA: 'IA',
  KANSAS: 'KS', KENTUCKY: 'KY', LOUISIANA: 'LA', MAINE: 'ME', MARYLAND: 'MD', MASSACHUSETTS: 'MA', MICHIGAN: 'MI',
  MINNESOTA: 'MN', MISSISSIPPI: 'MS', MISSOURI: 'MO', MONTANA: 'MT', NEBRASKA: 'NE', NEVADA: 'NV', 'NEW HAMPSHIRE': 'NH',
  'NEW JERSEY': 'NJ', 'NEW MEXICO': 'NM', 'NEW YORK': 'NY', 'NORTH CAROLINA': 'NC', 'NORTH DAKOTA': 'ND', OHIO: 'OH',
  OKLAHOMA: 'OK', OREGON: 'OR', PENNSYLVANIA: 'PA', 'RHODE ISLAND': 'RI', 'SOUTH CAROLINA': 'SC', 'SOUTH DAKOTA': 'SD',
  TENNESSEE: 'TN', TEXAS: 'TX', UTAH: 'UT', VERMONT: 'VT', VIRGINIA: 'VA', WASHINGTON: 'WA', 'WEST VIRGINIA': 'WV',
  WISCONSIN: 'WI', WYOMING: 'WY', 'DISTRICT OF COLUMBIA': 'DC', 'WASHINGTON DC': 'DC'
};
const STATE_CODES = new Set(Object.values(STATE_NAMES));

const REQUIRED_FIELDS = ['first_name', 'last_name', 'date_of_birth', 'sex', 'phone_number', 'address_line_1', 'city', 'state', 'zip_code'];
const OPTIONAL_FIELDS = ['email', 'address_line_2', 'insurance_provider', 'insurance_member_id', 'preferred_language', 'emergency_contact_name', 'emergency_contact_phone'];
const PATIENT_FIELDS = [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS];

const blankToUndefined = value => (value === '' || value === null ? undefined : value);
const optional = schema => z.preprocess(blankToUndefined, schema.optional());

const digitsOnly = value => String(value).replace(/\D/g, '');
const phone = z.preprocess(
  value => {
    if (value === undefined || value === null) return value;
    const digits = digitsOnly(value);
    return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  },
  z.string().regex(/^[2-9]\d{9}$/, 'must be a valid U.S. 10-digit phone number')
);

const name = z.string().trim().min(1).max(50)
  .regex(/^\p{L}[\p{L}' -]*$/u, 'may contain only letters, spaces, hyphens, and apostrophes');

const dateOfBirth = z.string().trim()
  .regex(/^\d{2}\/\d{2}\/\d{4}$/, 'must use MM/DD/YYYY')
  .refine(value => {
    const [month, day, year] = value.split('/').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  }, 'must be a real calendar date')
  .refine(value => {
    const [month, day, year] = value.split('/').map(Number);
    return new Date(Date.UTC(year, month - 1, day)) <= new Date();
  }, 'cannot be in the future')
  .refine(value => Number(value.slice(6)) >= 1900, 'year must be 1900 or later');

const sex = z.preprocess(value => {
  if (typeof value !== 'string') return value;
  const lower = value.trim().toLowerCase();
  if (/decline|prefer not|rather not/.test(lower)) return 'Decline to Answer';
  if (/^(female|woman|f)$/.test(lower)) return 'Female';
  if (/^(male|man|m)$/.test(lower)) return 'Male';
  if (lower === 'other') return 'Other';
  return value;
}, z.enum(['Male', 'Female', 'Other', 'Decline to Answer']));

const state = z.preprocess(value => {
  if (typeof value !== 'string') return value;
  const upper = value.trim().toUpperCase().replace(/\./g, '');
  return STATE_NAMES[upper] || upper;
}, z.string().refine(value => STATE_CODES.has(value), 'must be a valid two-letter U.S. state abbreviation'));

const fieldSchemas = {
  first_name: name,
  last_name: name,
  date_of_birth: dateOfBirth,
  sex,
  phone_number: phone,
  email: optional(z.string().trim().toLowerCase().email('must be a valid email address').max(254)),
  address_line_1: z.string().trim().min(1).max(200),
  address_line_2: optional(z.string().trim().max(100)),
  city: z.string().trim().min(1).max(100),
  state,
  zip_code: z.string().trim().regex(/^\d{5}(?:-\d{4})?$/, 'must be a 5-digit ZIP or ZIP+4'),
  insurance_provider: optional(z.string().trim().max(150)),
  insurance_member_id: optional(z.string().trim().max(100).regex(/^[A-Za-z0-9 -]+$/, 'must be alphanumeric')),
  preferred_language: optional(z.string().trim().max(50)),
  emergency_contact_name: optional(z.string().trim().max(100)),
  emergency_contact_phone: optional(phone)
};

const patientCreateSchema = z.object(fieldSchemas).strict();
const patientUpdateSchema = patientCreateSchema.partial().strict()
  .refine(value => Object.keys(value).length > 0, 'at least one field is required');

// Optional fields come back as `undefined`; store them as NULL and apply the language default.
function toRecord(parsed) {
  const record = {};
  for (const field of PATIENT_FIELDS) record[field] = parsed[field] ?? null;
  record.preferred_language = record.preferred_language || 'English';
  return record;
}

/** Validate a single field (used by the voice agent to re-prompt for exactly that field). */
function validateField(field, value) {
  const schema = fieldSchemas[field];
  if (!schema) return { ok: false, error: 'is not a known field' };
  const result = schema.safeParse(value);
  if (result.success) return { ok: true, value: result.data ?? null };
  return { ok: false, error: result.error.issues[0].message };
}

function formatIssues(error) {
  return error.issues.map(issue => ({ field: issue.path.join('.') || null, message: issue.message }));
}

module.exports = {
  REQUIRED_FIELDS,
  OPTIONAL_FIELDS,
  PATIENT_FIELDS,
  patientCreateSchema,
  patientUpdateSchema,
  validateField,
  toRecord,
  formatIssues,
  normalizePhone: value => digitsOnly(value).replace(/^1(\d{10})$/, '$1')
};
