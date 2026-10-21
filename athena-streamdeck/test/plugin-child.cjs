process.on('message', message => { if (message === 'shutdown') process.exit(0); });
// Keep the actual packaged plugin test isolated from a running Athena Desktop.
const fetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(input);
  if (url.hostname === '127.0.0.1' && url.port === '43129') url.port = process.env.ATHENA_TEST_BRIDGE_PORT;
  return fetch(url, options);
};
import(process.argv[2]).catch(error => { console.error(error); process.exit(1); });
