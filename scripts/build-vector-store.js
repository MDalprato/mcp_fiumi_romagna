#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchSensorValues, formatValue } from "../src/core.js";
import {
  openaiAddFileToVectorStore,
  openaiCreateVectorStore,
  openaiUploadFile
} from "../src/openai.js";

const VECTOR_STORE_NAME =
  process.env.OPENAI_VECTOR_STORE_NAME || "mcp-fiumi-romagna";

async function buildStationsFile(entries) {
  const lines = entries.map((entry) => {
    const value = formatValue(entry.value);
    const soglia1 = entry.soglia1 ?? 0;
    const soglia2 = entry.soglia2 ?? 0;
    const soglia3 = entry.soglia3 ?? 0;
    return [
      `Stazione: ${entry.nomestaz}.`,
      `ID: ${entry.idstazione}.`,
      `Valore: ${value}.`,
      `Soglie: ${soglia1}/${soglia2}/${soglia3}.`,
      `Lat: ${entry.lat}.`,
      `Lon: ${entry.lon}.`
    ].join(" ");
  });

  return lines.join("\n") + "\n";
}

async function main() {
  const { data } = await fetchSensorValues();
  const entries = data.filter((item) => item.nomestaz);
  if (entries.length === 0) {
    throw new Error("No stations found in sensor data");
  }

  const content = await buildStationsFile(entries);
  const dataDir = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "data"
  );
  await mkdir(dataDir, { recursive: true });
  const filePath = join(dataDir, "stazioni.txt");
  await writeFile(filePath, content, "utf8");

  const uploaded = await openaiUploadFile({
    buffer: Buffer.from(content, "utf8"),
    filename: "stazioni.txt",
    purpose: "assistants"
  });

  let vectorStoreId = process.env.OPENAI_VECTOR_STORE_ID;
  if (!vectorStoreId) {
    const created = await openaiCreateVectorStore({
      name: VECTOR_STORE_NAME
    });
    vectorStoreId = created.id;
  }

  await openaiAddFileToVectorStore(vectorStoreId, uploaded.id);

  console.log(`Vector store ID: ${vectorStoreId}`);
  console.log("Set OPENAI_VECTOR_STORE_ID in your environment to enable retrieval.");
}

main().catch((error) => {
  console.error("Retrieval setup failed:", error);
  process.exit(1);
});
