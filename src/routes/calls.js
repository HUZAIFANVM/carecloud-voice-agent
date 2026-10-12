const crypto = require('crypto');
const express = require('express');
const { envelope } = require('./patients');

/**
 * Call transcripts (read-only) plus a browser "simulator" that drives the exact same
 * conversation service as the phone line, so the agent can be tested for free
 * without placing a call.
 */
function createCallsRouter({ calls, conversation }) {
  const router = express.Router();

  router.get('/calls', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    res.json(envelope(calls.list({ limit })));
  });

  router.get('/calls/:sid', (req, res) => {
    const call = calls.get(req.params.sid);
    if (!call) return res.status(404).json(envelope(null, { code: 'NOT_FOUND', message: 'Call not found' }));
    res.json(envelope(call));
  });

  router.post('/simulator/sessions', (req, res) => {
    const callSid = `SIM-${crypto.randomUUID()}`;
    const { reply, language } = conversation.start({ callSid, channel: 'simulator' });
    res.status(201).json(envelope({ session_id: callSid, reply, language }));
  });

  router.post('/simulator/sessions/:sid/messages', async (req, res, next) => {
    try {
      if (!req.params.sid.startsWith('SIM-') || !calls.get(req.params.sid)) {
        return res.status(404).json(envelope(null, { code: 'NOT_FOUND', message: 'Simulator session not found' }));
      }
      const text = typeof req.body?.text === 'string' ? req.body.text.slice(0, 1000) : '';
      res.json(envelope(await conversation.turn(req.params.sid, text)));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createCallsRouter };
