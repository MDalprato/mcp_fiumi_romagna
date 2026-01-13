#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const SENSOR_VALUES_URL =
  "https://allertameteo.regione.emilia-romagna.it/o/api/allerta/get-sensor-values-no-time";
const IDROMETRICO_VARIABILE = "254,0,0/1,-,-,-/B13215";

const LivelloIdrometricoInput = z.object({
  fiume: z.string().min(1),
  max_results: z.number().int().min(1).max(10).optional()
});

const ElencoStazioniInput = z.object({
  filtro: z.string().optional(),
  max_results: z.number().int().min(1).max(50).optional()
});

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

function formatStationsOutput(entries, maxResults) {
  const limited = maxResults ? entries.slice(0, maxResults) : entries;
  return limited
    .map((entry) => {
      const value = formatValue(entry.value);
      const soglia1 = entry.soglia1 ?? 0;
      const soglia2 = entry.soglia2 ?? 0;
      const soglia3 = entry.soglia3 ?? 0;
      return `- ${entry.nomestaz}: ${value} (soglie ${soglia1}/${soglia2}/${soglia3})`;
    })
    .join("\n");
}

const server = new Server(
  {
    name: "mcp-fiumi-romagna",
    version: "0.1.0"
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "livello_idrometrico",
      description:
        "Restituisce il livello idrometrico corrente per un fiume o una stazione.",
      inputSchema: {
        type: "object",
        properties: {
          fiume: {
            type: "string",
            description: "Nome del fiume o della stazione (es. 'Ronco', 'Ponte Uso')."
          },
          max_results: {
            type: "integer",
            description: "Limite massimo risultati (default: tutti)."
          }
        },
        required: ["fiume"]
      }
    },
    {
      name: "elenco_stazioni_idrometriche",
      description:
        "Elenca le stazioni idrometriche disponibili, con filtro opzionale.",
      inputSchema: {
        type: "object",
        properties: {
          filtro: {
            type: "string",
            description: "Filtro testo per nome stazione."
          },
          max_results: {
            type: "integer",
            description: "Limite massimo risultati (default: 50)."
          }
        }
      }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "livello_idrometrico") {
    const input = LivelloIdrometricoInput.parse(request.params.arguments);
    const { ts, data } = await fetchSensorValues();
    const entries = data.filter((item) => item.nomestaz);

    const { matches, suggestions } = selectStationsByQuery(entries, input.fiume);

    if (matches.length === 0) {
      const messageLines = [
        `Nessuna stazione trovata per: "${input.fiume}".`
      ];
      if (suggestions.length > 0) {
        messageLines.push("Possibili stazioni vicine:");
        messageLines.push(
          suggestions.map((entry) => `- ${entry.nomestaz}`).join("\n")
        );
      }
      return {
        content: [{ type: "text", text: messageLines.join("\n") }]
      };
    }

    const timeInfo = new Date(ts).toISOString();
    const maxResults = input.max_results;
    const output = [
      `Livello idrometrico (timestamp richiesta ${timeInfo}) per "${input.fiume}":`,
      formatStationsOutput(matches, maxResults)
    ].join("\n");

    return {
      content: [{ type: "text", text: output }]
    };
  }

  if (request.params.name === "elenco_stazioni_idrometriche") {
    const input = ElencoStazioniInput.parse(request.params.arguments || {});
    const { data } = await fetchSensorValues();
    const entries = data.filter((item) => item.nomestaz);
    const filtro = input.filtro ? normalizeText(input.filtro) : null;
    const filtered = filtro
      ? entries.filter((entry) =>
          normalizeText(entry.nomestaz || "").includes(filtro)
        )
      : entries;

    const maxResults = input.max_results ?? 50;
    const listed = filtered.slice(0, maxResults);
    const output = listed.map((entry) => `- ${entry.nomestaz}`).join("\n");

    return {
      content: [
        {
          type: "text",
          text:
            output || "Nessuna stazione disponibile con il filtro indicato."
        }
      ]
    };
  }

  return {
    content: [
      { type: "text", text: `Tool non riconosciuto: ${request.params.name}` }
    ]
  };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
