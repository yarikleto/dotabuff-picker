/**
 * The application menu.
 *
 * Built from Electron's roles wherever one exists, so every item arrives with
 * the accelerator and the label the platform already expects — Cmd+Q on macOS,
 * Alt+F4 on Windows, "Preferences" where that is the local word for it.
 *
 * The app's own keyboard shortcuts are all bare keys and it ignores anything
 * held with Cmd or Ctrl (see the `keydown` handler in src/App.tsx), so nothing
 * here shadows them.
 */

import { Menu, app, dialog, shell } from "electron";

const isMac = process.platform === "darwin";

const LINKS = {
  dotabuff: "https://www.dotabuff.com/heroes",
  opendota: "https://www.opendota.com/",
};

/** Versions worth knowing when a bug report says "it just closes". */
function aboutText() {
  return [
    `Version ${app.getVersion()}`,
    `Electron ${process.versions.electron} · Chromium ${process.versions.chrome}`,
    "",
    "Matchups from Dotabuff, synergies and game length from OpenDota.",
    "Dota 2 is a registered trademark of Valve Corporation.",
  ].join("\n");
}

function showAbout(window) {
  dialog.showMessageBox(window ?? undefined, {
    type: "info",
    title: `About ${app.getName()}`,
    message: app.getName(),
    detail: aboutText(),
    buttons: ["OK"],
  });
}

export function buildMenu() {
  // macOS puts About/Quit in the app menu; everywhere else they live in File
  // and Help, which is why the two branches are not symmetrical.
  app.setAboutPanelOptions({
    applicationName: app.getName(),
    applicationVersion: app.getVersion(),
    version: `Electron ${process.versions.electron}`,
    credits: "Matchups from Dotabuff · synergies and game length from OpenDota",
  });

  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        { label: "Dotabuff heroes", click: () => shell.openExternal(LINKS.dotabuff) },
        { label: "OpenDota", click: () => shell.openExternal(LINKS.opendota) },
        ...(isMac
          ? []
          : [
              { type: "separator" },
              { label: `About ${app.getName()}`, click: (_item, window) => showAbout(window) },
            ]),
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}
