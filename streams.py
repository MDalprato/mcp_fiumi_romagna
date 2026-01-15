"""
FastMCP server for Emilia-Romagna river level data.
"""

from __future__ import annotations

import json
import os
import re
import time
import unicodedata
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable, Tuple
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from fastmcp import FastMCP

SENSOR_VALUES_URL = (
    "https://allertameteo.regione.emilia-romagna.it/o/api/allerta/"
    "get-sensor-values-no-time"
)
IDROMETRICO_VARIABILE = "254,0,0/1,-,-,-/B13215"
REQUEST_TIMEOUT_SEC = 10
OPENAI_BASE_URL = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1")
OPENAI_DEFAULT_MODEL = os.getenv("OPENAI_MODEL", "gpt-4.1-mini")

mcp = FastMCP("mcp-fiumi-romagna")


def normalize_text(value: str) -> str:
    if value is None:
        return ""
    text = unicodedata.normalize("NFD", str(value))
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Mn")
    text = text.lower()
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return text.strip()


def strip_generic_words(value: str) -> str:
    if value is None:
        return ""
    text = re.sub(
        r"\b(fiume|torrente|rio|canale|fosso)\b",
        " ",
        str(value),
        flags=re.IGNORECASE,
    )
    return re.sub(r"\s+", " ", text).strip()


def _is_dst_local(dt: datetime) -> bool:
    timestamp = time.mktime(dt.timetuple())
    return time.localtime(timestamp).tm_isdst > 0


def _timezone_offset_minutes(dt: datetime) -> int:
    is_dst = _is_dst_local(dt)
    if is_dst and time.daylight:
        offset = time.altzone
    else:
        offset = time.timezone
    return int(offset / 60)


def is_dst(dt: datetime) -> bool:
    year = dt.year
    jan = datetime(year, 1, 1)
    jul = datetime(year, 7, 1)
    max_offset = max(_timezone_offset_minutes(jan), _timezone_offset_minutes(jul))
    return _timezone_offset_minutes(dt) < max_offset


def get_timestamp_ms() -> int:
    now = datetime.now()
    minutes = 0 if now.minute < 31 else 30
    rounded = now.replace(minute=minutes, second=0, microsecond=0)
    if is_dst(rounded):
        rounded -= timedelta(hours=1)
    rounded += timedelta(minutes=30)
    return int(rounded.timestamp() * 1000)


def fetch_sensor_values() -> Tuple[int, list[dict[str, Any]]]:
    ts = get_timestamp_ms()
    query = urlencode(
        {"variabile": IDROMETRICO_VARIABILE, "time": ts}
    )
    url = f"{SENSOR_VALUES_URL}?{query}"
    request = Request(url, headers={"User-Agent": "mcp-fiumi-romagna"})
    with urlopen(request, timeout=REQUEST_TIMEOUT_SEC) as response:
        status = getattr(response, "status", response.getcode())
        if status != 200:
            raise RuntimeError(f"HTTP {status}")
        payload = response.read().decode("utf-8")
    data = json.loads(payload)
    if not isinstance(data, list):
        raise RuntimeError("Unexpected response format from sensor API")
    return ts, data


def format_value(value: Any) -> str:
    if value is None:
        return "dato non disponibile"
    if isinstance(value, (int, float)):
        return f"{float(value):.2f} m"
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return str(value)
    return f"{parsed:.2f} m"


def select_stations_by_query(
    entries: Iterable[dict[str, Any]], query: str
) -> Tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    cleaned = normalize_text(strip_generic_words(query))
    if not cleaned:
        return [], []
    tokens = [token for token in cleaned.split(" ") if token]
    matches = [
        entry
        for entry in entries
        if all(
            token in normalize_text(entry.get("nomestaz", ""))
            for token in tokens
        )
    ]
    if matches:
        return matches, []

    scored = []
    for entry in entries:
        name = normalize_text(entry.get("nomestaz", ""))
        score = sum(1 for token in tokens if token in name)
        if score > 0:
            scored.append((score, entry))
    scored.sort(key=lambda item: item[0], reverse=True)
    suggestions = [entry for _, entry in scored[:5]]
    return [], suggestions


def _is_retrieval_enabled() -> bool:
    return bool(
        os.getenv("OPENAI_API_KEY") and os.getenv("OPENAI_VECTOR_STORE_ID")
    )


