// Options: the CardLedger URL (asking for its host permission when it's a new origin) and the Cardmarket games.

import { normalizeBaseUrl } from "../api/cardledger";
import { CM_GAMES } from "../markets/cardmarket/format";
import { getSettings, hostPattern, saveAuth, saveSettings } from "../storage";
import { h } from "../ui/dom";

const form = document.getElementById("form") as HTMLFormElement;
const url = document.getElementById("url") as HTMLInputElement;
const games = document.getElementById("games")!;
const saved = document.getElementById("saved")!;

async function load() {
  const settings = await getSettings();
  url.value = settings.baseUrl;
  games.replaceChildren(
    ...Object.entries(CM_GAMES).map(([slug, name]) =>
      h("label", { class: "small" },
        h("input", { type: "checkbox", name: "game", value: slug, checked: settings.cmGames.includes(slug) }),
        ` ${name}`),
    ),
  );
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
  const cmGames = [...games.querySelectorAll<HTMLInputElement>("input[name=game]:checked")].map((i) => i.value);
  const before = await getSettings();
  await saveSettings({ baseUrl, cmGames });
  if (before.baseUrl !== baseUrl) await saveAuth(null); // the token belongs to the previous CardLedger
  saved.textContent = before.baseUrl !== baseUrl ? "Saved. Pair again from the extension popup." : "Saved.";
  saved.className = "small ok";
});

void load();
