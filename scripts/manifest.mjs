// The extension's manifest (MV3). Kept in code so the version and the default CardLedger URL come from the build.

/** Host permission pattern of an origin, any port ("http://localhost:5173" -> "http://localhost/*"). */
export function hostPattern(url) {
  const u = new URL(url);
  return `${u.protocol}//${u.hostname}/*`;
}

const ICONS = { 16: "icons/icon-16.png", 32: "icons/icon-32.png", 48: "icons/icon-48.png", 128: "icons/icon-128.png" };

export function manifest(version, defaultUrlJson) {
  const defaultUrl = JSON.parse(defaultUrlJson);
  const hosts = new Set([
    "https://www.cardmarket.com/*",
    "https://www.cardtrader.com/*",
    "http://localhost/*",
    "http://127.0.0.1/*",
    hostPattern(defaultUrl),
  ]);
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
    host_permissions: [...hosts],
    // A CardLedger served elsewhere: its origin is requested from the popup's Settings when saved.
    optional_host_permissions: ["https://*/*", "http://*/*"],
  };
}
