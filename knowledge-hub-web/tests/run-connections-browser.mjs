process.env.ATHENA_BROWSER_CHECKS = 'connections';
process.env.TODAY_FIXTURE_URL = process.env.CONNECTIONS_FIXTURE_URL ?? 'http://localhost:5186/tests/connections.html';
await import('./run-today-browser.mjs');
