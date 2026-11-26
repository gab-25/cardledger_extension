// Options: the CardLedger URL (asking for its host permission when it's a new origin). The games to read on each
// market are decided by CardLedger (the plan's `games`).

import { normalizeBaseUrl } from "../api/cardledger";
import { getSettings, hostPattern, saveAuth, saveSettings } from "../storage";

const form = document.getElementById("form") as HTMLFormElement;
const url = document.getElementById("url") as HTMLInputElement;
const saved = document.getElementById("saved")!;

async function load() {
  const settings = await getSettings();
  url.value = settings.baseUrl;
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  saved.textContent = "";
  saved.className = "small";
  let baseUrl: string;
  try {
    baseUrl = normalizeBaseUrl(url.value);
  } catch {
    saved.textContent = "Not a valid URL.";
    saved.className = "small err";
    return;
  }
  // Must run in the click's user gesture: no await before it.
  const granted = await chrome.permissions.request({ origins: [hostPattern(baseUrl)] });
  if (!granted) {
    saved.textContent = "Permission refused: the extension can't reach this URL.";
    saved.className = "small err";
    return;
  }
  const before = await getSettings();
  await saveSettings({ baseUrl });
  if (before.baseUrl !== baseUrl) await saveAuth(null); // the token belongs to the previous CardLedger
  saved.textContent = before.baseUrl !== baseUrl ? "Saved. Pair again from the extension popup." : "Saved.";
  saved.className = "small ok";
});

void load();
