'use strict';
// Start with Windows (wave 3, BUSINESS-DESIGN.md section 7; the server's side is lib/routes/services.mjs). Two messages and no hooks:
//   autostart-get          -> { type: 'autostart-get-result', id, supported, on }
//   autostart-set { on }   -> { type: 'autostart-set-result', id, supported, on, ok }
// It uses Electron's login item with the argument --background: started that way, desktop/main.cjs keeps Plenum in the tray and shows no
// window until the person opens it. supported is true only in the INSTALLED app on Windows: a development copy would register
// electron.exe itself, and the portable and zip builds are packaged too but have no fixed place (the portable one runs from a
// temporary folder that is gone when it closes, so the login item would name a program that is no longer there). The installed copy
// is told as desktop/handlers/app-update.cjs tells it: the installer's "Uninstall Plenum.exe" lies beside the program.
// Off until the person turns it on; nothing here runs unless the server asks. Nothing is logged.
// A start from inside another packaged app (a Claude session) sees a private copy of the registry, so only a real sign-in to Windows
// proves this setting.
const fs = require('node:fs');
const path = require('node:path');

const ARGS = ['--background'];
const UNINSTALLER = 'Uninstall Plenum.exe';

// shell.platform, shell.execPath and shell.env are for the tests; the desktop app's shell has none of them, so the process's own count.
function installed(shell) {
  if ((shell.env ?? process.env).PORTABLE_EXECUTABLE_FILE) return false;
  try {
    return fs.existsSync(path.join(path.dirname(shell.execPath ?? process.execPath), UNINSTALLER));
  } catch {
    return false;
  }
}
const supported = shell => shell.app.isPackaged === true && (shell.platform ?? process.platform) === 'win32' && installed(shell);

// What Windows holds now for this app with this argument. A read that fails counts as off.
function read(shell) {
  if (!supported(shell)) return { supported: false, on: false };
  let on = false;
  try {
    on = shell.app.getLoginItemSettings({ args: ARGS }).openAtLogin === true;
  } catch {
    on = false;
  }
  return { supported: true, on };
}

module.exports = {
  name: 'autostart',
  messages: {
    'autostart-get': async (message, shell) => {
      if (typeof message.id !== 'string') return undefined;
      return read(shell);
    },
    'autostart-set': async (message, shell) => {
      if (typeof message.id !== 'string') return undefined;
      if (!supported(shell)) return { supported: false, on: false, ok: false };
      if (typeof message.on !== 'boolean') return { ...read(shell), ok: false };
      shell.app.setLoginItemSettings({ openAtLogin: message.on, args: ARGS });
      const now = read(shell);
      return { ...now, ok: now.on === message.on };
    },
  },
};
