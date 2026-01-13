const SENSOR_VALUES_URL =
  "https://allertameteo.regione.emilia-romagna.it/o/api/allerta/get-sensor-values-no-time";
const IDROMETRICO_VARIABILE = "254,0,0/1,-,-,-/B13215";

function normalizeText(value) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function stripGenericWords(value) {
  return value
    .replace(/\b(fiume|torrente|rio|canale|fosso)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isDst(date) {
  const year = date.getFullYear();
  const jan = new Date(year, 0, 1);
  const jul = new Date(year, 6, 1);
  const maxOffset = Math.max(jan.getTimezoneOffset(), jul.getTimezoneOffset());
  return date.getTimezoneOffset() < maxOffset;
}

function getTimestampMs() {
  const now = new Date();
  const minutes = now.getMinutes() < 31 ? 0 : 30;
  const rounded = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    now.getHours(),
    minutes,
    0,
    0
  );

  if (isDst(rounded)) {
    rounded.setHours(rounded.getHours() - 1);
  }

  rounded.setMinutes(rounded.getMinutes() + 30);
  return rounded.getTime();
}

async function fetchSensorValues() {
  const ts = getTimestampMs();
  const url = `${SENSOR_VALUES_URL}?variabile=${encodeURIComponent(
    IDROMETRICO_VARIABILE
  )}&time=${ts}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    const data = await resp.json();
    return { ts, data };
  } finally {
    clearTimeout(timeout);
  }
}

function formatValue(value) {
  if (value === null || value === undefined) {
    return "dato non disponibile";
  }
  if (typeof value === "number") {
    return `${value.toFixed(2)} m`;
  }
  const parsed = Number(value);
  if (!Number.isNaN(parsed)) {
    return `${parsed.toFixed(2)} m`;
  }
  return String(value);
}

function selectStationsByQuery(entries, query) {
  const cleaned = normalizeText(stripGenericWords(query));
  if (!cleaned) {
    return { matches: [], suggestions: [] };
  }

  const tokens = cleaned.split(" ").filter(Boolean);
  const matches = entries.filter((entry) => {
    const name = normalizeText(entry.nomestaz || "");
    return tokens.every((token) => name.includes(token));
  });

  if (matches.length > 0) {
    return { matches, suggestions: [] };
  }

  const suggestions = entries
    .map((entry) => {
      const name = normalizeText(entry.nomestaz || "");
      const score = tokens.reduce((acc, token) => {
        if (name.includes(token)) return acc + 1;
        return acc;
      }, 0);
      return { entry, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((item) => item.entry);

  return { matches: [], suggestions };
}

export {
  SENSOR_VALUES_URL,
  IDROMETRICO_VARIABILE,
  normalizeText,
  stripGenericWords,
  getTimestampMs,
  fetchSensorValues,
  formatValue,
  selectStationsByQuery
};
