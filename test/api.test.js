const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, validPatient } = require('./helpers');

let server;
before(async () => { server = await startTestServer(); });
after(() => server.close());

test('GET /health returns envelope', async () => {
  const res = await server.request('GET', '/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.data.status, 'ok');
  assert.equal(res.body.error, null);
});

test('POST /patients creates a normalized patient', async () => {
  const res = await server.request('POST', '/patients', validPatient());
  assert.equal(res.status, 201);
  const p = res.body.data;
  assert.match(p.patient_id, /^[0-9a-f-]{36}$/);
  assert.equal(p.phone_number, '5552013344');
  assert.equal(p.state, 'IL');
  assert.equal(p.preferred_language, 'English');
  assert.equal(p.email, null);
  assert.equal(p.deleted_at, null);
  assert.ok(p.created_at && p.updated_at);
});

test('POST /patients rejects invalid data with 422 and field details', async () => {
  const res = await server.request('POST', '/patients', {
    ...validPatient(), phone_number: '555', date_of_birth: '01/01/2999', state: 'ZZ', sex: 'Unknown'
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.data, null);
  const fields = res.body.error.details.map(d => d.field);
  for (const field of ['phone_number', 'date_of_birth', 'state', 'sex']) assert.ok(fields.includes(field), field);
});

test('POST /patients rejects unknown fields and malformed JSON', async () => {
  assert.equal((await server.request('POST', '/patients', { ...validPatient(), is_admin: true })).status, 422);
  assert.equal((await server.request('POST', '/patients', '{"bad json')).status, 400);
});

test('GET /patients supports filters', async () => {
  await server.request('POST', '/patients', { ...validPatient(), last_name: 'Filtertest', phone_number: '5559990000' });
  const byName = await server.request('GET', '/patients?last_name=filtertest');
  assert.equal(byName.body.data.length, 1);
  const byPhone = await server.request('GET', '/patients?phone_number=(555)%20999-0000');
  assert.equal(byPhone.body.data[0].last_name, 'Filtertest');
  const byDob = await server.request('GET', '/patients?date_of_birth=04/12/1985');
  assert.ok(byDob.body.data.length >= 1);
});

test('PUT allows partial update and re-validates', async () => {
  const created = (await server.request('POST', '/patients', validPatient())).body.data;
  const updated = await server.request('PUT', `/patients/${created.patient_id}`, { city: 'Chicago', email: 'jane@example.com' });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.data.city, 'Chicago');
  assert.equal(updated.body.data.first_name, 'Jane');
  const bad = await server.request('PUT', `/patients/${created.patient_id}`, { zip_code: '1234' });
  assert.equal(bad.status, 422);
});

test('DELETE soft-deletes; record disappears from reads but stays in DB', async () => {
  const created = (await server.request('POST', '/patients', validPatient())).body.data;
  const del = await server.request('DELETE', `/patients/${created.patient_id}`);
  assert.equal(del.status, 200);
  assert.ok(del.body.data.deleted_at);
  assert.equal((await server.request('GET', `/patients/${created.patient_id}`)).status, 404);
  assert.equal((await server.request('DELETE', `/patients/${created.patient_id}`)).status, 404);
  const row = server.db.prepare('SELECT deleted_at FROM patients WHERE patient_id = ?').get(created.patient_id);
  assert.ok(row.deleted_at);
});

test('invalid UUID returns 400, unknown UUID returns 404', async () => {
  assert.equal((await server.request('GET', '/patients/not-a-uuid')).status, 400);
  assert.equal((await server.request('GET', '/patients/00000000-0000-4000-8000-00000000abcd')).status, 404);
});

test('database CHECK constraints reject invalid rows even without app validation', () => {
  assert.throws(() => server.db.prepare(
    `INSERT INTO patients (patient_id, first_name, last_name, date_of_birth, sex, phone_number, address_line_1, city, state, zip_code, created_at, updated_at)
     VALUES ('00000000-0000-4000-8000-000000000999', 'A', 'B', '01/01/1990', 'Robot', '5551234567', 'x', 'y', 'CA', '12345', 'now', 'now')`
  ).run());
});
