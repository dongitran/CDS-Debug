'use strict';

const express = require('express');
const { version } = require('./package.json');

const app = express();
const PORT = process.env.PORT ?? 8080;
const START_TIME = Date.now();

app.use(express.json());

app.get('/health/ping', (_req, res) => {
  res.json({ result: 'pong' });
});

app.get('/health/status', (_req, res) => {
  res.json({
    status: 'UP',
    version,
    uptime: Math.floor((Date.now() - START_TIME) / 1000),
  });
});

// Intentional pause — breakpoint-friendly endpoint for testing remote debug
app.get('/health/debug-me', (_req, res) => {
  const ts = new Date().toISOString();
  // set a breakpoint on the line below and attach VS Code debugger
  const message = `debug hit at ${ts}`;
  res.json({ message });
});

app.listen(PORT, () => {
  process.stdout.write(`demo-health-svc listening on port ${PORT}\n`);
});
