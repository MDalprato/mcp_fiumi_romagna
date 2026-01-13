# MCP Fiumi Romagna

MCP server that retrieves river level data from the official Allerta Emilia-Romagna APIs.

## Requirements
- Node.js 18+

## Install
```
npm install
```

## Run
```
npm start
```

## HTTP server (for GPT Actions)
Expose the HTTP API locally:
```
npm run start:http
```

Endpoints:
- `GET /livello-idrometrico?fiume=Ronco`
- `GET /stazioni?filtro=Savio&max_results=20`
- `GET /health`

## GPT Store (Actions) setup
1) Deploy the HTTP server to a public HTTPS URL (Render/Fly/Railway/your VPS).
2) Set `servers[0].url` in `openapi.yaml` to your public base URL.
3) In the GPT Builder, add an Action and upload `openapi.yaml`.
4) Test calls inside the GPT Builder and publish your GPT.

## MCP configuration (stdio)
Example configuration:
```
{
  "mcpServers": {
    "fiumi-romagna": {
      "command": "node",
      "args": ["/Users/marcodalprato/GitHub/mcp_fiumi_romagna/src/index.js"]
    }
  }
}
```

## Available tools
- `livello_idrometrico`
  - Input: `{ "fiume": "Ronco", "max_results": 3 }`
  - Output: river level data for stations matching the river or station name.

- `elenco_stazioni_idrometriche`
  - Input: `{ "filtro": "Savio", "max_results": 20 }`
  - Output: list of available hydrometric stations (optionally filtered).

## Notes
- Data source: `https://allertameteo.regione.emilia-romagna.it/o/api/allerta/get-sensor-values-no-time` with idrometric variable `254,0,0/1,-,-,-/B13215`.
- If no station matches the provided name, the tool returns close station suggestions.
