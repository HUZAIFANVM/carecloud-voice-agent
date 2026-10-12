// Structured JSON-lines logging to stdout so hosting platforms can ingest it as-is.
function log(event, payload = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...payload }));
}

module.exports = { log };
