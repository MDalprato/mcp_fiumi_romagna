# MCP Fiumi Romagna

MCP server per interrogare i livelli idrometrici tramite le stesse API del sito Allerta Emilia-Romagna.

## Requisiti
- Node.js 18+

## Installazione
```
npm install
```

## Avvio
```
npm start
```

## Configurazione MCP (stdio)
Esempio di configurazione:
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

## Tool disponibili
- `livello_idrometrico`
  - Input: `{ "fiume": "Ronco", "max_results": 3 }`
  - Risultato: livello idrometrico per le stazioni che matchano il nome del fiume.

- `elenco_stazioni_idrometriche`
  - Input: `{ "filtro": "Savio", "max_results": 20 }`
  - Risultato: elenco stazioni idrometriche disponibili.

## Note
- I dati provengono da `https://allertameteo.regione.emilia-romagna.it/o/api/allerta/get-sensor-values-no-time` con variabile idrometrica `254,0,0/1,-,-,-/B13215`.
- Se il nome del fiume non matcha nessuna stazione, il tool suggerisce stazioni simili.
