// The extension's manifest (MV3). Kept in code so the version comes from package.json. There is no built-in
// CardLedger URL: the user sets it in the popup's Settings and its host permission is requested then.

const ICONS = { 16: "icons/icon-16.png", 32: "icons/icon-32.png", 48: "icons/icon-48.png", 128: "icons/icon-128.png" };

/**
 * `production`: no localhost / 127.0.0.1 host permissions (a dev CardLedger is then requested at runtime from the
 * popup's Settings, like any other origin).
 */
export function manifest(version, { production = false } = {}) {
  const hosts = [
    "https://www.cardmarket.com/*",
    "https://www.cardtrader.com/*",
    ...(production ? [] : ["http://localhost/*", "http://127.0.0.1/*"]),
  ];
  return {
    manifest_version: 3,
    name: "CardLedger Sync",
    description: "Syncs your CardLedger listings and orders with Cardmarket and CardTrader, only when you press Sync.",
    version,
    // The CardLedger mark (src/icons/icon.svg, from the brand mockup); Chrome wants PNGs here, they are in src/public/icons.
    icons: ICONS,
    minimum_chrome_version: "120",
    action: { default_title: "CardLedger Sync", default_popup: "popup/index.html", default_icon: ICONS },
    background: { service_worker: "background.js", type: "module" },
    // storage: token and settings; scripting: the Cardmarket and CardTrader agents and the CardLedger page bridge (registered for
    // the configured CardLedger origin at runtime). No alarms: nothing runs unless the user asks.
    permissions: ["storage", "scripting"],
    host_permissions: hosts,
    // The CardLedger origin: requested from the popup's Settings when saved.
    optional_host_permissions: ["https://*/*", "http://*/*"],
  };
}
