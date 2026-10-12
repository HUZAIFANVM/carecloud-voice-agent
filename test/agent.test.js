const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, fakeLlm } = require('./helpers');

const FULL = {
  first_name: 'John', last_name: 'Davis', date_of_birth: '03/04/1990', sex: 'Male', phone_number: '5553334444',
  address_line_1: '1 Elm Street', city: 'Austin', state: 'TX', zip_code: '78701'
};
const turn = (fields = {}) => ({ updates: {}, intent: 'continue', language: 'en', offered_optional: false, reply: 'ok', ...fields });

async function session(server) {
  const res = await server.request('POST', '/simulator/sessions');
  assert.equal(res.status, 201);
  const id = res.body.data.session_id;
  return text => server.request('POST', `/simulator/sessions/${id}/messages`, { text }).then(r => r.body.data);
}

test('happy path: collect, read back, confirm, save', async () => {
  const llm = fakeLlm([
    turn({ updates: FULL, reply: 'Would you like to add insurance or an emergency contact?', offered_optional: true }),
    turn({ intent: 'read_back', reply: '' }),
    turn({ intent: 'confirm_save' })
  ]);
  const server = await startTestServer({ llm });
  const say = await session(server);

  await say('Everything at once');
  const readBack = await say('No thanks');
  assert.match(readBack.reply, /John Davis/);
  assert.match(readBack.reply, /March 4, 1990/);
  assert.match(readBack.reply, /Is all of that correct/);

  const done = await say('Yes');
  assert.equal(done.hangup, true);
  assert.match(done.reply, /You're all set, John/);
  const stored = (await server.request('GET', '/patients?phone_number=5553334444')).body.data;
  assert.equal(stored.length, 1);
  assert.equal(stored[0].patient_id, done.patient_id);
  await server.close();
});

test('confirm_save without a prior read-back triggers the read-back instead of saving', async () => {
  const llm = fakeLlm([turn({ updates: FULL, intent: 'confirm_save' })]);
  const server = await startTestServer({ llm });
  const say = await session(server);
  const res = await say('Save it');
  assert.equal(res.hangup, false);
  assert.match(res.reply, /read that back/);
  assert.equal((await server.request('GET', '/patients')).body.data.length, 0);
  await server.close();
});

test('invalid value is rejected server-side and re-prompted specifically', async () => {
  const llm = fakeLlm([
    turn({ updates: { date_of_birth: '01/01/2999' }, reply: 'Got it!' }),
    turn({ reply: 'That date is in the future. What is your date of birth?' })
  ]);
  const server = await startTestServer({ llm });
  const say = await session(server);
  const res = await say('January first 2999');
  assert.match(res.reply, /future/);
  // The second LLM pass received the server note about the rejected field.
  const notesPrompt = llm.calls[1][1].content;
  assert.match(notesPrompt, /date_of_birth value .*01\/01\/2999.* was rejected/);
  await server.close();
});

test('correction during confirmation reads back the change before saving', async () => {
  const llm = fakeLlm([
    turn({ updates: { ...FULL, last_name: 'Davies' }, intent: 'read_back' }),
    // Even if the model jumps straight to confirm_save, the change must be read back first.
    turn({ updates: { last_name: 'Davis' }, intent: 'confirm_save' }),
    turn({ intent: 'confirm_save' })
  ]);
  const server = await startTestServer({ llm });
  const say = await session(server);
  assert.match((await say('...')).reply, /Davies/);
  const reread = await say('Actually it is spelled D-A-V-I-S');
  assert.equal(reread.hangup, false);
  assert.match(reread.reply, /Last name: Davis. Everything else stays the same/);
  assert.equal((await server.request('GET', '/patients')).body.data.length, 0);
  const done = await say('Yes');
  assert.equal(done.hangup, true);
  assert.equal((await server.request('GET', '/patients')).body.data[0].last_name, 'Davis');
  await server.close();
});

test('returning caller: duplicate phone detected, update instead of create', async () => {
  const llm = fakeLlm([
    turn({ updates: { phone_number: '5555550100' }, reply: 'Thanks! What is your street address?' }),
    turn({ intent: 'accept_update', updates: { address_line_1: '9 Lake Shore Dr', city: 'Chicago' }, reply: 'What would you like to change?' }),
    turn({ intent: 'read_back' }),
    turn({ intent: 'confirm_save' })
  ]);
  const server = await startTestServer({ llm });
  const created = await server.request('POST', '/patients', {
    first_name: 'Jane', last_name: 'Doe', date_of_birth: '04/12/1985', sex: 'Female', phone_number: '5555550100',
    address_line_1: '123 Main', address_line_2: 'Apt 4B', city: 'Springfield', state: 'IL', zip_code: '62701'
  });
  const say = await session(server);
  assert.match((await say('My number is 555 555 0100')).reply, /already have a record for Jane Doe/);
  await say('Yes, I moved to Chicago');
  assert.match((await say('That is all')).reply, /Chicago/);
  const done = await say('Yes');
  assert.match(done.reply, /updated your information/);
  const all = (await server.request('GET', '/patients')).body.data;
  assert.equal(all.length, 1);
  assert.equal(all[0].patient_id, created.body.data.patient_id);
  assert.equal(all[0].city, 'Chicago');
  assert.equal(all[0].address_line_2, null, 'old apartment cleared after a move');
  await server.close();
});

test('start over clears collected data', async () => {
  const llm = fakeLlm([turn({ updates: { first_name: 'Ann' } }), turn({ intent: 'start_over', reply: 'Sure, from the top.' })]);
  const server = await startTestServer({ llm });
  const say = await session(server);
  await say('Ann');
  await say('start over');
  const calls = (await server.request('GET', '/calls')).body.data;
  assert.deepEqual(calls[0].state.data, {});
  await server.close();
});

test('database write failure is reported to the caller, then retried', async () => {
  const llm = fakeLlm([turn({ updates: FULL, intent: 'read_back' }), turn({ intent: 'confirm_save' }), turn({ intent: 'confirm_save' })]);
  const server = await startTestServer({ llm });
  const say = await session(server);
  await say('...');
  server.db.exec(`CREATE TRIGGER fail_insert BEFORE INSERT ON patients BEGIN SELECT RAISE(ABORT, 'disk full'); END;`);
  const failed = await say('Yes');
  assert.equal(failed.hangup, false);
  assert.match(failed.reply, /problem saving/);
  server.db.exec('DROP TRIGGER fail_insert');
  const ok = await say('Yes please');
  assert.equal(ok.hangup, true);
  assert.match(ok.reply, /all set/);
  await server.close();
});

test('LLM outage falls back to scripted flow without going silent', async () => {
  const llm = fakeLlm([new Error('rate limited')]);
  const server = await startTestServer({ llm });
  const say = await session(server);
  const res = await say('John Davis');
  assert.ok(res.reply.length > 0);
  assert.equal(res.hangup, false);
  await server.close();
});

test('scripted mode (no LLM key) completes a registration end to end', async () => {
  const server = await startTestServer();
  const say = await session(server);
  for (const answer of ['John Davis', 'March 4th 1990', 'male', '555 333 4444', '1 Elm Street', 'Austin', 'Texas']) await say(answer);
  const readBack = await say('78701');
  assert.match(readBack.reply, /John Davis/);
  const done = await say('yes');
  assert.equal(done.hangup, true);
  const p = (await server.request('GET', '/patients')).body.data[0];
  assert.equal(p.date_of_birth, '03/04/1990');
  assert.equal(p.state, 'TX');
  await server.close();
});

