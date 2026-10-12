const crypto = require('crypto');
const { PATIENT_FIELDS, patientCreateSchema, patientUpdateSchema, toRecord, normalizePhone } = require('../validation');

/**
 * The single data-access layer for patients. Both the REST API and the voice agent
 * go through here, so validation and persistence rules live in exactly one place.
 * Methods throw ZodError on invalid input; callers map that to 422 / a re-prompt.
 */
function createPatientService(db) {
  const selectActive = db.prepare('SELECT * FROM patients WHERE patient_id = ? AND deleted_at IS NULL');
  const toPlain = row => (row ? { ...row } : null);

  function get(patientId) {
    return toPlain(selectActive.get(patientId));
  }

  function list({ last_name, date_of_birth, phone_number } = {}) {
    const clauses = ['deleted_at IS NULL'];
    const params = {};
    if (last_name) { clauses.push('last_name = @last_name COLLATE NOCASE'); params.last_name = String(last_name).trim(); }
    if (date_of_birth) { clauses.push('date_of_birth = @date_of_birth'); params.date_of_birth = String(date_of_birth).trim(); }
    if (phone_number) { clauses.push('phone_number = @phone_number'); params.phone_number = normalizePhone(phone_number); }
    return db.prepare(`SELECT * FROM patients WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC`).all(params).map(toPlain);
  }

  function findByPhone(phoneNumber) {
    return list({ phone_number: phoneNumber })[0] || null;
  }

  function create(input) {
    const record = toRecord(patientCreateSchema.parse(input));
    const now = new Date().toISOString();
    const row = { ...record, patient_id: crypto.randomUUID(), created_at: now, updated_at: now };
    const columns = Object.keys(row);
    db.prepare(`INSERT INTO patients (${columns.join(', ')}) VALUES (${columns.map(c => '@' + c).join(', ')})`).run(row);
    return get(row.patient_id);
  }

  function update(patientId, input) {
    const current = get(patientId);
    if (!current) return null;
    const changes = patientUpdateSchema.parse(input);
    const merged = {};
    for (const field of PATIENT_FIELDS) merged[field] = field in changes ? changes[field] : current[field];
    // Re-validate the merged record so a partial update can never produce an invalid row.
    const record = toRecord(patientCreateSchema.parse(merged));
    const assignments = PATIENT_FIELDS.map(field => `${field} = @${field}`).join(', ');
    db.prepare(`UPDATE patients SET ${assignments}, updated_at = @updated_at WHERE patient_id = @patient_id`)
      .run({ ...record, updated_at: new Date().toISOString(), patient_id: patientId });
    return get(patientId);
  }

  function softDelete(patientId) {
    const now = new Date().toISOString();
    const result = db.prepare('UPDATE patients SET deleted_at = ?, updated_at = ? WHERE patient_id = ? AND deleted_at IS NULL')
      .run(now, now, patientId);
    return result.changes ? { patient_id: patientId, deleted_at: now } : null;
  }

  return { get, list, findByPhone, create, update, softDelete };
}

module.exports = { createPatientService };
