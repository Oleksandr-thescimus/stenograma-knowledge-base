import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Starting at login on Linux is a .desktop file in ~/.config/autostart: app.setLoginItemSettings does nothing there
// (docs/PLAN.md, The app). It starts the app with --hidden, in the tray. No Electron here, so the tests run it

export const HIDDEN_ARG = '--hidden';
const FILE_NAME = 'stenograma-kb.desktop';
// Marks the file as this app's, so turning it off never removes someone else's
const MARK = 'X-Stenograma-KB=true';

export const autostartPath = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'autostart', FILE_NAME);

// An Exec argument as the Desktop Entry spec quotes it: in double quotes, with ", `, $ and \ escaped. The .deb's path
// has a space (/opt/Stenograma KB/stenograma-kb)
export const quoteExecArg = (arg: string) => `"${arg.replace(/(["`$\\])/g, '\\$1')}"`;

export const desktopEntry = (executable: string) => `[Desktop Entry]
Type=Application
Name=Stenograma KB
Comment=Keeps the knowledge base syncing in the tray
Exec=${quoteExecArg(executable)} ${HIDDEN_ARG}
Terminal=false
X-GNOME-Autostart-enabled=true
${MARK}
`;

// Writes the file when on (again each start: an AppImage may have moved), removes this app's file when off
export const syncAutostart = (enabled: boolean, executable: string, path = autostartPath()) => {
  if (enabled) {
    const entry = desktopEntry(executable);

    if (!existsSync(path) || readFileSync(path, 'utf8') !== entry) {
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, entry);
    }
  } else if (existsSync(path) && readFileSync(path, 'utf8').includes(MARK)) {
    rmSync(path);
  }
};
