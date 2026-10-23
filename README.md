# Periscope MCP

Periscope is an MCP server that gives AI agents **strictly read-only** query access to data sources:

| Source | Query language | Result format |
|---|---|---|
| PostgreSQL | SQL (one `SELECT`) | Parquet |
| Oracle Database (19c+) | SQL (one `SELECT`) | Parquet |
| SQL Server / Azure SQL | T-SQL (one `SELECT`) | Parquet |
| Azure Cosmos DB for NoSQL | Cosmos NoSQL query language | NDJSON (gzip) |
| Azure Blob Storage | Glob or prefix, optional tag filter | NDJSON listing; contents referenced in place |
| Azure Log Analytics / Application Insights | KQL | Parquet |
| Redis (standalone or cluster) | One read-only Redis command; `SCAN` as key export | NDJSON (gzip) |
| KIM | Node or record query language | NDJSON (gzip); offloaded contents referenced in place |

Agents get the full read capability of each source. Writes cannot get through: on the API-based sources, write operations are never offered and are blocked on the wire; on the query-language sources they are filtered at several independent layers. The guarantee holds even when the configured credential could write.

A query never returns data inline. It produces a **result** that the agent either pages through in small windows (`read_result`) or downloads over HTTP and processes with its own tools (`curl`, DuckDB, `jq`, pandas). The flow is the same for five rows or fifty million.

The full design is in [docs/CONCEPT.md](docs/CONCEPT.md).

## Tools

| Tool | Purpose |
|---|---|
| `list_sources` | Sources you may query, with query language, dialect hints, options and limits |
| `describe` | Metadata, drilled down step by step (schemas → tables → columns, containers → sampled schemas, prefixes, …) |
| `query` | Starts a query and returns a `resultId` immediately; non-read-only queries are rejected synchronously |
| `get_result` | Status, schema, row counts, window limits and one manifest URL for downloads |
| `read_result` | One window of rows, or (blob results) lines of a text file or an image |
| `cancel_query` | Stops a running query |

A typical session:

```text
list_sources()                                         → appdata (cosmos), erp (oracle), …
describe("appdata", "main/claims")                     → partition key, inferred schema
query("appdata", "SELECT * FROM c WHERE c.year = @y",
      { "@y": 2026 }, { "container": "claims" })       → r_7Hq2kV…
read_result("r_7Hq2kV…", limit: 20)                    → first rows (already while running)
get_result("r_7Hq2kV…", wait: 10)                      → succeeded, 1.8M rows, 19 files, 412 MB
```

```bash
M="<download.manifestUrl>"; B="${M%/manifest.json}"
curl -fsS "$M" | jq -r '.files[].path' | xargs -P4 -I{} curl -fsS --create-dirs -o {} "$B/{}"
duckdb -c "SELECT status, count(*) FROM read_json('part-*.ndjson.gz') GROUP BY 1"
```

## Run locally (stdio)

Requires Node.js 24 and pnpm.

```bash
pnpm install
cp .env.example .env.periscope   # add your sources
node src/index.ts --env-file .env.periscope
```

Register it with Claude Code:

```bash
claude mcp add periscope -- node /path/to/periscope-mcp/src/index.ts --env-file /path/to/.env.periscope
```

In stdio mode, results are stored in `./.periscope/results` and download URLs point to a small HTTP endpoint on `127.0.0.1` that the server starts alongside.

With Docker (the published image runs the HTTP transport by default):

```bash
docker run -i --rm --env-file .env.periscope \
  -e PERISCOPE_TRANSPORT=stdio -e PERISCOPE_HOST=0.0.0.0 -e PERISCOPE_PORT=8765 \
  -e PERISCOPE_PUBLIC_URL=http://127.0.0.1:8765 -p 127.0.0.1:8765:8765 \
  ghcr.io/coreprocess/periscope-mcp:0.1.0
```

## Deploy

Periscope is built to run as one container per project and environment, inside the network where the data sources are reachable, published through a gateway with a verified custom domain and protected by Microsoft Entra ID (OAuth 2.1, MCP authorization spec). See [docs/deployment.md](docs/deployment.md) and the Terraform module in [terraform/](terraform/).

## Configuration

Everything is configured through environment variables; sources are an indexed list:

```bash
PERISCOPE_SOURCE_N=2
PERISCOPE_SOURCE_0_NAME=shop
PERISCOPE_SOURCE_0_TYPE=postgres
PERISCOPE_SOURCE_0_URL=postgres://reader:secret@db:5432/shop
PERISCOPE_SOURCE_1_NAME=cache
PERISCOPE_SOURCE_1_TYPE=redis
PERISCOPE_SOURCE_1_URL=rediss://default:secret@cache:6380
```

The full reference is in [docs/configuration.md](docs/configuration.md).

## How read-only is enforced

| Source | Layers |
|---|---|
| Cosmos DB | Only read/query operations implemented; HTTP guard on the SDK lets only `GET`/`HEAD` and query `POST`s through |
| Blob Storage | Only list/read operations implemented; pipeline guard lets only `GET`/`HEAD` through; downloads pinned to ETag/version/snapshot |
| Log Analytics | Query API only (it has no write operations); control commands rejected |
| PostgreSQL | `READ ONLY` transaction, always rolled back; syntax-tree guard with the Postgres parser (single `SELECT`, no locking, no data-modifying CTEs); side-effect function denylist; inventory that parses view definitions and switches to strict mode when `dblink`-style functions are reachable |
| Oracle | `SET TRANSACTION READ ONLY`, always rolled back; strict lexer (single `SELECT`, no PL/SQL, no DDL, no `FOR UPDATE`, no `NEXTVAL`); system package allowlist; routine inventory against autonomous transactions and dynamic SQL |
| SQL Server | Transaction that is always rolled back; strict T-SQL lexer (single `SELECT`, no `EXEC`, no DML/DDL, no `SELECT … INTO`, no `NEXT VALUE FOR`, no remote rowsets or locking hints); function inventory against extended procedures, OLE Automation, CLR and linked servers, with strict mode for sysadmin logins and risky server settings; optional `ApplicationIntent=ReadOnly` |
| Redis | Static allowlist of read-only, non-blocking commands; guard on every command the client writes to the socket; optional replica reads |
| KIM | Service account key with only the Reader role; allowlist on every HTTP request (query, collection listing, type definitions, byte reads; no drafts, sessions, agents or exports); query check (no `reveal` unless allowed, no foreign origins) |

Each layer is tested on its own against real databases with write-capable credentials (see `test/integration`).

## Development

```bash
pnpm lint          # Biome
pnpm typecheck     # TypeScript
pnpm test          # unit tests
pnpm test:integration   # needs Docker: Postgres, Oracle, SQL Server, Cosmos emulator, Azurite, Redis; KIM runs against a mock
pnpm build
```

## License

MIT
