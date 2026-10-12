const config = require('./config');
const { createApp } = require('./app');
const { log } = require('./logger');

const { app, db, llm } = createApp(config);

const server = app.listen(config.port, () => {
  log('server_started', {
    url: `http://localhost:${config.port}`,
    database: config.databasePath,
    llm: llm.enabled ? `${config.llm.model} @ ${config.llm.baseUrl}` : 'none (scripted fallback; set LLM_API_KEY)'
  });
});

function shutdown(signal) {
  log('server_stopping', { signal });
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
