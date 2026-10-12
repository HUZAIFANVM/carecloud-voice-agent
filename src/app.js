const path = require('path');
const express = require('express');
const cors = require('cors');
const { openDatabase } = require('./db');
const { log: defaultLog } = require('./logger');
const { createPatientService } = require('./services/patientService');
const { createCallStore } = require('./services/callStore');
const { createConversationService } = require('./services/conversationService');
const { createLlmClient } = require('./agent/llm');
const { createAgent } = require('./agent/agent');
const { createPatientsRouter, envelope } = require('./routes/patients');
const { createCallsRouter } = require('./routes/calls');
const { createVapiRouter } = require('./telephony/vapiRoutes');

/**
 * Composition root. Everything is injected so tests can pass an in-memory DB and a
 * fake LLM. Layers: telephony (Vapi) -> conversation -> agent (LLM) -> patient service -> SQLite.
 */
function createApp(config, overrides = {}) {
  const log = overrides.log || defaultLog;
  const db = overrides.db || openDatabase(config.databasePath, { seedData: config.seedData });
  const patients = createPatientService(db);
  const calls = createCallStore(db);
  const llm = overrides.llm || createLlmClient(config.llm);
  const agent = createAgent({ patients, llm, log });
  const conversation = createConversationService({ agent, calls, log });

  const app = express();
  app.disable('x-powered-by');
  app.use(cors());
  app.use(express.json({ limit: '100kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/health', (_req, res) => res.json(envelope({
    status: 'ok', llm: llm.enabled ? llm.model : 'scripted-fallback', phone_number: config.publicPhoneNumber || null
  })));
  app.use('/patients', createPatientsRouter({ patients, log }));
  app.use(createCallsRouter({ calls, conversation }));
  app.use(createVapiRouter({ conversation, calls, config, log }));

  app.use((_req, res) => res.status(404).json(envelope(null, { code: 'NOT_FOUND', message: 'Route not found' })));
  // eslint-disable-next-line no-unused-vars
  app.use((error, _req, res, _next) => {
    if (error.type === 'entity.parse.failed') {
      return res.status(400).json(envelope(null, { code: 'BAD_REQUEST', message: 'Malformed JSON body' }));
    }
    if (error.type === 'entity.too.large') {
      return res.status(413).json(envelope(null, { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large' }));
    }
    log('unhandled_error', { error: error.message, stack: error.stack });
    res.status(500).json(envelope(null, { code: 'INTERNAL_ERROR', message: 'Something went wrong' }));
  });

  return { app, db, llm };
}

module.exports = { createApp };
