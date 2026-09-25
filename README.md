# @pipeworx/ema-article57

EMA Article 57 product data — every medicine with a valid marketing authorisation anywhere in the European Economic Area (centrally, mutual-recognition, decentralised AND purely nationally authorised), one row per product x authorisation-country, with the marketing-authorisation holder and pharmacovigilance system location for each. Keyless.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1683+ live data sources.

This is EMA's WIDE register. The sibling `ema-medicines` pack covers only the EU centralised-procedure medicines (~1 row per medicine, richer fields — status, indications, approval dates). Article 57 is the opposite trade-off: thinner fields, but every EEA country's nationally authorised products too, which `ema-medicines` explicitly does not carry.

## Tools

- `ema_article57_search(query?, active_substance?, holder?, country?, route?, limit?, offset?)` — free-text/filtered search with real offset+limit pagination and a `total_matches` count. Answers "which EEA countries is X authorised in", "who is the marketing-authorisation holder for X in country Y", "which products does company Z hold in the EEA".
- `ema_article57_product(name, country?)` — every authorisation-country record for one product by name (exact match preferred, falls back to substring with `match_type` marked). Article 57 carries no indication text and no per-product URL, so this returns the authoritative EMA source document URL instead of a paraphrased indication.
- `ema_article57_recent_changes(since)` — products added to / removed from the register since a date, computed by diffing this pack's own dated snapshots (the source has no change-date column at all — see Gotchas). Returns `comparable: false` with a stated reason rather than a guessed empty diff when no snapshot covers the requested window.
- `ema_article57_dataset_info()` — the authoritative EMA bulk-download URL, current row count, this pack's snapshot dates on record, and the full list of distinct authorisation-country values (for exact spelling before filtering by `country`).

## Auth

Keyless.

## Data sources

- <https://www.ema.europa.eu/en/documents/other/article-57-product-data_en.xlsx> — the Article 57 database export, linked from EMA's ["Public data from Article 57 database"](https://www.ema.europa.eu/en/human-regulatory-overview/post-authorisation/data-medicines-iso-idmp-standards-post-authorisation/public-data-article-57-database) page. Verified live 2026-09-25: HTTP 200, `Last-Modified: Thu, 24 Sep 2026 13:38:24 GMT`, 7,870,020 bytes, 164,314 data rows. The page states the file carries "EMA/518502/2018 Rev. 88" and is updated "periodically" — there is no published cadence, so `Last-Modified` is the only real freshness signal.

### Architecture — this pack does NOT fetch EMA live

