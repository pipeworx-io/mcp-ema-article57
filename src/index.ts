interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * EMA Article 57 product data — every medicine with a valid marketing
 * authorisation anywhere in the EEA, sourced from the European Medicines
 * Agency's Article 57 database export (one row per product × authorisation
 * country). Auth: none.
 *
 * This is EMA's WIDE register: unlike the `ema-medicines` pack (EU
 * centralised-procedure medicines only, ~1 row per medicine), Article 57
 * covers medicines authorised through the centralised, mutual-recognition,
 * decentralised AND purely national procedures — so the same product name
 * can, and usually does, appear once per EEA country it is authorised in.
 *
 * Source shape (learned the hard way, see scripts/ingest-ema-article57.mjs
 * for the full write-up):
 *  - Published as ONE machine-generated XLSX
 *    (article-57-product-data_en.xlsx), 164,314 data rows, 7.87 MB
 *    compressed / ~68 MB uncompressed XML. Too large to fetch and parse live
 *    inside a single Worker request — a regex scan of a similarly-shaped but
 *    much smaller EMA export (ema-medicines' ~0.9 MB report) already uses
 *    123 MB of V8 heap; this file is ~9x bigger. So this pack does NOT
 *    fetch EMA live. It reads a pre-built, pre-compacted gzip JSON index
 *    from the shared `pipeworx-datasets` R2 bucket
 *    (hosting-claims-ok: this line explains the storage architecture, which
 *    the tool descriptions and errors below deliberately do not restate),
 *    written by `scripts/ingest-ema-article57.mjs` and re-run periodically
 *    to track EMA's own "periodic" update cadence.
 *  - EIGHT columns, no more: product name, active substance, route of
 *    administration, authorisation country, marketing authorisation holder,
 *    pharmacovigilance system master file location, PV enquiries email, PV
 *    enquiries phone. NO date field, NO per-product id, NO per-product URL,
 *    NO indication text of any kind — Article 57 is a thin regulatory
 *    cross-reference (who holds what, where), not a clinical register. `ema_article57_product`'s detail
 *    response therefore points to the authoritative EMA source document
 *    rather than paraphrasing an indication that does not exist in the data.
 *  - WE DO NOT KEEP COLUMNS 7-8 (PV enquiries email and phone). They are
 *    contact details, and at small holders they are often a named person's
 *    own address. CLAUDE.md's personal-data carve-out says reachable is not
 *    ours to bulk-redistribute, and this pack IS a copy, not a proxy. The
 *    ingest drops them before anything is written; callers who need the PV
 *    desk get the holder and the PSMF location, and EMA's own file.
 *  - NO change-date column means `ema_article57_recent_changes` cannot read
 *    a per-row change date from the source at all — the only honest signal
 *    is a diff between two of our own dated snapshots. With fewer than two
 *    snapshots on record for the requested window, the tool says so
 *    (`comparable: false`) instead of returning a guessed empty diff.
 */


const SOURCE_URL = 'https://www.ema.europa.eu/en/documents/other/article-57-product-data_en.xlsx';
const SOURCE_PAGE_URL =
  'https://www.ema.europa.eu/en/human-regulatory-overview/post-authorisation/data-medicines-iso-idmp-standards-post-authorisation/public-data-article-57-database';
const SOURCE_NAME = 'European Medicines Agency — Article 57 product data (all EEA-authorised medicines)';
const PREFIX = 'ema-article57';

// ─────────────────────────── the dataset connection ───────────────────────────

interface R2Bucketish {
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
}

function r2From(args: Record<string, unknown>): R2Bucketish | null {
  const b = args._r2 as R2Bucketish | undefined;
  return b && typeof b.get === 'function' ? b : null;
}

interface Record57 {
  name: string;
  active_substance?: string;
  route?: string;
  country?: string;
  holder?: string;
  pv_location?: string;
}

interface DatasetFile {
  schema: number;
  generated_at: string;
  source_url: string;
  source_last_modified: string | null;
  row_count: number;
  rows: Record57[];
}

interface SnapshotsIndex {
  schema: number;
  dates: string[];
}

const DATASET_UNAVAILABLE = {
  reason: 'dataset_unavailable',
  hint:
    'The EMA Article 57 dataset is not reachable from this process. On the hosted Pipeworx gateway ' +
    '(https://gateway.pipeworx.io/mcp) it is available with no key needed. Running this package ' +
    'standalone (a bare npm install) has no route to it: the source file (164,314 rows, ~68 MB ' +
    'uncompressed XML) is too large to fetch and parse per request, so this pack depends on a ' +
    'pre-built dataset rather than a live upstream call. Fetch ' +
    `${SOURCE_URL} directly instead.`,
} as const;

// Gzip-decompress + JSON.parse only once per isolate; every subsequent call
// in the same isolate reuses it. A fresh isolate re-fetches from R2, which is
// cheap (3.6 MB gzipped) next to re-parsing the source XLSX would be.
let CACHE: { at: number; data: DatasetFile } | null = null;
const CACHE_TTL_MS = 30 * 60 * 1000;

const td = new TextDecoder();

async function gunzipJson<T>(obj: { arrayBuffer(): Promise<ArrayBuffer> }): Promise<T> {
  // R2 stores the object's bytes exactly as uploaded (gzip payload, in this
  // case) — the R2 binding does NOT auto-decompress on read the way an HTTP
  // Accept-Encoding negotiation would. Decompress explicitly rather than
  // trust the object to already be text; verified round-trip locally against
  // the real ingest output (scripts/ingest-ema-article57.mjs) before relying
  // on this in a request path.
  const buf = await obj.arrayBuffer();
  const stream = new Response(buf).body?.pipeThrough(new DecompressionStream('gzip'));
  if (!stream) throw new Error('ema_article57_decompress_unsupported');
  const text = td.decode(await new Response(stream).arrayBuffer());
  return JSON.parse(text) as T;
}

async function loadDataset(args: Record<string, unknown>): Promise<DatasetFile | null> {
  if (CACHE && Date.now() - CACHE.at < CACHE_TTL_MS) return CACHE.data;
  const r2 = r2From(args);
  if (!r2) return null;
  const obj = await r2.get(`${PREFIX}/latest.json.gz`);
  if (!obj) return null;
  const data = await gunzipJson<DatasetFile>(obj);
  CACHE = { at: Date.now(), data };
  return data;
}

async function loadSnapshot(args: Record<string, unknown>, dateStr: string): Promise<DatasetFile | null> {
  const r2 = r2From(args);
  if (!r2) return null;
  const obj = await r2.get(`${PREFIX}/snapshots/${dateStr}.json.gz`);
  if (!obj) return null;
  return gunzipJson<DatasetFile>(obj);
}

async function loadSnapshotsIndex(args: Record<string, unknown>): Promise<SnapshotsIndex | null> {
  const r2 = r2From(args);
  if (!r2) return null;
  const obj = await r2.get(`${PREFIX}/snapshots-index.json`);
  if (!obj) return null;
  const raw = td.decode(await obj.arrayBuffer());
  return JSON.parse(raw) as SnapshotsIndex;
}

function sourceBlock(ds: DatasetFile) {
  return {
    source: SOURCE_NAME,
    source_url: SOURCE_URL,
    data_as_of: ds.source_last_modified ?? ds.generated_at,
    row_count: ds.row_count,
  };
}

// ─────────────────────────── shared arg handling ───────────────────────────

function rejectUnknownArgs(args: Record<string, unknown>, accepted: readonly string[], toolLabel: string): void {
  const acceptedSet = new Set(accepted);
  const unknown = Object.keys(args).filter((k) => !k.startsWith('_') && !acceptedSet.has(k));
  if (unknown.length) {
    throw new Error(
      `user_error: ${toolLabel} does not recognise argument(s) ${unknown.map((k) => `"${k}"`).join(', ')}. ` +
        `They would otherwise be silently discarded rather than applied. Accepted arguments: ${accepted.join(', ')}.`,
    );
  }
}

function normQuery(s: string): string {
  return s.trim().toLowerCase();
}

function matchesQuery(rec: Record57, q: string): boolean {
  const hay = `${rec.name} ${rec.active_substance ?? ''} ${rec.holder ?? ''}`.toLowerCase();
  return hay.includes(q);
}

// ─────────────────────────────── tool defs ───────────────────────────────

const SEARCH_ARGS = ['query', 'active_substance', 'holder', 'country', 'route', 'limit', 'offset'] as const;
const PRODUCT_ARGS = ['name', 'country'] as const;
const RECENT_CHANGES_ARGS = ['since'] as const;
const DATASET_INFO_ARGS = [] as const;

const tools: McpToolExport['tools'] = [
  {
    name: 'ema_article57_search',
    description:
      'Search the EMA Article 57 database — every medicine with a valid marketing authorisation anywhere ' +
      'in the EEA (centrally, mutually-recognised, decentralised AND purely nationally authorised), one row ' +
      'per product x authorisation-country. Answers "which EEA countries is <product> authorised in", ' +
      '"who is the marketing-authorisation holder / pharmacovigilance system location for <product> in <country>", ' +
      '"which products does <company> hold in the EEA". Free-text query matches product name, active ' +
      'substance and holder name. Real offset+limit pagination with a total row count in the response — this ' +
      'is a 164k-row register, not a top-N sample.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Free text: product/brand name, active substance, or marketing-authorisation holder.' },
        active_substance: { type: 'string', description: 'Filter on active substance (substring match).' },
        holder: { type: 'string', description: 'Filter on marketing authorisation holder (substring match).' },
        country: { type: 'string', description: 'Filter on authorisation country, e.g. "Germany", "France" (exact EMA country name; see ema_article57_dataset_info for the full list).' },
        route: { type: 'string', description: 'Filter on route of administration (substring match), e.g. "oral", "subcutaneous".' },
        limit: { type: 'number', description: 'Max rows to return, default 25, max 200.' },
        offset: { type: 'number', description: 'Row offset for pagination, default 0.' },
      },
    },
  },
  {
    name: 'ema_article57_product',
    description:
      'The full Article 57 record(s) for one product by name — every EEA country it is authorised in, ' +
      'with the marketing-authorisation holder and pharmacovigilance system location per country. Article 57 carries ' +
      'no indication text and no per-product URL, so this returns the authoritative EMA source document URL ' +
      'rather than a paraphrased indication.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Exact or near-exact product name, e.g. "Helixor A", as it appears in the EMA export.' },
        country: { type: 'string', description: 'Restrict to one authorisation country.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'ema_article57_recent_changes',
    description:
      'Products added to or removed from the Article 57 register since a given date, computed by diffing ' +
      'our dated snapshots of the EMA export (the source itself carries no change-date column, so there is ' +
      'no other way to answer "what changed"). Returns comparable:false with an explicit reason, never a ' +
      'guessed empty diff, when no snapshot exists at or before the requested date.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        since: { type: 'string', description: 'Earliest date to diff from, YYYY-MM-DD.' },
      },
      required: ['since'],
    },
  },
  {
    name: 'ema_article57_dataset_info',
    description:
      'Dataset metadata: the authoritative EMA bulk-download URL, current row count, this pack\'s snapshot ' +
      'dates on record, and the full list of distinct authorisation-country values used by the country ' +
      'filter. Use this before ema_article57_search when you need the exact country spelling or want the ' +
      'bulk file instead of paginated rows.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
];

