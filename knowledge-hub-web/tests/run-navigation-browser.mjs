process.env.ATHENA_BROWSER_CHECKS = 'navigation';
process.env.TODAY_FIXTURE_URL = process.env.NAVIGATION_FIXTURE_URL ?? 'http://localhost:5142/tests/navigation.html';
await import('./run-today-browser.mjs');
