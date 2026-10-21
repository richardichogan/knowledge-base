process.on('message', message => { if (message === 'shutdown') process.exit(0); });
import(process.argv[2]).catch(error => { console.error(error); process.exit(1); });
