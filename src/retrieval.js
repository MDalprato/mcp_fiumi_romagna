import { normalizeText, selectStationsByQuery } from "./core.js";
import { openaiCreateResponse } from "./openai.js";

const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

function isRetrievalEnabled() {
  return Boolean(
    process.env.OPENAI_API_KEY && process.env.OPENAI_VECTOR_STORE_ID
  );
}

function extractOutputText(response) {
  if (!response || !Array.isArray(response.output)) return "";
  const chunks = response.output
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content || [])
    .filter((part) => part.type === "output_text" && part.text)
    .map((part) => part.text.trim());

  return chunks.join("\n").trim();
}

function parseJsonArray(text) {
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return [];
    try {
      const parsed = JSON.parse(match[0]);
      return Array.isArray(parsed) ? parsed : [];
    } catch (innerError) {
      return [];
    }
  }
}

async function retrieveStationNames(query, maxResults) {
  if (!isRetrievalEnabled()) return [];

  const payload = {
    model: DEFAULT_MODEL,
    input: [
      {
        role: "system",
        content:
          "Return only a JSON array of station names. No extra text or formatting."
      },
      {
        role: "user",
        content: `Query: ${query}. Return up to ${maxResults} station names.`
      }
    ],
    tools: [{ type: "file_search" }],
    tool_resources: {
      file_search: {
        vector_store_ids: [process.env.OPENAI_VECTOR_STORE_ID]
      }
    },
    temperature: 0
  };

  const response = await openaiCreateResponse(payload);
  const outputText = extractOutputText(response);
  const names = parseJsonArray(outputText)
    .map((item) => String(item).trim())
    .filter(Boolean);

  return names.slice(0, maxResults);
}

async function selectStationsByQueryWithRetrieval(
  entries,
  query,
  { maxResults = 5 } = {}
) {
  const local = selectStationsByQuery(entries, query);
  if (local.matches.length > 0 || !isRetrievalEnabled()) {
    return local;
  }

  let retrievedNames = [];
  try {
    retrievedNames = await retrieveStationNames(query, maxResults);
  } catch (error) {
    return local;
  }
  if (retrievedNames.length === 0) {
    return local;
  }

  const normalized = new Set(
    retrievedNames.map((name) => normalizeText(name))
  );
  const matches = entries.filter((entry) =>
    normalized.has(normalizeText(entry.nomestaz || ""))
  );

  if (matches.length > 0) {
    return { matches, suggestions: [] };
  }

  return local;
}

export { isRetrievalEnabled, selectStationsByQueryWithRetrieval };
