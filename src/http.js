#!/usr/bin/env node

import http from "node:http";
import { URL } from "node:url";
import {
  fetchSensorValues,
  formatValue,
  normalizeText,
  selectStationsByQuery
} from "./core.js";

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload)
  });
  res.end(payload);
}

function parseMaxResults(value, fallback) {
  if (!value) return fallback;
  const parsed = Number(value);
  if (Number.isNaN(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, 100);
}

function toStationPayload(entry) {
  return {
    idstazione: entry.idstazione,
    nomestaz: entry.nomestaz,
    value: entry.value,
    value_formatted: formatValue(entry.value),
    soglia1: entry.soglia1 ?? 0,
    soglia2: entry.soglia2 ?? 0,
    soglia3: entry.soglia3 ?? 0,
    lat: entry.lat,
    lon: entry.lon
  };
}

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    sendJson(res, 400, { error: "Missing URL" });
    return;
  }

  const url = new URL(req.url, "http://localhost");
  const pathname = url.pathname;

  if (pathname === "/") {
    sendJson(res, 200, {
      name: "mcp_fiumi_romagna",
      status: "ok",
      endpoints: {
        health: "/health",
        stazioni: "/stazioni",
        livello_idrometrico: "/livello-idrometrico?fiume=Lamone"
      }
    });
    return;
  }

  if (pathname === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (pathname === "/livello-idrometrico") {
    const fiume = url.searchParams.get("fiume");
    if (!fiume) {
      sendJson(res, 400, { error: "Missing required query param: fiume" });
      return;
    }

    try {
      const { ts, data } = await fetchSensorValues();
      const entries = data.filter((item) => item.nomestaz);
      const { matches, suggestions } = selectStationsByQuery(entries, fiume);
      const maxResults = parseMaxResults(
        url.searchParams.get("max_results"),
        10
      );

      sendJson(res, 200, {
        query: fiume,
        timestamp_ms: ts,
        timestamp_iso: new Date(ts).toISOString(),
        matches: matches.slice(0, maxResults).map(toStationPayload),
        suggestions: suggestions.map((entry) => entry.nomestaz)
      });
    } catch (error) {
      sendJson(res, 500, {
        error: "Failed to fetch sensor values",
        detail: error instanceof Error ? error.message : String(error)
      });
    }
    return;
  }

  if (pathname === "/stazioni") {
    try {
      const { data } = await fetchSensorValues();
      const entries = data.filter((item) => item.nomestaz);
      const filtro = url.searchParams.get("filtro");
      const maxResults = parseMaxResults(
        url.searchParams.get("max_results"),
        50
      );
      const normalized = filtro ? normalizeText(filtro) : null;
      const filtered = normalized
        ? entries.filter((entry) =>
            normalizeText(entry.nomestaz || "").includes(normalized)
          )
        : entries;

      sendJson(res, 200, {
        count: Math.min(filtered.length, maxResults),
        stations: filtered.slice(0, maxResults).map(toStationPayload)
      });
    } catch (error) {
      sendJson(res, 500, {
        error: "Failed to fetch station list",
        detail: error instanceof Error ? error.message : String(error)
      });
    }
    return;
  }

  sendJson(res, 404, { error: "Not found" });
});

const port = Number(process.env.PORT || 8787);
server.listen(port, () => {
  console.log(`HTTP server listening on :${port}`);
});
