const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, fakeLlm } = require('./helpers');

const turn = (fields = {}) => ({ updates: {}, intent: 'continue', language: 'en', offered_optional: false, reply: 'ok', ...fields });
const completion = (callId, messages, extra = {}) => ({
  model: 'carecloud-intake-agent', stream: true, call: { id: callId, customer: { number: '+15551112222' } }, messages, ...extra
});
// Pull the assistant text out of an OpenAI-style SSE stream.
const sseText = body => body.split('\n')
  .filter(line => line.startsWith('data: ') && !line.includes('[DONE]'))
  .map(line => JSON.parse(line.slice(6)).choices[0].delta.content || '')
  .join('');

test('Vapi custom LLM: rejects requests without the shared secret', async () => {
  const server = await startTestServer();
  const res = await server.vapi('/vapi/chat/completions', completion('c0', []), 'wrong');
  assert.equal(res.status, 401);
  const wrongPath = await server.request('POST', '/vapi/k/wrong/chat/completions', completion('c0', []));
  assert.equal(wrongPath.status, 401);
  const rightPath = await server.request('POST', '/vapi/k/test-secret/chat/completions', completion('c0', []));
  assert.equal(rightPath.status, 200);
  await server.close();
});

test('Vapi custom LLM: streams the agent reply as OpenAI SSE chunks', async () => {
  const llm = fakeLlm([turn({ updates: { first_name: 'Maria', last_name: 'Lopez' }, reply: 'Thanks Maria! What is your date of birth?' })]);
  const server = await startTestServer({ llm });
  const res = await server.vapi('/vapi/chat/completions', completion('c1', [
    { role: 'assistant', content: 'Hi, thanks for calling CareCloud!' },
    { role: 'user', content: 'Maria Lopez' }
  ]));
  assert.equal(res.status, 200);
  assert.match(res.contentType, /text\/event-stream/);
  assert.match(res.text, /data: \[DONE\]/);
  assert.equal(sseText(res.text), 'Thanks Maria! What is your date of birth?');

  const call = (await server.request('GET', '/calls/VAPI-c1')).body.data;
  assert.equal(call.from_number, '+15551112222');
  assert.deepEqual(call.state.data, { first_name: 'Maria', last_name: 'Lopez' });
  await server.close();
});

test('Vapi custom LLM: non-streaming requests get a chat.completion JSON body', async () => {
  const llm = fakeLlm([turn({ reply: 'Sure, what is your name?' })]);
  const server = await startTestServer({ llm });
  const res = await server.vapi('/vapi', completion('c2', [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], { stream: false }));
  assert.equal(res.body.object, 'chat.completion');
  assert.equal(res.body.choices[0].message.content, 'Sure, what is your name?');
  await server.close();
});

test('Vapi: finished registration ends with a Goodbye phrase that triggers hang-up', async () => {
  const full = {
    first_name: 'John', last_name: 'Davis', date_of_birth: '03/04/1990', sex: 'Male', phone_number: '5553334444',
    address_line_1: '1 Elm Street', city: 'Austin', state: 'TX', zip_code: '78701'
  };
  const llm = fakeLlm([turn({ updates: full, intent: 'read_back' }), turn({ intent: 'confirm_save' })]);
  const server = await startTestServer({ llm });
  await server.vapi('/vapi/chat/completions', completion('c3', [{ role: 'user', content: 'all my details' }]));
  const res = await server.vapi('/vapi/chat/completions', completion('c3', [{ role: 'user', content: 'yes' }]));
  assert.match(sseText(res.text), /You're all set, John.*Goodbye!$/);
  assert.equal((await server.request('GET', '/calls/VAPI-c3')).body.data.status, 'completed');
  await server.close();
});

test('Vapi end-of-call report marks an unfinished call abandoned', async () => {
  const llm = fakeLlm([turn({ updates: { first_name: 'Ann' } })]);
  const server = await startTestServer({ llm });
  await server.vapi('/vapi/chat/completions', completion('c4', [{ role: 'user', content: 'Ann' }]));
  const hook = await server.vapi('/vapi/webhook', { message: { type: 'end-of-call-report', call: { id: 'c4' }, endedReason: 'customer-ended-call' } });
  assert.equal(hook.status, 200);
  const call = (await server.request('GET', '/calls/VAPI-c4')).body.data;
  assert.equal(call.status, 'abandoned');
  assert.equal(call.state.data.first_name, 'Ann');
  await server.close();
});
