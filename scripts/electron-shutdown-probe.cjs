// Real Electron + preload + ConPTY regression. No native components are mocked.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const receipt = { events: [], outputBytes: 0, ok: false };
const save = () => fs.writeFileSync(process.env.SC_SHUTDOWN_RECEIPT, JSON.stringify(receipt, null, 2));
const fail = (error) => {
  receipt.error = String(error.stack || error);
  save();
  app.exit(1);
};
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
let finishing = false;
app.on('before-quit', (event) => {
  event.preventDefault();
  if (finishing) return;
  finishing = true;
  // Keep the real event loop alive long enough for pending native callbacks.
  setTimeout(() => {
    receipt.ok = receipt.outputBytes > 0 && receipt.events.includes('closed');
    save();
    app.exit(receipt.ok ? 0 : 1);
  }, 750);
});
require(path.resolve(process.env.SC_SHUTDOWN_ENTRY || 'dist-electron/electron/main.js'));
app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) throw new Error('actual application window missing');
  win.on('closed', () => receipt.events.push('closed'));
  await new Promise((resolve, reject) => {
    win.webContents.once('did-finish-load', resolve);
    win.webContents.once('did-fail-load', (_event, code, description) => reject(new Error(`${code}: ${description}`)));
  });
  receipt.events.push('renderer-loaded');
  receipt.outputBytes = await win.webContents.executeJavaScript(`new Promise(resolve => {
    let output = '';
    const stop = window.selfconnect.onPtyData(data => {
      output += data;
      if (output.includes(${JSON.stringify('\r\nSCE_SHUTDOWN_OUTPUT\r\n')})) {
        stop(); resolve(output.length);
      }
    });
    window.selfconnect.ptyInput(${JSON.stringify('for /l %i in (1,1,5000) do @echo SCE_SHUTDOWN_OUTPUT\r')});
  })`);
  receipt.events.push('native-output-observed');
  win.close();
}).catch(fail);
setTimeout(() => fail(new Error('shutdown probe timeout')), 15000).unref();
