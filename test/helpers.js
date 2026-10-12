const { createApp } = require('../src/app');
const { openDatabase } = require('../src/db');

const baseConfig = {
  port: 0,
  databasePath: ':memory:',
  seedData: false,

  vapi: { secret: 'test-secret' },
  llm: { baseUrl: 'http://unused', apiKey: '', model: 'fake', timeoutMs: 1000 },
};

/** Fake LLM that returns queued JSON responses (or throws if given an Error). */
function fakeLlm(responses = []) {
  const queue = [...responses];
  const calls = [];
  return {
    enabled: true,
    model: 'fake',
    calls,
    push: (...items) => queue.push(...items),
    async completeJson(messages) {
      calls.push(messages);
      const next = queue.shift();
      if (!next) throw new Error('fake LLM queue empty');
      if (next instanceof Error) throw next;
      return next;
    }
  };
}

async function startTestServer({ llm = { enabled: false }, db } = {}) {
  const { app, db: database } = createApp(baseConfig, { db: db || openDatabase(':memory:'), llm, log: () => {} });
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (method, path, body, headers = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* SSE stream or empty */ }
    return { status: response.status, body: json, text, contentType: response.headers.get('content-type') };
  };
  // Calls a Vapi endpoint the way Vapi does, with the shared secret as a Bearer token.
  const vapi = (path, body, secret = 'test-secret') => request('POST', path, body, { Authorization: `Bearer ${secret}` });
  return { request, vapi, db: database, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}

const validPatient = () => ({
  first_name: 'Jane', last_name: "O'Brien-Smith", date_of_birth: '04/12/1985', sex: 'Female',
  phone_number: '(555) 201-3344', address_line_1: '123 Main St', city: 'Springfield', state: 'il', zip_code: '62701'
});

module.exports = { startTestServer, fakeLlm, validPatient };