Measured 2026-09-25 against the real file: 7.87 MB compressed unzips to 63.0 MB of `sheet1.xml` + 4.7 MB of `sharedStrings.xml` (164,314 rows x 8 columns). Parsing a *much smaller* EMA export with the same regex-scan approach (`ema-medicines`'s ~0.9 MB report) already measured 123 MB of V8 heap; this file is ~9x bigger and would not fit in a Cloudflare Worker's 128 MB ceiling. So this pack reads a pre-built, pre-compacted dataset from the shared `pipeworx-datasets` R2 bucket instead of calling EMA per request. `scripts/ingest-ema-article57.mjs` does the actual fetch + XLSX parse (offline, not in a Worker) and writes:

- `ema-article57/latest.json.gz` — all 164,314 rows, dictionary-encoded (schema 2: each column is a table of unique strings plus one integer index per row), 6.35 MB raw / 1.42 MB gzipped, read once per isolate.

  **Why columns, not row objects:** schema 1 stored one object per row (29 MB of JSON) and three of the four tools died with Cloudflare error 1102 (resource limits) inside the gateway isolate on 2026-09-25. Every column repeats heavily — 15.9M characters of values, 2.8M unique, 32 countries, ~4,000 holders — so filters are decided once per unique value and looked up per row by index. Measured locally against the real file: search peaks ~33 MB above baseline, recent_changes (two snapshots) ~59 MB, 15 MB held once cached. The pack refuses any other schema rather than misreading it.
- `ema-article57/snapshots/YYYY-MM-DD.json.gz` — one dated copy per ingest run, kept for `ema_article57_recent_changes` to diff against.
- `ema-article57/snapshots-index.json` — small, uncompressed list of snapshot dates on record.
- `ema-article57/meta.json` — generation metadata.

**Re-run the ingest periodically** (`node scripts/ingest-ema-article57.mjs`) to track EMA's own updates and to give `ema_article57_recent_changes` more than one snapshot to diff — as shipped, only 2026-09-25 is on record, so `recent_changes` cannot yet answer for any earlier `since` date and says so explicitly rather than guessing zero.

Without the gateway's `_r2` binding (a bare `npm install` of this package) every tool returns `{reason: "dataset_unavailable", hint: ...}` naming the upstream URL to fetch directly — there is no live fallback, because a live per-request fetch+parse is exactly the thing this architecture note explains is not viable.

### Licence — EMA's Legal Notice explicitly permits this

[EMA's Legal Notice](https://www.ema.europa.eu/en/about-us/about-website/legal-notice): *"Information and documents made available on EMA's webpages are public and may be reproduced and/or distributed, totally or in part, irrespective of the means and/or the formats used, for non-commercial and commercial purposes, provided that EMA is always acknowledged as the source of the material."* An explicit reuse grant, not silence — building a copy here does not depend on the `mirror-needs-grant-proxy-does-not` proxy-only fallback.

### Schema — eight columns, nothing else

Row 20 is the header (rows 1-19 are a provenance banner + blank rows, same shape as the `medicines-output-*` reports), rows 21+ are data. In order: product name, active substance, route of administration, authorisation country, marketing authorisation holder, pharmacovigilance system master file location, PV enquiries email, PV enquiries phone.

**We keep the first six and drop the PV email and phone before anything is stored.** They are contact details — at small holders often a named person's own address — and this pack serves a copy, not a live proxy, so CLAUDE.md's personal-data carve-out applies. `ema_article57_dataset_info` lists them under `fields_withheld`. Do not add them back without a ruling.

**There is no date field, no per-product id, and no per-product URL.** Article 57 is a thin regulatory cross-reference (who holds what, where) — not a clinical register. Do not expect indication text, approval dates, or a status field; `ema_article57_dataset_info` lists exactly what is and is not present (`fields` / `fields_not_present`).

### Grain — one row per product x country, by design

The same product name legitimately repeats once per EEA country it is authorised in (e.g. "Helixor A" has separate rows for Latvia and Lithuania, each with its own holder/PV contact — in this case the same holder, but that is not guaranteed for every product). `ema_article57_product` returns every matching row, not one collapsed record, and `countries_found` lists them.

### Country names are EMA's own English spellings, not ISO codes

`country` values are free text as EMA publishes them — `"Germany"`, `"United Kingdom (Northern Ireland)"`, `"Czech Republic"`, `"European Union"` (yes, that's a real value in the country column, alongside `"Iceland"`, `"Liechtenstein"`, `"Norway"` for the wider EEA). `ema_article57_search`'s `country` filter does an exact (case-insensitive) match, so get the spelling from `ema_article57_dataset_info`'s `distinct_countries` first rather than guessing an ISO code or abbreviation.

### `ema_article57_recent_changes` needs at least two snapshots — it has one as shipped

The source publishes no per-row change date at all, so "what changed" can only ever be answered by diffing two of this pack's own dated snapshots. As shipped there is exactly one (2026-09-25), so every `since` request currently returns `comparable: false, reason: "no_snapshot_at_or_before_since"` — correct behaviour, not a bug, and the tool says so rather than returning a fabricated empty diff. Re-running the ingest script on a schedule is what makes this tool answer for real; see "Architecture" above.

### Known gap in add-pack.mjs's automated smoke test for R2-backed packs

`scripts/lib/pack-smoke.mjs` (used by `scripts/add-pack.mjs` step 3) calls each tool with only the arguments in `smoke.json` — it has no mechanism to inject a `_r2` binding, so its recorded smoke results for this pack (and for every other `injectR2` pack: `court-listener`, `crs-reports`, `esef-filings`, `fda-drug-competition`) are the honest "no binding" answer (`dataset_unavailable`), not real data. That payload is not literally empty by `payload-emptiness.mjs`'s heuristic (it has non-array keys), so the automated gate passes mechanically without ever exercising the real data path. This pack's tools were independently verified against the live production R2 dataset with a hand-built binding shim before shipping (real search/product/dataset_info/recent_changes calls against 164,314 real rows) — see the fleet #2421 close notes for the transcript. Worth fixing generally in `pack-smoke.mjs` at some point; out of scope for this pack alone.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "ema-article57": {
      "url": "https://gateway.pipeworx.io/ema-article57/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/ema-article57/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1683+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/ema_article57_search \
  -H 'Content-Type: application/json' \
  -d '{"query":"Helixor","limit":5}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/ema_article57_search`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "ema-article57": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-ema-article57"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-ema-article57
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Ema Article57 data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