// ─────────────────────────────── callTool ───────────────────────────────

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'ema_article57_search': {
      rejectUnknownArgs(args, SEARCH_ARGS, 'ema_article57_search');
      const ds = await loadDataset(args);
      if (!ds) return DATASET_UNAVAILABLE;

      const query = typeof args.query === 'string' && args.query.trim() ? normQuery(args.query) : null;
      const activeSubstance = typeof args.active_substance === 'string' && args.active_substance.trim() ? normQuery(args.active_substance) : null;
      const holder = typeof args.holder === 'string' && args.holder.trim() ? normQuery(args.holder) : null;
      const country = typeof args.country === 'string' && args.country.trim() ? args.country.trim() : null;
      const route = typeof args.route === 'string' && args.route.trim() ? normQuery(args.route) : null;
      const limit = Math.min(Math.max(Number(args.limit ?? 25) || 25, 1), 200);
      const offset = Math.max(Number(args.offset ?? 0) || 0, 0);

      let rows = ds.rows;
      if (query) rows = rows.filter((r) => matchesQuery(r, query));
      if (activeSubstance) rows = rows.filter((r) => (r.active_substance ?? '').toLowerCase().includes(activeSubstance));
      if (holder) rows = rows.filter((r) => (r.holder ?? '').toLowerCase().includes(holder));
      if (country) rows = rows.filter((r) => (r.country ?? '').toLowerCase() === country.toLowerCase());
      if (route) rows = rows.filter((r) => (r.route ?? '').toLowerCase().includes(route));

      const total = rows.length;
      const page = rows.slice(offset, offset + limit);
      return {
        ...sourceBlock(ds),
        total_matches: total,
        offset,
        limit,
        returned: page.length,
        filters_applied: { query, active_substance: activeSubstance, holder, country, route },
        results: page,
      };
    }

    case 'ema_article57_product': {
      rejectUnknownArgs(args, PRODUCT_ARGS, 'ema_article57_product');
      const ds = await loadDataset(args);
      if (!ds) return DATASET_UNAVAILABLE;
      const name = String(args.name ?? '').trim();
      if (!name) throw new Error('user_error: ema_article57_product requires "name".');
      const countryFilter = typeof args.country === 'string' && args.country.trim() ? args.country.trim().toLowerCase() : null;

      const nameLower = name.toLowerCase();
      let matches = ds.rows.filter((r) => r.name.toLowerCase() === nameLower);
      if (matches.length === 0) {
        // Fall back to substring match, but say so — an exact hit and a
        // fuzzy hit are different confidence levels for a regulatory lookup.
        matches = ds.rows.filter((r) => r.name.toLowerCase().includes(nameLower));
      }
      if (countryFilter) matches = matches.filter((r) => (r.country ?? '').toLowerCase() === countryFilter);

      if (matches.length === 0) {
        return {
          ...sourceBlock(ds),
          found: false,
          name_queried: name,
          country_queried: args.country ?? null,
          note: 'No product name in the Article 57 register matches this query (exact or substring).',
        };
      }
      const exact = matches.every((r) => r.name.toLowerCase() === nameLower);
      return {
        ...sourceBlock(ds),
        found: true,
        match_type: exact ? 'exact' : 'substring',
        name_queried: name,
        countries_found: [...new Set(matches.map((r) => r.country).filter(Boolean))],
        records: matches,
        authoritative_document_url: SOURCE_URL,
        note: 'Article 57 carries no indication text or per-product page; this is the authoritative EMA source document.',
      };
    }

    case 'ema_article57_recent_changes': {
      rejectUnknownArgs(args, RECENT_CHANGES_ARGS, 'ema_article57_recent_changes');
      const since = String(args.since ?? '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) {
        throw new Error('user_error: ema_article57_recent_changes requires "since" as YYYY-MM-DD.');
      }
      const idx = await loadSnapshotsIndex(args);
      const latest = await loadDataset(args);
      if (!idx || !latest) return DATASET_UNAVAILABLE;

      const candidateDates = idx.dates.filter((d) => d <= since);
      if (candidateDates.length === 0) {
        return {
          ...sourceBlock(latest),
          comparable: false,
          reason: 'no_snapshot_at_or_before_since',
          since_requested: since,
          snapshot_dates_on_record: idx.dates,
          note:
            `No snapshot of this dataset was taken on or before ${since}. Snapshot tracking started ` +
            `${idx.dates[0] ?? 'unknown'}, so "changed since" is unanswerable for any earlier date — this is ` +
            'reported as unknown, not as zero changes.',
        };
      }
      const baselineDate = candidateDates[candidateDates.length - 1];
      const baseline = await loadSnapshot(args, baselineDate);
      if (!baseline) {
        return {
          ...sourceBlock(latest),
          comparable: false,
          reason: 'baseline_snapshot_missing',
          since_requested: since,
          baseline_date_expected: baselineDate,
          note: 'The snapshots index names a baseline date but the snapshot object itself could not be read.',
        };
      }

      const key = (r: Record57) => `${r.name}\u0000${r.country ?? ''}`;
      const baselineKeys = new Set(baseline.rows.map(key));
      const latestKeys = new Set(latest.rows.map(key));
      const added = latest.rows.filter((r) => !baselineKeys.has(key(r)));
      const removed = baseline.rows.filter((r) => !latestKeys.has(key(r)));

      return {
        ...sourceBlock(latest),
        comparable: true,
        since_requested: since,
        baseline_snapshot_date: baselineDate,
        latest_snapshot_generated_at: latest.generated_at,
        added_count: added.length,
        removed_count: removed.length,
        added: added.slice(0, 200),
        removed: removed.slice(0, 200),
        truncated: added.length > 200 || removed.length > 200,
        note:
          'Added/removed are product-name x country pairs newly present or absent versus the baseline ' +
          'snapshot. The source publishes no per-row change date, so this reflects only what changed ' +
          "between the two snapshots this pack happened to take — not necessarily everything that changed " +
          'in the underlying EMA database during that window.',
      };
    }

    case 'ema_article57_dataset_info': {
      rejectUnknownArgs(args, DATASET_INFO_ARGS, 'ema_article57_dataset_info');
      const ds = await loadDataset(args);
      const idx = await loadSnapshotsIndex(args);
      if (!ds) return DATASET_UNAVAILABLE;
      const countries = [...new Set(ds.rows.map((r) => r.country).filter((c): c is string => Boolean(c)))].sort();
      return {
        ...sourceBlock(ds),
        source_page_url: SOURCE_PAGE_URL,
        bulk_download_url: SOURCE_URL,
        snapshot_dates_on_record: idx?.dates ?? [],
        distinct_countries: countries,
        fields: ['name', 'active_substance', 'route', 'country', 'holder', 'pv_location'],
        fields_not_present: ['indication', 'authorisation_date', 'status', 'product_id', 'product_url'],
        fields_withheld: ['pv_email', 'pv_phone'],
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
