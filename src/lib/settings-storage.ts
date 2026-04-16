import type { AppSettings } from "./types";

export function saveSettingsToCookie(settings: AppSettings) {
  try {
    const json = JSON.stringify(settings);
    const encoded = encodeURIComponent(json);
    document.cookie = `fx-settings=${encoded}; max-age=${60 * 60 * 24 * 365}; path=/; SameSite=Lax`;
  } catch {}
}

export function loadSettingsFromCookie(): AppSettings | null {
  try {
    const match = document.cookie.match(/fx-settings=([^;]+)/);
    if (match) {
      return JSON.parse(decodeURIComponent(match[1]));
    }
  } catch {}
  return null;
}

export const loadSettings = (): AppSettings => {
  try {
    const stored = localStorage.getItem("fx-settings-v2");
    if (stored) return JSON.parse(stored);
  } catch {}
  try {
    const stored = sessionStorage.getItem("fx-settings-v2");
    if (stored) return JSON.parse(stored);
  } catch {}
  const fromCookie = loadSettingsFromCookie();
  if (fromCookie && fromCookie.anthropicApiKey) return fromCookie;
  return {
    twelveDataApiKey: "",
    anthropicApiKey: "",
    defaultStopLossPips: 30,
    defaultTakeProfitPips: 60,
    currencyPair: "USD/JPY",
  };
};

export const saveSettings = (s: AppSettings) => {
  const json = JSON.stringify(s);
  try { localStorage.setItem("fx-settings-v2", json); } catch {}
  try { sessionStorage.setItem("fx-settings-v2", json); } catch {}
  saveSettingsToCookie(s);
};
