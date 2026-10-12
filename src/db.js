const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

// The CHECK constraints mirror the zod schema so the database itself rejects bad
// rows even if a future code path skips application-level validation.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS patients (
  patient_id              TEXT PRIMARY KEY CHECK (length(patient_id) = 36),
  first_name              TEXT NOT NULL CHECK (length(first_name) BETWEEN 1 AND 50),
  last_name               TEXT NOT NULL CHECK (length(last_name) BETWEEN 1 AND 50),
  date_of_birth           TEXT NOT NULL CHECK (date_of_birth GLOB '[0-1][0-9]/[0-3][0-9]/[1-2][0-9][0-9][0-9]'),
  sex                     TEXT NOT NULL CHECK (sex IN ('Male', 'Female', 'Other', 'Decline to Answer')),
  phone_number            TEXT NOT NULL CHECK (length(phone_number) = 10 AND phone_number NOT GLOB '*[^0-9]*'),
  email                   TEXT CHECK (email IS NULL OR email LIKE '%_@_%._%'),
  address_line_1          TEXT NOT NULL CHECK (length(address_line_1) BETWEEN 1 AND 200),
  address_line_2          TEXT CHECK (address_line_2 IS NULL OR length(address_line_2) <= 100),
  city                    TEXT NOT NULL CHECK (length(city) BETWEEN 1 AND 100),
  state                   TEXT NOT NULL CHECK (length(state) = 2 AND state = upper(state)),
  zip_code                TEXT NOT NULL CHECK (zip_code GLOB '[0-9][0-9][0-9][0-9][0-9]' OR zip_code GLOB '[0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9]'),
  insurance_provider      TEXT CHECK (insurance_provider IS NULL OR length(insurance_provider) <= 150),
  insurance_member_id     TEXT CHECK (insurance_member_id IS NULL OR insurance_member_id NOT GLOB '*[^A-Za-z0-9 -]*'),
  preferred_language      TEXT NOT NULL DEFAULT 'English',
  emergency_contact_name  TEXT CHECK (emergency_contact_name IS NULL OR length(emergency_contact_name) <= 100),
  emergency_contact_phone TEXT CHECK (emergency_contact_phone IS NULL OR (length(emergency_contact_phone) = 10 AND emergency_contact_phone NOT GLOB '*[^0-9]*')),
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  deleted_at              TEXT
);
CREATE INDEX IF NOT EXISTS idx_patients_phone ON patients (phone_number) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_patients_last_name ON patients (last_name COLLATE NOCASE) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_patients_dob ON patients (date_of_birth) WHERE deleted_at IS NULL;

-- One row per phone call (or simulator session): persisted conversation state so a
-- server restart mid-call does not lose progress, plus the transcript for auditing.
CREATE TABLE IF NOT EXISTS calls (
  call_sid    TEXT PRIMARY KEY,
  channel     TEXT NOT NULL DEFAULT 'phone' CHECK (channel IN ('phone', 'simulator')),
  from_number TEXT,
  status      TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed', 'abandoned', 'failed')),
  state       TEXT NOT NULL,
  transcript  TEXT NOT NULL DEFAULT '[]',
  patient_id  TEXT REFERENCES patients (patient_id),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calls_patient ON calls (patient_id);
`;

const SEED_PATIENTS = [
  {
    patient_id: '00000000-0000-4000-8000-000000000001', first_name: 'Jane', last_name: 'Doe', date_of_birth: '04/12/1985',
    sex: 'Female', phone_number: '5555550100', email: 'jane.doe@example.com', address_line_1: '123 Main Street',
    address_line_2: 'Apt 4B', city: 'Springfield', state: 'IL', zip_code: '62701', insurance_provider: 'Blue Cross Blue Shield',
    insurance_member_id: 'BCB123456789', preferred_language: 'English', emergency_contact_name: 'John Doe',
    emergency_contact_phone: '5555550101'
  },
  {
    patient_id: '00000000-0000-4000-8000-000000000002', first_name: 'Carlos', last_name: 'Rivera', date_of_birth: '11/30/1972',
    sex: 'Male', phone_number: '5555550102', email: null, address_line_1: '456 Oak Avenue', address_line_2: null,
    city: 'Austin', state: 'TX', zip_code: '78701', insurance_provider: null, insurance_member_id: null,
    preferred_language: 'Spanish', emergency_contact_name: null, emergency_contact_phone: null
  }
];

function seed(db) {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM patients').get();
  if (count > 0) return;
  const now = new Date().toISOString();
  const columns = Object.keys(SEED_PATIENTS[0]);
  const insert = db.prepare(
    `INSERT INTO patients (${columns.join(', ')}, created_at, updated_at)
     VALUES (${columns.map(c => '@' + c).join(', ')}, @created_at, @updated_at)`
  );
  for (const patient of SEED_PATIENTS) insert.run({ ...patient, created_at: now, updated_at: now });
}

function openDatabase(file, { seedData = false } = {}) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  if (seedData) seed(db);
  return db;
}

module.exports = { openDatabase };
