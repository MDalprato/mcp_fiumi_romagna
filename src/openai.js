const OPENAI_BASE_URL =
  process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

function requireApiKey() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY environment variable");
  }
  return apiKey;
}

function isFormDataBody(body) {
  return typeof FormData !== "undefined" && body instanceof FormData;
}

async function openaiRequest(path, { method = "GET", body, headers = {} } = {}) {
  const apiKey = requireApiKey();
  const requestHeaders = {
    Authorization: `Bearer ${apiKey}`,
    ...headers
  };
  const beta = process.env.OPENAI_BETA;
  if (beta) {
    requestHeaders["OpenAI-Beta"] = beta;
  }

  let payload;
  if (body !== undefined) {
    if (isFormDataBody(body)) {
      payload = body;
    } else {
      requestHeaders["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
  }

  const response = await fetch(`${OPENAI_BASE_URL}${path}`, {
    method,
    headers: requestHeaders,
    body: payload
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `OpenAI request failed (${response.status}): ${text || "no body"}`
    );
  }

  return text ? JSON.parse(text) : {};
}

async function openaiUploadFile({ buffer, filename, purpose = "assistants" }) {
  const form = new FormData();
  const blob = new Blob([buffer], { type: "text/plain" });
  form.append("file", blob, filename);
  form.append("purpose", purpose);
  return openaiRequest("/files", { method: "POST", body: form });
}

async function openaiCreateVectorStore({ name }) {
  return openaiRequest("/vector_stores", {
    method: "POST",
    body: { name }
  });
}

async function openaiAddFileToVectorStore(vectorStoreId, fileId) {
  return openaiRequest(`/vector_stores/${vectorStoreId}/files`, {
    method: "POST",
    body: { file_id: fileId }
  });
}

async function openaiCreateResponse(payload) {
  return openaiRequest("/responses", { method: "POST", body: payload });
}

export {
  openaiRequest,
  openaiUploadFile,
  openaiCreateVectorStore,
  openaiAddFileToVectorStore,
  openaiCreateResponse
};
