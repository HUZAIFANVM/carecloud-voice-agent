/**
 * Persists per-call conversation state and transcripts. Keeping this in SQLite rather
 * than an in-memory Map means a deploy/restart mid-call resumes where it left off,
 * and every call leaves an auditable transcript linked to the resulting patient.
 */
function createCallStore(db) {
  const parse = row => row && {
    call_sid: row.call_sid,
    channel: row.channel,
    from_number: row.from_number,
    status: row.status,
    patient_id: row.patient_id,
    state: JSON.parse(row.state),
    transcript: JSON.parse(row.transcript),
    created_at: row.created_at,
    updated_at: row.updated_at
  };

  function get(callSid) {
    return parse(db.prepare('SELECT * FROM calls WHERE call_sid = ?').get(callSid));
  }

  function create({ callSid, channel = 'phone', fromNumber = null, state }) {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO calls (call_sid, channel, from_number, state, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT (call_sid) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`)
      .run(callSid, channel, fromNumber, JSON.stringify(state), now, now);
    return get(callSid);
  }

  function save(call) {
    db.prepare('UPDATE calls SET status = ?, state = ?, transcript = ?, patient_id = ?, updated_at = ? WHERE call_sid = ?')
      .run(call.status, JSON.stringify(call.state), JSON.stringify(call.transcript), call.patient_id || null,
        new Date().toISOString(), call.call_sid);
  }

  function list({ limit = 50 } = {}) {
    return db.prepare('SELECT * FROM calls ORDER BY created_at DESC LIMIT ?').all(limit).map(parse);
  }

  return { get, create, save, list };
}

module.exports = { createCallStore };
