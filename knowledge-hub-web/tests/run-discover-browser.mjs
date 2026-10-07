process.env.ATHENA_BROWSER_CHECKS = 'discover';
process.env.TODAY_FIXTURE_URL = process.env.DISCOVER_FIXTURE_URL ?? 'http://localhost:5186/tests/discover.html';
await import('./run-today-browser.mjs');
