const { app, screen } = require('electron');
const { join } = require('node:path');
app.setPath('userData', join(__dirname, '..', 'build', 'display-probe-userdata'));
app.whenReady().then(() => {
  console.log(JSON.stringify(screen.getAllDisplays().map(display => ({
    id: display.id, label: display.label, bounds: display.bounds,
    scaleFactor: display.scaleFactor, primary: display.id === screen.getPrimaryDisplay().id,
  })), null, 2));
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
