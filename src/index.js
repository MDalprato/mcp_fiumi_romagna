#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  fetchSensorValues,
  formatValue,
  normalizeText
} from "./core.js";
import { selectStationsByQueryWithRetrieval } from "./retrieval.js";

const LivelloIdrometricoInput = z.object({
  fiume: z.string().min(1),
  max_results: z.number().int().min(1).max(10).optional()
});

const ElencoStazioniInput = z.object({
  filtro: z.string().optional(),
  max_results: z.number().int().min(1).max(50).optional()
});

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

    const { matches, suggestions } = await selectStationsByQueryWithRetrieval(
      entries,
      input.fiume,
      { maxResults: Math.min(input.max_results ?? 5, 5) }
    );

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