def _openai_create_response(payload: dict[str, Any]) -> dict[str, Any]:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("Missing OPENAI_API_KEY environment variable")

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    beta = os.getenv("OPENAI_BETA")
    if beta:
        headers["OpenAI-Beta"] = beta

    request = Request(
        f"{OPENAI_BASE_URL}/responses",
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    with urlopen(request, timeout=REQUEST_TIMEOUT_SEC) as response:
        status = getattr(response, "status", response.getcode())
        body = response.read().decode("utf-8")
        if status != 200:
            raise RuntimeError(
                f"OpenAI request failed ({status}): {body or 'no body'}"
            )
    return json.loads(body) if body else {}


def _extract_output_text(response: dict[str, Any]) -> str:
    output = response.get("output")
    if not isinstance(output, list):
        return ""
    chunks = []
    for item in output:
        if item.get("type") != "message":
            continue
        for part in item.get("content", []) or []:
            if part.get("type") == "output_text" and part.get("text"):
                chunks.append(part["text"].strip())
    return "\n".join(chunks).strip()


def _parse_json_array(text: str) -> list[Any]:
    if not text:
        return []
    try:
        parsed = json.loads(text)
        return parsed if isinstance(parsed, list) else []
    except json.JSONDecodeError:
        match = re.search(r"\[[\s\S]*\]", text)
        if not match:
            return []
        try:
            parsed = json.loads(match.group(0))
            return parsed if isinstance(parsed, list) else []
        except json.JSONDecodeError:
            return []


def _retrieve_station_names(query: str, max_results: int) -> list[str]:
    if not _is_retrieval_enabled():
        return []

    payload = {
        "model": OPENAI_DEFAULT_MODEL,
        "input": [
            {
                "role": "system",
                "content": (
                    "Return only a JSON array of station names. "
                    "No extra text or formatting."
                ),
            },
            {
                "role": "user",
                "content": (
                    f"Query: {query}. Return up to {max_results} station names."
                ),
            },
        ],
        "tools": [{"type": "file_search"}],
        "tool_resources": {
            "file_search": {
                "vector_store_ids": [os.getenv("OPENAI_VECTOR_STORE_ID")]
            }
        },
        "temperature": 0,
    }

    response = _openai_create_response(payload)
    output_text = _extract_output_text(response)
    names = [
        str(item).strip()
        for item in _parse_json_array(output_text)
        if str(item).strip()
    ]
    return names[:max_results]


def select_stations_by_query_with_retrieval(
    entries: list[dict[str, Any]],
    query: str,
    max_results: int = 5,
) -> Tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    local_matches, local_suggestions = select_stations_by_query(entries, query)
    if local_matches or not _is_retrieval_enabled():
        return local_matches, local_suggestions

    try:
        retrieved_names = _retrieve_station_names(query, max_results)
    except Exception:
        return local_matches, local_suggestions

    if not retrieved_names:
        return local_matches, local_suggestions

    normalized = {normalize_text(name) for name in retrieved_names}
    matches = [
        entry
        for entry in entries
        if normalize_text(entry.get("nomestaz", "")) in normalized
    ]
    if matches:
        return matches, []

    return local_matches, local_suggestions


def _format_stations_output(
    entries: list[dict[str, Any]], max_results: int | None
) -> str:
    limited = entries[:max_results] if max_results else entries
    lines = []
    for entry in limited:
        value = format_value(entry.get("value"))
        soglia1 = entry.get("soglia1")
        soglia2 = entry.get("soglia2")
        soglia3 = entry.get("soglia3")
        lines.append(
            f"- {entry.get('nomestaz')}: {value} "
            f"(soglie {soglia1 or 0}/{soglia2 or 0}/{soglia3 or 0})"
        )
    return "\n".join(lines)


def _normalize_max_results(
    value: Any, minimum: int, maximum: int, default: int | None = None
) -> int | None:
    if value is None:
        return default
    if isinstance(value, bool):
        raise ValueError("max_results must be an integer")
    if isinstance(value, int):
        parsed = value
    elif isinstance(value, float) and value.is_integer():
        parsed = int(value)
    else:
        raise ValueError("max_results must be an integer")
    if parsed < minimum or parsed > maximum:
        raise ValueError(
            f"max_results must be between {minimum} and {maximum}"
        )
    return parsed


def _isoformat_ms(timestamp_ms: int) -> str:
    timestamp = datetime.fromtimestamp(
        timestamp_ms / 1000, tz=timezone.utc
    )
    return timestamp.isoformat(timespec="milliseconds").replace("+00:00", "Z")


@mcp.tool
def livello_idrometrico(fiume: str, max_results: int | None = None) -> str:
    """Restituisce il livello idrometrico corrente per un fiume o una stazione."""
    if not isinstance(fiume, str) or not fiume.strip():
        raise ValueError("Il parametro 'fiume' è obbligatorio.")
    max_results = _normalize_max_results(max_results, 1, 10)
    ts, data = fetch_sensor_values()
    entries = [item for item in data if item.get("nomestaz")]
    retrieval_limit = min(max_results or 5, 5)
    matches, suggestions = select_stations_by_query_with_retrieval(
        entries, fiume, max_results=retrieval_limit
    )

    if not matches:
        message_lines = [f'Nessuna stazione trovata per: "{fiume}".']
        if suggestions:
            message_lines.append("Possibili stazioni vicine:")
            message_lines.append(
                "\n".join(
                    f"- {entry.get('nomestaz')}" for entry in suggestions
                )
            )
        return "\n".join(message_lines)

    output = "\n".join(
        [
            (
                "Livello idrometrico (timestamp richiesta "
                f"{_isoformat_ms(ts)}) per \"{fiume}\":"
            ),
            _format_stations_output(matches, max_results),
        ]
    )
    return output


@mcp.tool
def elenco_stazioni_idrometriche(
    filtro: str | None = None, max_results: int | None = None
) -> str:
    """Elenca le stazioni idrometriche disponibili, con filtro opzionale."""
    if filtro is not None and not isinstance(filtro, str):
        raise ValueError("Il parametro 'filtro' deve essere una stringa.")
    max_results = _normalize_max_results(max_results, 1, 50, default=50)
    _, data = fetch_sensor_values()
    entries = [item for item in data if item.get("nomestaz")]
    normalized = normalize_text(filtro) if filtro else None
    filtered = (
        [
            entry
            for entry in entries
            if normalized in normalize_text(entry.get("nomestaz", ""))
        ]
        if normalized
        else entries
    )
    listed = filtered[:max_results]
    output = "\n".join(f"- {entry.get('nomestaz')}" for entry in listed)
    return output or "Nessuna stazione disponibile con il filtro indicato."


if __name__ == "__main__":
    mcp.run()
