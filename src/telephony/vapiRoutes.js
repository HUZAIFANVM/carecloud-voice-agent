const crypto = require('crypto');
const express = require('express');

/**
 * Telephony adapter for Vapi (free US number + $10 trial credit, no phone verification).
 *
 * Vapi owns the phone line, speech-to-text and text-to-speech. Our server is configured
 * as the assistant's "Custom LLM": Vapi POSTs OpenAI-style /chat/completions requests
 * here on every caller turn, and we answer through the same conversation service the
 * browser simulator uses. So validation, read-back and DB writes stay ours.
 *
 * Call ending: our closing lines end with "Goodbye" / "Adiós", which the assistant's
 * endCallPhrases setting turns into a hang-up (see README).
 */
function createVapiRouter({ conversation, calls, config, log }) {
  const router = express.Router();

  const requireSecret = (req, res, next) => {
    if (!config.vapi.secret) return next();
    const header = req.header('authorization') || '';
    // Accepted from the URL path (/vapi/k/<secret>/...), a Bearer token, or X-Vapi-Secret.
    const provided = req.params.key || header.replace(/^Bearer\s+/i, '') || req.header('x-vapi-secret') || '';
    const a = Buffer.from(provided);
    const b = Buffer.from(config.vapi.secret);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
    log('vapi_auth_rejected', { path: req.path });
    return res.status(401).json({ error: 'unauthorized' });
  };

  const contentText = content => (Array.isArray(content)
    ? content.map(part => (typeof part === 'string' ? part : part?.text || '')).join(' ')
    : String(content || ''));

  function sendCompletion(req, res, reply) {
    const id = `chatcmpl-${crypto.randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const model = req.body?.model || 'carecloud-intake-agent';
    if (req.body?.stream === false) {
      return res.json({
        id, object: 'chat.completion', created, model,
        choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }]
      });
    }
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const chunk = (delta, finish = null) =>
      `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    res.write(chunk({ role: 'assistant', content: reply }));
    res.write(chunk({}, 'stop'));
    res.end('data: [DONE]\n\n');
  }

  async function chatCompletions(req, res, next) {
    try {
      const vapiCall = req.body?.call || {};
      const callSid = `VAPI-${vapiCall.id || req.body?.metadata?.callId || 'unknown'}`;
      const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
      const last = messages[messages.length - 1];

      if (!calls.get(callSid)) {
        // The assistant's firstMessage (our greeting) was already spoken by Vapi.
        conversation.start({ callSid, channel: 'phone', fromNumber: vapiCall.customer?.number || null });
      }
      if (!last || last.role !== 'user') {
        return sendCompletion(req, res, calls.get(callSid).state.last_prompt);
      }
      const result = await conversation.turn(callSid, contentText(last.content));
      sendCompletion(req, res, result.reply);
    } catch (error) {
      log('vapi_completion_error', { error: error.message, stack: error.stack });
      if (res.headersSent) return res.end();
      next(error);
    }
  }

  // Vapi appends /chat/completions to the configured URL; accept both forms, with the
  // secret either in the path (what scripts/setup-vapi.js configures) or as a header.
  router.post(['/vapi/chat/completions', '/vapi', '/vapi/k/:key/chat/completions', '/vapi/k/:key'], requireSecret, chatCompletions);

  // Assistant "Server URL": end-of-call reports mark dropped / unfinished calls as abandoned.
  router.post(['/vapi/webhook', '/vapi/k/:key/webhook'], requireSecret, (req, res) => {
    const message = req.body?.message || {};
    const callId = message.call?.id;
    if (callId && (message.type === 'end-of-call-report' || (message.type === 'status-update' && message.status === 'ended'))) {
      conversation.end(`VAPI-${callId}`, message.endedReason || 'ended');
    }
    res.json({});
  });

  return router;
}

module.exports = { createVapiRouter };
