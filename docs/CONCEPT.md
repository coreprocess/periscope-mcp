# Periscope MCP: Concept

Status: draft for review · 2026-10-22

Periscope is an MCP server that gives AI agents **strictly read-only** query access to data sources: Postgres, Oracle, SQL Server (including Azure SQL), Azure Cosmos DB, Azure Blob Storage, Azure Log Analytics / Application Insights, Redis, KIM and any HTTP API. Each project deploys its own instance and configures any number of data sources through environment variables.

Agents get the full read capability of each source: free-form SQL, Cosmos queries, KQL, KIM queries, HTTP requests and blob selection. All of it goes through one small set of generic tools. A query never returns data inline. It produces a **result** that the agent either pages through in windows, in context, or **downloads** over HTTP and processes with its own tools (`jq`, DuckDB, Python, …). The flow is the same for five rows or fifty million, and long-running exports come for free.

Writes cannot get through. Some source types never offer write operations at all; on the others, writes are filtered out at several independent layers, and for HTTP APIs only the requests the operator lists as reads are sent.

**Clients:** Claude Code in the IDE and on the CLI, and Claude Code on the web, including agent workflows that run unattended in the cloud. Any MCP client that supports the MCP authorization spec should work. Downloads need a client that can run `curl`.

---

## 1. Goals and non-goals

**Goals**
- One server, shipped as one Docker image, deployed per project and environment. Configuration through environment variables only.
- Any number of named data sources per instance, each with a type and connection info.
- **A small, generic tool set** that is the same for every source type. No type-specific tools.
- **One way to retrieve data:**
  1. `query` starts the query and returns a result ID.
  2. `get_result` reports status and metadata.
  3. `read_result` pages through the result in context, or a download URL fetches it in bulk.
- **Large and long-running exports**, so agents can pull big datasets and work on them locally instead of in context.
- **A read-only guarantee by design that does not depend on the credential.** Even with a write-capable credential (a shared database user, an account key), no write to a source can get through.
- Safe, usable authentication for local and cloud clients, with no static API keys.
- Deployment through infrastructure as code (Terraform).

**Non-goals**
- Any form of write, migration or admin operation on sources.
- Scheduled exports, data sync, dashboards.
- Machine-to-machine access without a user (e.g. CI pipelines with app-only tokens).
- Propagating the user's identity to the data sources (on-behalf-of). Periscope authorizes the user and talks to the sources with its own identity (see §7.4).

---

## 2. Supported source types

| Type           | Service                                                                                | Query language                                                                              | Result format                                                        | Notes                                                                                                                                                                                                                                      |
| -------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `postgres`     | PostgreSQL (including Azure Database for PostgreSQL Flexible Server)                   | SQL (SELECT)                                                                                | Parquet                                                              | Extensions such as pgvector and DiskANN are supported for querying. Extensions that can cause side effects (dblink, oracle_fdw, pg_background, pg_cron) are accounted for in the guard.                                                    |
| `oracle`       | Oracle Database 19c+                                                                   | SQL (SELECT)                                                                                | Parquet                                                              | Uses node-oracledb thin mode (DB 12.1+), so no Instant Client is needed. 19c is the reference version.                                                                                                                                     |
| `mssql`        | SQL Server 2017+, Azure SQL Database, Azure SQL Managed Instance                       | T-SQL (SELECT)                                                                              | Parquet                                                              | Uses `mssql` on `tedious`. The driver is pinned with a small patch so that `decimal`/`numeric` and `money` values arrive as exact strings instead of floats.                                                                               |
| `cosmos`       | Azure Cosmos DB for NoSQL                                                              | Cosmos NoSQL query language                                                                 | NDJSON (gzip)                                                        | The Mongo, Cassandra, Gremlin and Table APIs are out of scope.                                                                                                                                                                             |
| `blob`         | Azure Blob Storage                                                                     | Blob selection: glob/prefix plus optional tag filter                                        | Listing: NDJSON (gzip); contents: referenced in place, never copied  | Every listed blob is downloadable and readable through the result. Tables, Queues, Files and Data Lake are out of scope.                                                                                                                   |
| `redis`        | Redis (including Azure Cache for Redis and Azure Managed Redis), standalone or cluster | Read-only Redis commands (allowlist); `SCAN` iterates to completion, optionally with values | NDJSON (gzip)                                                        | Useful for inspecting caches, sessions and job queues (lists, streams, sorted sets).                                                                                                                                                       |
| `loganalytics` | Azure Log Analytics workspace                                                          | KQL                                                                                         | Parquet                                                              | Also covers **workspace-based Application Insights**, whose telemetry is stored in the workspace (`AppRequests`, `AppDependencies`, `AppTraces`, `AppExceptions`, `AppEvents`, `AppMetrics`, `AppPageViews`, `AppAvailabilityResults`, …). |
| `kim`          | KIM: typed, versioned objects in collections, per stage                                | KIM node query language or record query language (one query)                                | NDJSON (gzip); offloaded contents: referenced in place, never copied | Read over KIM's HTTP API with a service account API key. Periscope pages through all matches itself, at one snapshot.                                                                                                                      |
| `rest`         | Any HTTP API: REST, RPC, GraphQL over `POST`                                           | One HTTP request: request line, header lines, body                                          | NDJSON (gzip); binary responses: referenced, fetched again on read   | Every request must match an operator-declared allowlist of methods and paths. An optional script signs in, pages and shapes responses.                                                                                                     |

Two points about Application Insights:
- **Classic App Insights is retired.** Every App Insights resource is now workspace-based, so `loganalytics` covers it. Setting `RESOURCE_ID` to an App Insights resource scopes queries to that one app.
- **App connection strings can't read.** The connection string an app uses to send telemetry is ingestion-only.

About KIM: a KIM stage (`<org>.<solution>.<stage>`, e.g. `acme.crm.prod`) holds typed, versioned objects in collections and is reached over KIM's HTTP API. A `kim` source reads one stage. KIM has two query languages:
- **Node query language:** `from <collection url> [where …] [order by …] first|last N [after …] [pick …]`, `at <urls>` and `referrers of <url>`. It returns objects with their typed values.
- **Record query language:** the same, plus `select`, `summarize … by`, `distinct` and `join`. It returns records.

About `rest`: a `rest` source reads one HTTP API. The agent writes the request the way it would in an `.http` file, and gets the response body as documents. The operator decides which requests are reads (`ALLOW`), how Periscope signs in and pages (`SCRIPT`), and what agents should know about the API (`DESCRIPTION`, `GUIDE`). So one source type covers APIs that Periscope has no adapter of its own for.

---

## 3. Architecture

```
                                      public gateway                 private network (VNet)
Claude Code (IDE/CLI) ─┐  MCP + OAuth  (custom domain, TLS)    ┌───────────────────────────────────────────┐
Claude Code (cloud)   ─┼─────────────▶ /mcp ──────────────────▶│ Periscope (container, internal ingress)   │
claude.ai connector   ─┘                                       │   control plane: MCP tools                │
                                                               │   query workers ──▶ sources (read-only)   │
agent sandbox (curl, DuckDB, …) ─────▶ /r/<signed-token> ─────▶│   data plane: downloads ◀── result store  │
                                                               └───────────────────────────────────────────┘
                                                     Cosmos · Blob · Postgres · Oracle · SQL Server · Log Analytics · Redis · KIM · HTTP APIs
                                                     Result store: Periscope's own Blob container
```

- **Deployment location:** data sources usually sit behind private endpoints, so Periscope runs **inside the private network** next to them. Only Periscope's endpoints are exposed publicly: `/mcp` behind OAuth, `/r/…` behind signed, expiring URLs.
- **Control plane (MCP):** discover sources, describe metadata, start queries, check status, read windows.
- **Data plane (HTTP):** download results. These are plain HTTP endpoints on the same container, so `curl` works and so does DuckDB's `read_parquet`/`read_json` over HTTPS.
- **Result store:** Periscope's own Blob container, which is a separate storage account and never a source. Results are materialized there in parts, with a manifest, and deleted after a retention period. Replicas hold no state of their own. Any replica can answer `get_result`, `read_result` and downloads from the store.
- **Transport:** MCP Streamable HTTP for deployed instances, and stdio for local development. In stdio mode the result store is a local directory, and Periscope also starts the HTTP data plane on `127.0.0.1`, so download URLs work the same way as in a deployment.
- **Tech stack:** TypeScript on Node.js 24. Libraries and the reasoning behind them are in §9.1.

---

## 4. Configuration

All configuration comes from environment variables. In Azure, secrets come in as Key Vault references. For local development, `--env-file <path>` loads a gitignored dotenv file.

### 4.1 Global settings

The authoritative, complete reference is [configuration.md](configuration.md); it also lists the overrides for tests and other clouds (`PERISCOPE_HOST`, `PERISCOPE_AUTH_ISSUER`, `PERISCOPE_AUTH_JWKS_URI`, `PERISCOPE_RESULTS_CONNECTION_STRING`, …). The main settings:

| Variable                                                       | Default                                   | Purpose                                                                                                                 |
| -------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `PERISCOPE_TRANSPORT`                                          | `stdio`                                   | `stdio` or `http`                                                                                                       |
| `PERISCOPE_PORT`                                               | `8080`                                    | HTTP port                                                                                                               |
| `PERISCOPE_PUBLIC_URL`                                         | (required for http)                       | Public base URL, e.g. `https://periscope.example.com`. The MCP endpoint is `<base>/mcp` and downloads are `<base>/r/…`. |
| `PERISCOPE_AUTH`                                               | `entra`                                   | `entra`, or `none` (only allowed with stdio or a localhost bind; requests with another Host or Origin are rejected)     |
| `PERISCOPE_AUTH_TENANT_ID`                                     |                                           | Entra tenant                                                                                                            |
| `PERISCOPE_AUTH_CLIENT_ID`                                     |                                           | Periscope app registration (expected audience)                                                                          |
| `PERISCOPE_AUTH_REQUIRED_ROLE`                                 | `Periscope.Reader`                        | App role required for any access                                                                                        |
| `PERISCOPE_RESULTS_STORE`                                      | `azureblob` (http) / `filesystem` (stdio) | Where results are materialized                                                                                          |
| `PERISCOPE_RESULTS_ACCOUNT_URL`, `PERISCOPE_RESULTS_CONTAINER` |                                           | Result store for `azureblob`, accessed with the managed identity; the deployment creates the container                  |
| `PERISCOPE_RESULTS_DIR`                                        | `./.periscope/results`                    | Result store for `filesystem`                                                                                           |
| `PERISCOPE_RESULTS_RETENTION`                                  | `PT24H`                                   | How long results are kept                                                                                               |
| `PERISCOPE_RESULTS_PART_BYTES`                                 | `104857600`                               | Target stored (compressed) size of one result part. The first part closes earlier (§6.1).                               |
| `PERISCOPE_DOWNLOAD_URL_TTL`                                   | `PT1H`                                    | Lifetime of a signed download URL. `get_result` always issues fresh URLs.                                               |
| `PERISCOPE_DOWNLOAD_SIGNING_KEY`                               | (secret)                                  | HMAC key for download URLs. Rotating it revokes all outstanding URLs.                                                   |
| `PERISCOPE_READ_MAX_ROWS`                                      | `500`                                     | Maximum rows per `read_result` window                                                                                   |
| `PERISCOPE_READ_MAX_BYTES`                                     | `65536`                                   | Maximum response size per `read_result` window                                                                          |
| `PERISCOPE_READ_MAX_VALUE_CHARS`                               | `2000`                                    | Values longer than this are truncated in windows (never in downloads)                                                   |
| `PERISCOPE_MAX_CONCURRENT_QUERIES`                             | `4` per user                              | Concurrency limit                                                                                                       |
| `PERISCOPE_AUDIT_LOG`                                          | `stdout`                                  | `stdout`, `stderr` or a file path (JSONL)                                                                               |
| `AZURE_CLIENT_ID`                                              |                                           | Client ID of Periscope's user-assigned managed identity, used by `DefaultAzureCredential`                               |

### 4.2 Data sources

Sources are configured as an indexed list:

```bash
PERISCOPE_SOURCE_N=3                      # number of sources
PERISCOPE_SOURCE_0_NAME=appdata
PERISCOPE_SOURCE_0_TYPE=cosmos            # postgres | oracle | mssql | cosmos | blob | loganalytics | redis | kim | rest
PERISCOPE_SOURCE_0_<KEY>=...
PERISCOPE_SOURCE_1_NAME=files
PERISCOPE_SOURCE_1_TYPE=blob
...
```

- **Indices** run from `0` to `N-1`, and every index must define `NAME` and `TYPE`.
- **Validation.** Periscope refuses to start, naming the offending variable, if:
  - an index is missing
  - there are extra indices (`PERISCOPE_SOURCE_<i>_*` with `i >= N`)
  - names are duplicated
  - a key is unknown for the source's type
  - a source points at the result store

  This catches typos and stale entries early.
- **`NAME`** is the identifier agents use in the `source` argument: lowercase, `[a-z0-9_-]`, unique per instance. The index only defines the order in `list_sources`.

**Common keys:**

| Key                  | Purpose                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `NAME`, `TYPE`       | Required                                                                                                                       |
| `DESCRIPTION`        | Shown to the agent, so write it carefully                                                                                      |
| `MAX_QUERY_DURATION` | Maximum run time of one query (default `PT15M`)                                                                                |
| `MAX_RESULT_BYTES`   | Maximum materialized result size (default 10 GB)                                                                               |

**Keys per type:**

| Type           | Connection                                                                                                                                                  | Optional                                                                                                                                                                                                                                          |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `postgres`     | `URL`, or `HOST`/`PORT`/`DATABASE`/`USER`/`PASSWORD`; or `AUTH=azure` (Entra token for the managed identity)                                                | `SSL`, `SEARCH_PATH`                                                                                                                                                                                                                              |
| `oracle`       | `CONNECT_STRING` (EZConnect or full descriptor, so SID-style addresses work), or `HOST`/`PORT`/`SID`\|`SERVICE_NAME`; plus `USER`/`PASSWORD`                | `ALLOW_ROUTINES`, `ALLOW_DBLINKS`                                                                                                                                                                                                                 |
| `mssql`        | `CONNECTION_STRING`, or `HOST`/`PORT`/`DATABASE`; plus `USER`/`PASSWORD`, or `AUTH=azure` (Entra token for the managed identity)                            | `ENCRYPT` (default `true`), `TRUST_SERVER_CERTIFICATE`, `READ_INTENT` (`ApplicationIntent=ReadOnly`; default `true` if the connection string contains it), `ALLOW_ROUTINES`, `ALLOW_LINKED_SERVERS`                                               |
| `cosmos`       | `CONNECTION_STRING`, or `ENDPOINT` + `KEY`, or `ENDPOINT` + `AUTH=azure`                                                                                    | `DATABASE` (default database), `MAX_RU_PER_SEC` (throughput budget for queries), `LOW_PRIORITY` (use priority-based execution if enabled on the account)                                                                                          |
| `blob`         | `CONNECTION_STRING`, or `ACCOUNT_URL` + `SAS`, or `ACCOUNT_URL` + `AUTH=azure`                                                                              | `CONTAINER` (default container)                                                                                                                                                                                                                   |
| `loganalytics` | `WORKSPACE_ID`, or `RESOURCE_ID` (e.g. an App Insights resource, which scopes queries to it); `AUTH=azure`                                                  | `DEFAULT_TIMESPAN` (default `P1D`)                                                                                                                                                                                                                |
| `redis`        | `URL` (`rediss://…`), or `HOST`/`PORT`/`USERNAME`/`PASSWORD`/`TLS`; or `HOST` + `AUTH=azure` (Entra token, for Azure Cache for Redis / Azure Managed Redis) | `DATABASE` (index, standalone only), `CLUSTER` (`true` for cluster mode; `SCAN` then fans out over all shards), `READ_FROM_REPLICAS` (send reads to replicas, which reject writes), `MAX_OPS_PER_SEC` (command budget, like the Cosmos RU budget) |
| `kim`          | `URL` (origin of the KIM environment), `STAGE` (`org.solution.stage`, e.g. `acme.crm.prod`, or the stage id), `API_KEY` (a service account key, `kim_sk_…`) | `IDENTITY_URL` (origin of the instance that hosts the management stage, where the key is exchanged; default `URL`), `ALLOW_REVEAL` (allow `reveal` in queries; default `false`)                                                                   |
| `rest`         | `BASE_URL` (request paths starting with `/` are appended to it)                                                                                             | `ALLOW`, `ALLOW_HEADERS`, `SCRIPT`, `VAR_<NAME>`, `GUIDE`, `MAX_RESPONSE_BYTES`, `MAX_REQUESTS` (see below)                                                                                                                                       |

`AUTH=azure` uses `DefaultAzureCredential`. In Azure that is Periscope's managed identity; locally it is `az login`.

**`rest` sources** are configured with these keys:
- **`ALLOW`:** the requests Periscope may send, as `METHOD pattern` rules separated by commas or line breaks (default `GET /**`). A pattern is a path under `BASE_URL` (`GET /items/**`) or an absolute URL for another origin (`GET https://files.example.com/**`). `*` matches within one path segment and `**` across segments; a pattern without wildcards matches exactly. `HEAD` is allowed wherever `GET` is. Rules hold no query string.
- **`ALLOW_HEADERS`:** headers agents may set, besides `accept`, `accept-language`, `content-type`, `if-none-match` and `if-modified-since`.
- **`SCRIPT`:** an ES module with any of three exports, all optional:
  - `check(request, context)` runs for every request and rejects it by throwing.
  - `prepare(request, context)` runs before every request is sent. It adds credentials and headers, changes the request in place or returns a new one.
  - `transform(response, context)` gets every response as a standard fetch `Response`. It returns the documents, or `{ documents, next }`, where `next` is the request to send after it (the next page, or the same request again after signing in anew).

  A request is `{ method, url, headers, body }`, with lower-case header names and a string body. Every hook gets `context.vars`, `context.fetch` and `context.signal`. `transform` also gets `context.request`, the request the response answers before `prepare`, and `context.file(url, name?)`, which returns a file link for a `GET` URL (§6.1), served under `name` (default: the URL's last path segment). The module scope is the script's memory: a token kept there lasts until the process restarts and is separate per replica.
- **`VAR_<NAME>`:** values for the script, as `context.vars.<NAME>`: sign-in URLs, user names, passwords, client secrets. All are treated as secrets.
- **`GUIDE`:** usage notes for agents (endpoints, paging, what fields mean), returned by `describe`. `DESCRIPTION` stays the short summary in `list_sources`.
- **`MAX_RESPONSE_BYTES`:** the largest response body Periscope reads into memory (default 64 MiB).
- **`MAX_REQUESTS`:** the most requests one query may send; pages and retries count, redirect hops do not (default 1000).

A script that signs in with a password grant, keeps the token and pages through `{ results, page, pages }`:

```js
let token;

export async function prepare(request, { vars, fetch }) {
    if (!token || Date.now() > token.renewAt) {
        const response = await fetch(vars.TOKEN_URL, {
            method: 'POST',
            headers: { authorization: `Basic ${btoa(`${vars.CLIENT_ID}:${vars.CLIENT_SECRET}`)}` },
            body: new URLSearchParams({ grant_type: 'password', username: vars.USERNAME, password: vars.PASSWORD }),
        });
        const body = await response.json();
        token = { value: body.access_token, renewAt: Date.now() + body.expires_in * 500 };
    }
    request.headers.authorization = `Bearer ${token.value}`;
}

export async function transform(response, { request }) {
    if (response.status === 401) {
        token = undefined;
        return { next: request };
    }
    const body = await response.json();
    const url = new URL(request.url);
    url.searchParams.set('page', String(body.page + 1));
    return { documents: body.results, next: body.page < body.pages ? { ...request, url: url.href } : undefined };
}
```

### 4.3 Example (Terraform, Azure Container App)

```hcl
env = [
  { name = "PERISCOPE_TRANSPORT",             value = "http" },
  { name = "PERISCOPE_PUBLIC_URL",            value = "https://periscope.example.com" },
  { name = "PERISCOPE_AUTH_TENANT_ID",        value = data.azuread_client_config.current.tenant_id },
  { name = "PERISCOPE_AUTH_CLIENT_ID",        value = azuread_application.periscope.client_id },
  { name = "AZURE_CLIENT_ID",                 value = azurerm_user_assigned_identity.periscope.client_id },
  { name = "PERISCOPE_RESULTS_ACCOUNT_URL",   value = azurerm_storage_account.periscope_results.primary_blob_endpoint },
  { name = "PERISCOPE_RESULTS_CONTAINER",     value = "results" },
  { name = "PERISCOPE_DOWNLOAD_SIGNING_KEY",  secret_name = "periscope-download-signing-key" },

  { name = "PERISCOPE_SOURCE_N",              value = "4" },

  { name = "PERISCOPE_SOURCE_0_NAME",         value = "appdata" },
  { name = "PERISCOPE_SOURCE_0_TYPE",         value = "cosmos" },
  { name = "PERISCOPE_SOURCE_0_ENDPOINT",     value = azurerm_cosmosdb_account.main.endpoint },
  { name = "PERISCOPE_SOURCE_0_AUTH",         value = "azure" },
  { name = "PERISCOPE_SOURCE_0_DATABASE",     value = "main" },
  { name = "PERISCOPE_SOURCE_0_DESCRIPTION",  value = "Application documents and processing state" },
  { name = "PERISCOPE_SOURCE_0_MAX_RU_PER_SEC", value = "2000" },

  { name = "PERISCOPE_SOURCE_1_NAME",         value = "files" },
  { name = "PERISCOPE_SOURCE_1_TYPE",         value = "blob" },
  { name = "PERISCOPE_SOURCE_1_ACCOUNT_URL",  value = azurerm_storage_account.main.primary_blob_endpoint },
  { name = "PERISCOPE_SOURCE_1_AUTH",         value = "azure" },

  { name = "PERISCOPE_SOURCE_2_NAME",         value = "logs" },
  { name = "PERISCOPE_SOURCE_2_TYPE",         value = "loganalytics" },
  { name = "PERISCOPE_SOURCE_2_WORKSPACE_ID", value = azurerm_log_analytics_workspace.main.workspace_id },

  { name = "PERISCOPE_SOURCE_3_NAME",           value = "erp" },
  { name = "PERISCOPE_SOURCE_3_TYPE",           value = "oracle" },
  { name = "PERISCOPE_SOURCE_3_CONNECT_STRING", secret_name = "periscope-erp-connect-string" }, # Key Vault reference
  { name = "PERISCOPE_SOURCE_3_USER",           secret_name = "periscope-erp-user" },
  { name = "PERISCOPE_SOURCE_3_PASSWORD",       secret_name = "periscope-erp-password" },
]
```

The Terraform module (§8.3) generates these variables from a list of source objects, so the indices and `PERISCOPE_SOURCE_N` don't need to be maintained by hand.

---

## 5. Tools

Six generic tools, the same for every source type. The source type only changes the query language and a few `options`.

| Tool                                      | Returns                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_sources()`                          | The configured sources: name, type, description, query language, **dialect hints** (e.g. Oracle 19c rules, the KQL timespan default), the source's `options`, limits, active read-only layers, and credential state (`read-only verified` / `unverified` / `write-capable`; informational only). |
| `describe(source, path?, filter?)`        | Metadata, inline, drilled down step by step (§5.1).                                                                                                                                                                                                                                                                                     |
| `query(source, query, params?, options?)` | `{ resultId }`, immediately. Validation and guard errors are returned synchronously (§5.2).                                                                                                                                                                                                                                             |
| `get_result(resultId, wait?)`             | Status and full result metadata: schema, row counts, part layout, download URLs and sizes, window limits (§5.3).                                                                                                                                                                                                                        |
| `read_result(resultId, …window)`          | One window of the result, inline (§5.4).                                                                                                                                                                                                                                                                                                |
| `cancel_query(resultId)`                  | Stops a running query. Parts already written stay readable until the result expires.                                                                                                                                                                                                                                                    |

All tools carry the MCP annotations `readOnlyHint: true` and `destructiveHint: false`.

### 5.1 `describe`

`describe` is the only tool that returns data inline. That's acceptable because it returns metadata, is bounded, and works by drilling down. `filter` is a name pattern that narrows large levels.

| Type           | `path` levels                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `postgres`     | (none) lists schemas → `schema` lists tables and views (row estimates, comments) → `schema.table` lists columns, types, PK/FK, indexes (including vector indexes), comments                                                                                                                                                                                                                      |
| `oracle`       | Same, via the `ALL_*` dictionary views (owner → objects → columns, constraints, indexes, comments)                                                                                                                                                                                                                                                                                               |
| `mssql`        | Same, via the `sys.*` catalog views (schemas → tables and views with row estimates from `sys.partitions` and `MS_Description` comments → columns, keys, foreign keys, indexes, view definition)                                                                                                                                                                                                  |
| `cosmos`       | databases → `db` lists containers → `db/container` returns partition key, indexing policy, vector policy, TTL, and a **schema inferred from sample documents** (field paths, types, frequency)                                                                                                                                                                                                   |
| `blob`         | containers → `container/prefix/` lists sub-prefixes and blobs one level deep, with counts                                                                                                                                                                                                                                                                                                        |
| `loganalytics` | (none) lists tables with data in the default timespan and their row counts → `Table` returns `getschema`                                                                                                                                                                                                                                                                                         |
| `redis`        | (none) returns a server summary (version, mode, keys per database, used memory) and a **key-prefix overview** from a sampled `SCAN`: prefixes split at `:`, with estimated counts and types → `prefix:` lists sub-prefixes and sample keys → an exact key returns type, TTL, size (`STRLEN`/`HLEN`/`LLEN`/`SCARD`/`ZCARD`/`XLEN`), encoding, memory usage, and for streams their consumer groups |
| `kim`          | (none) lists the stage's collections → `collection` (dotted alias or id) lists its sub-collections and the types of its objects with object counts (a census query `summarize n = count() by app = $::descriptor`, type titles from the type definitions) → `collection/type` lists the type's properties with shape names, args, and the required, title, sensitive and secret flags            |
| `rest`         | (none) returns the base URL, the allowed requests, the headers agents may set, and the operator's `GUIDE`                                                                                                                                                                                                                                                                                        |

### 5.2 `query`

```
query(source, query, params?, options?) → { resultId }
```

- **`query`** is SQL (Postgres, Oracle), T-SQL (SQL Server), Cosmos SQL or KQL. For `blob` sources it is a glob or prefix relative to the container (`invoices/2026/**/*.pdf`). For `kim` sources it is one query text in either KIM query language (§2). For `rest` sources it is one HTTP request: `METHOD URL` on the first line, optional `name: value` header lines, then a blank line and the body; a URL starting with `/` is appended to `BASE_URL`.
- **`params`** are bind parameters: `$1` for Postgres, `:name` for Oracle, `@name` for SQL Server and Cosmos (an object of names to values). KIM has no bind parameters: literals are written into the query, with typed constructors such as `PreciseNumber(1.25)` or `Instant(2026-01-01T00:00:00Z)`. REST has none either: the request is the query.
- **`options`** depend on the type:

| Type                          | Options                                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `postgres`, `oracle`, `mssql` | `explain` (the result is the execution plan instead of data)                                                  |
| `cosmos`                      | `database`, `container` (required), `partitionKey`                                                            |
| `blob`                        | `container`, `tagFilter` (blob index tag expression), `include` (`metadata`, `tags`, `versions`, `snapshots`) |
| `loganalytics`                | `timespan` (ISO 8601 duration or interval)                                                                    |
| `redis`                       | `values` (with `SCAN`: also fetch each key's type, TTL and value, i.e. a key export)                          |
| `kim`                         | `snapshotId` (read at this KIM snapshot instead of the latest)                                                |
| `rest`                        | (none)                                                                                                        |

**Synchronous checks before a result is created:** argument validation, permission checks, and the full read-only guard (§7.1), including parse errors. A rejected query fails immediately with a reason and never gets a `resultId`. Only execution errors (timeout, database error, throttling) show up later in `get_result`.

### 5.3 `get_result`

```
get_result(resultId, wait?) → metadata
```

`wait` long-polls for at most **10 s** until the status changes, so the agent doesn't need many polling calls on long jobs. It is deliberately capped low: a waiting request transfers no data, and no connection should sit idle longer than that (§8.2). The response is always bounded in size. Once the result has data, it contains everything needed to plan `read_result` windows and downloads:

```json
{
    "resultId": "r_7Hq2kV…",
    "status": "succeeded",
    "source": "appdata",
    "createdAt": "2026-10-22T14:03:11Z",
    "completedAt": "2026-10-22T14:09:47Z",
    "expiresAt": "2026-10-23T14:09:47Z",

    "rowCount": 1840233,
    "availableRows": 1840233,
    "schema": {
        "columns": [
            { "name": "id", "type": "string", "sourceType": "string", "nullable": false },
            { "name": "status", "type": "string", "sourceType": "string", "nullable": true, "presence": 0.98 },
            { "name": "amount", "type": "number", "sourceType": "number", "nullable": true },
            { "name": "createdAt", "type": "datetime", "sourceType": "string", "nullable": false }
        ]
    },

    "window": { "maxRows": 500, "maxBytes": 65536, "maxValueChars": 2000 },

    "download": {
        "manifestUrl": "https://periscope.example.com/r/eyJ…/manifest.json",
        "urlExpiresAt": "2026-10-22T15:10:02Z",
        "format": "ndjson",
        "compression": "gzip",
        "fileCount": 19,
        "bytes": 412337911
    },

    "stats": { "elapsedMs": 396112, "sourceCost": { "ru": 18234.2 } },
    "error": null
}
```

| Field                                  | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`                               | `queued`, `running`, `succeeded`, `failed`, `cancelled` or `expired`                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `rowCount`                             | Total rows, known once `succeeded`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `availableRows`                        | Rows already materialized. They can be read with `read_result` while the query is still running.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `schema`                               | **SQL and KQL:** exact column names and types from the source. **Cosmos, KIM, REST and blob listings:** inferred while materializing, with field paths, types and `presence` (share of rows that have the field). `sourceType` is the native type; `type` is the normalized type. Parquet results also carry `parquetType`, the exact stored type. For very wide schemas (e.g. heterogeneous Cosmos documents), only the first 200 columns are inline (`schemaTruncated: true`); the full schema is in the manifest. |
| `window`                               | Limits for `read_result`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `download.manifestUrl`                 | **The single entry point for downloads.** The manifest (§6.4) lists every file with its row range, size and checksum, plus the block indexes. All its paths are relative to the manifest URL, so every other URL is derived from this one.                                                                                                                                                                                                                                                                           |
| `download.format`                      | Fixed per source type (§6.1): `parquet` for Postgres, Oracle, SQL Server and Log Analytics; `ndjson` with `compression: gzip` for Cosmos, Redis, KIM, REST and blob listings. Files are served exactly as stored (§6.4), so `.ndjson.gz` arrives compressed and is read with `zcat`, DuckDB `read_json` or pandas.                                                                                                                                                                                                   |
| `download.fileCount`, `download.bytes` | Number of files and total download size, exactly as stored and transferred. This lets the agent decide whether to download at all without fetching the manifest.                                                                                                                                                                                                                                                                                                                                                     |
| `urlExpiresAt`                         | The manifest URL, and every URL derived from it, is short-lived. Calling `get_result` again issues a fresh manifest URL until the result expires. Only the base changes; relative paths stay the same.                                                                                                                                                                                                                                                                                                               |
| `stats.sourceCost`                     | Source-specific cost: Cosmos RUs, KIM queries and REST requests sent, rows scanned where available                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `error`                                | For `failed`: a code, a message, and whether partial data is available                                                                                                                                                                                                                                                                                                                                                                                                                                               |

For blob, KIM and REST results, `download` also contains `blobCount` and `blobBytes`: the number and total size of the referenced blobs, offloaded KIM contents or linked REST responses (as far as the API reported their size).


While `running`, the response contains `progress` (`rows`, `bytes`, `files`, elapsed time) and all metadata known so far. The manifest URL is already available. It lists the files completed so far, so downloads can start while the query is still running.

### 5.4 `read_result`

```
read_result(resultId, offset?, limit?, columns?)           # rows of any result
read_result(resultId, file, lineOffset?, lineLimit?)       # blob, KIM and REST results: a referenced text file
read_result(resultId, file)                                # blob, KIM and REST results: a referenced image
```

- **Rows:** returns columns plus row arrays, which uses far fewer tokens than an array of objects:

  ```json
  { "columns": ["id", "status", "amount"], "rows": [["a1", "open", 12.5], …],
    "offset": 0, "nextOffset": 500, "status": "succeeded", "rowCount": 1840233, "truncatedValues": 3 }
  ```

  - `columns` projects to a subset of columns or JSON paths (Cosmos), for narrower windows.
  - Windows are capped by `window.maxRows` and `window.maxBytes`, whichever comes first.
  - Long values are truncated to `maxValueChars`, and vectors are shown as `<vector dim=1536>`. The response counts how many values were truncated. Downloads always contain the full values.
  - Windows can be read while the query is still running, up to `availableRows`. A window beyond that returns the current `status` and no rows, with `nextOffset` set to read from again; before the first rows of a Cosmos, Redis, KIM or blob result, `columns` is empty, as the schema is not inferred yet.
- **Text files** in a `files` result are read by line range, with the same byte cap. A line index makes this fast even for large files (§6.2).
- Windows on large results stay cheap: a window typically costs one small ranged read in the result store (§6.2).
- **Images** in a `files` result come back as MCP image content, up to a size limit.
- **Other binary content** (PDF, archives, Office documents) can't be read inline, only downloaded.

### 5.5 Typical agent flow

```
list_sources()                                                → appdata (cosmos), …
describe("appdata", "main/claims")                            → partition key, inferred schema
query("appdata", "SELECT * FROM c WHERE c.year = @y",
      { "@y": 2026 }, { "container": "claims" })              → r_7Hq2kV
read_result("r_7Hq2kV", limit: 20)                            → first rows, while still running
get_result("r_7Hq2kV", wait: 10)                              → succeeded, 1.8M rows, 19 files, 412 MB
M="<download.manifestUrl>"; B="${M%/manifest.json}"
curl -fsS "$M" | jq -r '.files[].path' | xargs -P4 -I{} curl -fsS --create-dirs -o {} "$B/{}"
duckdb -c "SELECT status, count(*) FROM read_json('part-*.ndjson.gz') GROUP BY 1"
```

For a Postgres, Oracle, SQL Server or Log Analytics result, the same flow yields `part-*.parquet`, read with `read_parquet('part-*.parquet')`.

---

## 6. Results and data plane

### 6.1 Result model

Every query produces a **result**, materialized in the result store:

```
results/<resultId>/
  manifest.json                public manifest (§6.4): format, schema, files, indexes
  state.json                   internal job state: creator, query hash, heartbeat, stats (never served)
  part-0000.parquet            (or part-0000.ndjson.gz, depending on the source type)
  part-0001.parquet
  …
  index/part-0000.json         index for every part: gzip members or row groups, plus Parquet stats (§6.4)
  index/files/….json           line index for referenced text blobs, built on first use (§6.2)
```

Everything except `state.json` is downloadable through the manifest URL. Blob results also expose the referenced source blobs under the virtual path `files/…` (§6.4), KIM results their offloaded contents, and REST results their binary responses. They are served from the source and never copied. Indexes live under `index/`, so they can never collide with blob names under `files/`.
- **Parts** are written as the query streams. Each part is a **self-contained file**, closed at about `PERISCOPE_RESULTS_PART_BYTES` (stored size) and recorded in the manifest with its row range, size and checksum. That's what makes reading during execution, paging by offset and parallel downloads possible. Most results consist of a single part.
- **The first part closes early**, after a few thousand rows or a few seconds, whichever comes first. The first rows of a long-running query are then readable almost immediately. Later parts close by size only, so slow queries don't produce many tiny parts.
- **Formats: exactly one per source type, with no format option.**

  | Source type                                   | Format                                                               | Why                                                                                                                                                                                                                                                                    |
  | --------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `postgres`, `oracle`, `mssql`, `loganalytics` | **Parquet**, ZSTD-compressed                                         | The result schema is known from the driver metadata before the first row, so typed columns can be written directly. DuckDB, pandas and polars read Parquet natively and fast, and DuckDB can query it over HTTP with Range requests without downloading it completely. |
  | `cosmos`                                      | **NDJSON**, block-compressed gzip, one document per line             | Documents are heterogeneous and nested. NDJSON keeps them exactly as stored, and `jq`, DuckDB `read_json` and pandas handle it directly.                                                                                                                               |
  | `blob` (listing)                              | **NDJSON**, block-compressed gzip, one blob per line                 | Metadata and tags are free-form maps.                                                                                                                                                                                                                                  |
  | `blob` (contents)                             | **Referenced in place** in the source, never copied                  | Served unchanged from the source (see blob results below).                                                                                                                                                                                                             |
  | `redis`                                       | **NDJSON**, block-compressed gzip                                    | Redis values have different shapes per type (strings, hashes, lists, sets, sorted sets, streams, JSON).                                                                                                                                                                |
  | `kim`                                         | **NDJSON**, block-compressed gzip, one document per record or object | KIM sends no column types before the rows, withheld fields are left out of records, and aggregates can mix numbers and decimal strings in one column. Offloaded contents are referenced in place (see KIM results below).                                              |
  | `rest`                                        | **NDJSON**, block-compressed gzip, one document per JSON element     | API responses are JSON of any shape. Binary responses are referenced and fetched again on read (see REST results below).                                                                                                                                               |

  `read_result` always returns the compact columns-plus-rows format, regardless of the stored format.
- **Parquet type mapping** (tabular sources). The mapping is defined once per source type and documented:
  - Integers, floats, booleans, strings, dates and timestamps map to their Parquet logical types (timestamps normalized to UTC).
  - Exact decimals with known precision (`numeric(p,s)`, Oracle `NUMBER(p,s)`, SQL Server `decimal(p,s)`) become `DECIMAL(p,s)`. Unconstrained `numeric` / `NUMBER` becomes `DECIMAL(38,s)` when it fits, otherwise a string, so values never silently lose precision. SQL Server `money` becomes `DECIMAL(19,4)` and `smallmoney` `DECIMAL(10,4)`.
  - SQL Server `bigint` becomes INT64. `datetime2` and `datetimeoffset` keep microseconds (their 100 ns ticks are truncated to microseconds), and `time` becomes a string with 7 fractional digits.
  - `json`/`jsonb` and KQL `dynamic` become strings with the JSON logical type.
  - Arrays and pgvector `vector` become lists.
  - `bytea`/`RAW`/`BLOB`/`varbinary` become binary, and `CLOB` becomes a string.
  - Intervals, ranges and other exotic types become strings.
  - Reader note for agents: polars reads JSON-typed columns as binary, so they need a cast to string. DuckDB and pyarrow read them as text.
- **`explain` results** are Parquet with a single text column (one plan line per row). For SQL Server it is the estimated plan from `SET SHOWPLAN_TEXT`: the statement is compiled, not executed, and the login needs the `SHOWPLAN` permission.
- **Blob results:**
  - **The result is the listing:** one row per selected blob, with name, size, content type, last modified, ETag (and version ID or snapshot if included), and metadata and tags if requested.
  - **Contents are referenced, not copied.** Every row carries a `file` path, relative to the manifest URL. It is used for downloads and for `read_result` (text and image windows). Periscope serves these paths straight from the source storage account through its read-only client (§6.4). Blobs that already exist are never duplicated, the result is complete as soon as the listing is, and the result store only holds the listing and indexes.
  - **Pinned to the state at query time.** Each reference carries the blob's ETag, or its version ID or snapshot when those were listed. Periscope reads with `If-Match: <etag>`, or addresses the exact version or snapshot. If a blob was changed or deleted after the query, the download fails cleanly with `412 Precondition Failed` or `404`, so the data can never silently differ from the listing. Re-running the query gives a fresh listing. With blob versioning enabled on the account, references to versions stay valid even after the blob is overwritten.
- **Redis results:**
  - **Single commands** produce rows that follow the reply shape:
    - a scalar becomes one row `{value}`
    - an array becomes one row per element `{index, value}`
    - hash replies become `{field, value}`
    - sorted sets `WITHSCORES` become `{member, score}`
    - stream entries become `{id, fields}`
  - **`SCAN`** (and `HSCAN`/`SSCAN`/`ZSCAN`) is iterated to completion: in cluster mode across all shards, throttled by `MAX_OPS_PER_SEC`.
    - **Rows:** one per key `{key}`. With `values: true` they become `{key, type, ttl, value}`, where `value` is a string, object (hash), array (list, set), `[{member, score}]` (sorted set), `[{id, fields}]` (stream) or parsed JSON (RedisJSON).
    - **Chunked fetching.** Large collections are fetched in chunks (`HSCAN`/`SSCAN`/`ZSCAN`, `LRANGE` and `XRANGE` ranges), never with one huge blocking command.
    - **Binary values.** Strings that aren't valid UTF-8 are base64-encoded and marked `"encoding": "base64"`.
    - **Duplicates.** `SCAN` can return a key twice. Periscope removes duplicates within a bounded memory budget, and flags the result with `mayContainDuplicates` if the key set is larger than that.
- **KIM results:**
  - **Record queries** produce one document per record, as KIM returns it. Withheld values are left out, and values KIM offloads (large text, bytes) arrive as `null`.
  - **Node queries** produce one document per object:
    - `url`, `version` and `classes` (plus `archived`, `anonymized` or `deleted` when set)
    - `values`: the picked values, nested, in KIM's object format
    - `shapes`: the shape of every picked path (`{"amount": "PreciseNumber"}`)
    - `withheld`: the paths KIM did not disclose, with the reason (`sensitive`, `secret`, `permission`, `anonymized`, …)
    - `files`: offloaded `Text`, `Bytes`, `Json` and `RichText` contents, each as a signed `files/…` link with its size
    - `related`: the nodes of other objects that the `pick` reached through reference crossings, by object URL
  - **Offloaded contents are referenced, not copied,** like blob contents. Each link is pinned to the object version (`v~<version>`), and Periscope serves it from KIM's Bytes API (`/bytes/<stage>/<collection>/<object>@<version>/<path>`) with Range, so text and image windows work as for blobs. The media type of a `File` object's content is read from its `mediaType` sibling.
  - **Paging.** KIM keeps no server-side cursor, returns at most 500 entries per window, and caps every answer at a 4 MiB result budget. Periscope therefore pages itself:
    - **Record queries:** Periscope appends `first <n> skip <m>`.
    - **Node queries without a window:** Periscope inserts `first <n> after (<anchors>, "<position>")`. The anchors are the last object's order keys, spelled as constructors in their own comparison domain (`Instant(2026-01-21T20:00:00Z)`, `PreciseNumber(1500.00)`); a bare string would compare as text. The order-key fields are added to `pick`, so their values are in the answer. Only plain `$.field` keys and `$::position` can be anchored; other orderings need a written window or a record query.
    - **A written window** (`first`/`last N`) and an `at` query are sent once, as written.
    - **Result budget.** When KIM answers `resultBudget`, the page size halves until the page fits.
- **REST results:**
  - **Without a `transform`:** a JSON array becomes one document per element and any other JSON value one document. A text response becomes `{ text }`, a `HEAD` response `{ status, contentType, size }`. Binary content of a `GET` becomes `{ contentType, size, file }`; binary content of another method can't be fetched again and fails the query. A response outside 2xx fails the query with its status and the start of its body.
  - **With a `transform`:** the documents it returns, page by page. Its `next` request is sent after it, until it returns none or `MAX_REQUESTS` is reached.
  - **Binary responses are referenced, not copied.** A link holds the URL, signed and bound to the result like a blob link. Reading it fetches the URL again through the wire guard and `prepare` (§7.1 C), with a Range request; if the API ignores Range, Periscope skips to the requested bytes itself. A link is not pinned: the content may have changed since the query. `transform` links any allowed `GET` URL with `context.file(url, name?)`, for instance the download URL in a file's metadata, under the file's real name. Without a `transform`, a link is named after the response's `Content-Disposition`, or else the URL's last path segment. Downloads send the name as `filename` (ASCII) and `filename*` (UTF-8, RFC 6266).
- **Consistency:**
  - **Postgres:** the query runs in a single `REPEATABLE READ READ ONLY` transaction, so the result is one snapshot.
  - **Oracle:** `SET TRANSACTION READ ONLY` gives read consistency across the whole query. Very long queries risk ORA-01555 (snapshot too old).
  - **SQL Server:** the query runs in a `SNAPSHOT` transaction when the database allows snapshot isolation, so the result is one snapshot; otherwise in `READ COMMITTED`. The transaction is always rolled back.
  - **KIM:** every page is read at one snapshot, pinned from the first answer (`clock.snapshot.to`, sent as `snapshotId` with every following page) or given with the `snapshotId` option, so the result is one snapshot.
  - **Cosmos, Log Analytics, Redis and REST** have no cross-page snapshot. Results reflect the data at the time each page was read.

### 6.2 Physical layout and random access

Results are **compressed at rest and served exactly as stored**. Each format is laid out so that `read_result` can jump to any row with one small ranged read from the result store, without decompressing whole files. Downloads are plain static bytes, so Range and resume work without any content negotiation.

**NDJSON: block-compressed gzip**
- **Blocks.** A part is a sequence of **independent gzip members ("blocks")**. A block holds about 1 MiB of uncompressed NDJSON, or at most 10,000 rows, whichever comes first. A row is never split across blocks. A single row larger than the block size (e.g. a Cosmos document near the 2 MB limit) gets a block of its own.
- **It's standard gzip.** Concatenated gzip members are valid gzip (RFC 1952), so the file is an ordinary `.ndjson.gz` for every tool: `zcat`, `gzip -d`, `jq` via `zcat`, DuckDB `read_json`, pandas and Python's `gzip` module. This is the same technique as BGZF in genomics. No special reader is needed.
- **Block index.** While writing, Periscope records each block's `rowStart`, `rowCount`, `byteOffset` and `byteLength` in `index/part-NNNN.json`, written when the part closes. Per 100 MB part that's a few hundred entries. It is the same file Periscope uses for `read_result`, and it can be downloaded like any other file (format in §6.4). Agents can therefore fetch arbitrary row ranges from a remote result with a plain HTTP Range request, without downloading the whole part.
- **Cost:** each block starts with an empty compression dictionary. At ~1 MiB per block that costs a few percent of compression ratio compared with one continuous stream.

**Parquet: row groups and pages**
- **Row groups.** Parquet has random access built in. Each part has several **row groups**, targeting about 50,000 rows or ~32 MiB uncompressed, whichever comes first. The file footer records each row group's row count and byte offsets of its column chunks.
- **Page index.** The writer also emits the Parquet **page index** (column and offset index), so a reader can find the pages that contain a given row range inside a row group.
- **Page size** is about 64 KiB, so every column chunk has several pages and the page index is actually written. Writers only emit it for chunks with more than one page.
- **No extra compression.** Parquet compresses internally per page (ZSTD), so it needs no outer compression.
- **Index file too.** Periscope also writes `index/part-NNNN.json` for Parquet parts, listing row groups and per-part column statistics. Periscope itself reads the footer, but agents get the same overview with `jq`, without a Parquet reader (§6.4).

**Text files in blob contents**

Blob contents stay in the source (§6.1). For text content types, Periscope builds a **line index** (the byte offset of every 1,000th line) **on the first line window** a caller requests for that blob. It streams the blob once from the source, pinned to its ETag, and stores the index under `index/files/…`. Later line windows on large log or CSV files then need one ranged read against the source as well. Offloaded KIM contents get the same line index, read pinned to the object version. Binary files get no index. They are only downloadable, except images (§5.4).

**How `read_result(offset, limit)` resolves a window**
1. The manifest's part list (`rowStart`, `rowCount`) gives the part that holds `offset`.
2. Within the part:
   - **NDJSON:** binary-search the block index for the block, then do **one ranged read** of that block from the result store. Decompress about 1 MiB, skip to the row, and continue into following blocks or parts until `limit` or the byte cap is reached.
   - **Parquet:** read the footer with one ranged read of the file tail, pick the row group (and pages, via the page index), then read **only the column chunks for the requested `columns`**.
3. Project the columns, truncate long values, and return the rows.

Replicas cache block indexes and Parquet footers in a small in-memory LRU, so consecutive windows usually cost a single ranged read. Typical windows touch 1–2 blocks or one row group, no matter how large the result is.

**Sizes**
- `PERISCOPE_RESULTS_PART_BYTES`, `MAX_RESULT_BYTES` and `download.bytes` all refer to **stored, compressed** bytes: exactly what is downloaded and what lands on the agent's disk.
- Block size and row-group size are internal defaults, documented but not configurable at first.

### 6.3 Execution

- **Jobs** run in the replica that accepted the `query` call. `state.json` holds a heartbeat. If a replica dies, the result switches to `failed` (with partial data, if any) and the agent can re-run the query.
- **Long-running queries** are bounded by `MAX_QUERY_DURATION` and `MAX_RESULT_BYTES` per source. They are independent of HTTP and MCP request timeouts.
- **Per source type:**
  - **Postgres:** server-side cursor inside the read-only transaction; `statement_timeout` is set from `MAX_QUERY_DURATION`.
  - **Oracle:** `queryStream` with a large fetch array size; `callTimeout` per round trip.
  - **SQL Server:** a streaming request inside the transaction, paused and resumed for backpressure; its request timeout is set from the time left until `MAX_QUERY_DURATION`.
  - **Cosmos:** paged query iteration, parallel across feed ranges, throttled to `MAX_RU_PER_SEC` so exports don't starve the application (429s). Uses priority-based execution if `LOW_PRIORITY` is set and the account supports it.
  - **Log Analytics:** a single query is capped by the service (about 500k rows and ~100 MB). Periscope splits large queries into time windows and writes one or more parts per window. Queries that can't be split (e.g. global aggregations) fail with a clear error when they exceed the cap.
  - **Blob:** listing via paged list or tag search. Contents are not copied (§6.1).
  - **Redis:** a single command, or a cursor loop for `SCAN` (per shard in cluster mode), throttled to `MAX_OPS_PER_SEC`. Values are fetched in pipelined batches. Large collections are fetched in chunks.
  - **KIM:** one HTTP query per page of at most 500 entries, at one pinned snapshot (§6.1); each request's timeout is the time left until `MAX_QUERY_DURATION`.
  - **REST:** one request at a time, the next one only after `transform` returned it, up to `MAX_REQUESTS`. Every response body is capped at `MAX_RESPONSE_BYTES`. Redirects are followed by Periscope itself, at most five hops, each one guarded (§7.1 C).
- **Limits:** concurrent queries per user, result size and duration per source, and a total size limit for the result store.
- **Cancellation:** `cancel_query` stops the job (`pg_cancel_backend` on Periscope's own session, `connection.break()` for Oracle, `request.cancel()` (a TDS attention) for SQL Server, aborting the Cosmos and Log Analytics iterators and the running KIM or REST request).

### 6.4 Downloads

**Serving**
- **One URL per result.** `get_result` returns only the manifest URL, `https://…/r/<token>/manifest.json`. The token covers the whole result. Every other file is addressed by its path relative to the manifest: `part-NNNN.<ext>`, `index/…`, `files/…`, resolved like any relative URL (RFC 3986). Path segments are percent-encoded, which matters for blob names. `HEAD` is supported for sizes. Only `state.json` is never served.
- **Token:** HMAC-signed with `PERISCOPE_DOWNLOAD_SIGNING_KEY`. It contains the result ID, the issuing user and an expiry (`PERISCOPE_DOWNLOAD_URL_TTL`). It's stateless, so it works on any replica. When it expires, a new `get_result` call yields a new base. Scripts only swap the prefix, and Range resume continues against the new base.
- **Served as stored.** Periscope streams the stored bytes from the result store with `Content-Length`, `ETag` and **Range** support. Interrupted downloads resume (`curl -C -`), and DuckDB can read Parquet parts remotely.
- **No transport re-encoding.** No file is ever compressed or decompressed in transit. Responses don't depend on `Accept-Encoding`, so agents don't need `curl --compressed`, and byte ranges always refer to the stored file. The file extension describes exactly what lands on disk: `.ndjson.gz` is gzip, while `.json` and `.parquet` files are stored and served as they are. Headers:

  | File                            | `Content-Type`                   | Notes                                                                                                                                                                                                                                                                                                                                                                                                   |
  | ------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `*.ndjson.gz`                   | `application/gzip`               | **No** `Content-Encoding: gzip`. Otherwise clients and gateways would transparently decompress, and ranges would refer to the wrong representation.                                                                                                                                                                                                                                                     |
  | `*.parquet`                     | `application/vnd.apache.parquet` |                                                                                                                                                                                                                                                                                                                                                                                                         |
  | `files/…`                       | The blob's original content type | **Proxied from the source storage account**, not from the result store. Read-only GET/HEAD with Range, pinned by `If-Match: <etag>` or by version ID or snapshot. Returns `412`/`404` if the blob changed or was deleted after the query. For KIM results, proxied from KIM's Bytes API, pinned to the object version. For REST results, fetched again from the API through the wire guard; not pinned. |
  | `manifest.json`, `index/….json` | `application/json`               | Plain, uncompressed JSON (small), so `jq` reads it directly                                                                                                                                                                                                                                                                                                                                             |

  All files carry `Cache-Control: private, no-store, no-transform`, so intermediaries neither cache nor re-encode them.
- **Why a proxy and not SAS:** the result store stays private, every download is audited, and there's no SAS generation at all.
- **Expiry:** after `PERISCOPE_RESULTS_RETENTION`, a storage lifecycle rule deletes the result and its status becomes `expired`.

**Manifest** (`manifest.json`, Periscope's own format, versioned, public contract)

The manifest is the same JSON document for every source type. It is the agent's map of the result: what the data looks like, where each row range lives, and how big each file is. Example for a Parquet result:

```json
{
    "version": 1,
    "resultId": "r_Q81mZc…",
    "source": "erp",
    "status": "succeeded",
    "format": "parquet",
    "rowCount": 5210448,
    "bytes": 287114203,
    "schema": {
        "columns": [
            {
                "name": "order_id",
                "type": "integer",
                "sourceType": "NUMBER(12,0)",
                "parquetType": "INT64",
                "nullable": false
            },
            {
                "name": "amount",
                "type": "decimal",
                "sourceType": "NUMBER(14,2)",
                "parquetType": "DECIMAL(14,2)",
                "nullable": true
            },
            {
                "name": "ratio",
                "type": "string",
                "sourceType": "NUMBER",
                "parquetType": "STRING",
                "nullable": true,
                "note": "unconstrained NUMBER exceeding DECIMAL(38); stored as string"
            },
            {
                "name": "created_at",
                "type": "datetime",
                "sourceType": "TIMESTAMP(6)",
                "parquetType": "TIMESTAMP(MICROS, UTC)",
                "nullable": false
            },
            {
                "name": "payload",
                "type": "json",
                "sourceType": "CLOB",
                "parquetType": "STRING (JSON)",
                "nullable": true
            }
        ]
    },
    "files": [
        {
            "path": "part-0000.parquet",
            "rowStart": 0,
            "rowCount": 1850112,
            "bytes": 101873620,
            "sha256": "…",
            "index": "index/part-0000.json"
        },
        {
            "path": "part-0001.parquet",
            "rowStart": 1850112,
            "rowCount": 1849870,
            "bytes": 101790447,
            "sha256": "…",
            "index": "index/part-0001.json"
        },
        {
            "path": "part-0002.parquet",
            "rowStart": 3699982,
            "rowCount": 1510466,
            "bytes": 83450136,
            "sha256": "…",
            "index": "index/part-0002.json"
        }
    ],
    "createdAt": "2026-10-22T14:03:11Z",
    "completedAt": "2026-10-22T14:11:02Z",
    "expiresAt": "2026-10-23T14:11:02Z"
}
```

- **Schema:** for Parquet results, every column carries its `parquetType`, so agents see exactly how values were stored, including the documented fallbacks (§6.1), e.g. a decimal stored as a string. For NDJSON results the schema is inferred and carries `presence` instead.
- **Format-specific fields:**
  - **NDJSON:** `format` is `ndjson`, `compression` is `gzip`, and parts are `part-NNNN.ndjson.gz`.
  - **Parquet:** `compression` is absent (Parquet compresses internally).
  - Everything else is identical.
- **While the query runs,** `status` is `running` and `files` grows as parts complete, so agents can start downloading early. A part is listed only once it is complete and its checksum is final.
- **For blob results,** `files` lists the listing parts, and the manifest adds `blobCount` and `blobBytes` (the total size of the referenced blobs). The listing rows reference the blob contents under `files/…`. KIM results carry the same two fields for their offloaded contents.

**Indexes** (`index/part-NNNN.json`, one per part, same envelope for every format)

Each index splits its part into **blocks**, each with a row range and byte range. What a block is depends on the format.

NDJSON (`unit: gzip-member`):

```json
{
  "version": 1,
  "file": "part-0000.ndjson.gz",
  "unit": "gzip-member",
  "columns": ["rowStart", "rowCount", "byteOffset", "byteLength"],
  "blocks": [[0, 10000, 0, 196233], [10000, 10000, 196233, 201877], …]
}
```

Each block is a complete gzip member, so any byte range covering whole blocks decompresses on its own:

```bash
# rows 10000–19999 of part 0, without downloading the part
curl -fsS -r 196233-398109 "$B/part-0000.ndjson.gz" | zcat
```

Parquet (`unit: row-group`), with column statistics:

```json
{
  "version": 1,
  "file": "part-0000.parquet",
  "unit": "row-group",
  "columns": ["rowStart", "rowCount", "byteOffset", "byteLength"],
  "blocks": [[0, 50000, 4, 2711093], [50000, 50000, 2711097, 2698411], …],
  "stats": {
    "order_id":   { "min": 100001,                 "max": 1950112,                "nullCount": 0 },
    "amount":     { "min": "0.00",                 "max": "98412.50",             "nullCount": 1204 },
    "created_at": { "min": "2024-01-02T00:00:00Z", "max": "2024-07-30T23:59:58Z", "nullCount": 0 }
  }
}
```

- **Row groups** list where each row group starts, by row and by byte. Unlike gzip members, a row-group byte range is **not** readable on its own: Parquet needs the file's footer. Agents read Parquet with a Parquet reader. DuckDB can read the part remotely and fetch only the footer and the needed column chunks. The block list mainly maps rows to row groups and shows their sizes.
- **`stats`** are per-part minimum, maximum and null count for scalar, orderable columns: numbers, dates, timestamps, and strings truncated to 64 characters. They are computed while writing, because the Parquet writer collects them for the footer anyway. Agents can use them to pick the parts they need **before downloading anything**, e.g. only parts whose `created_at` range overlaps a period:

  ```bash
  curl -fsS "$M" | jq -r '.files[].index' | while read i; do
    curl -fsS "$B/$i" | jq -r 'select(.stats.created_at.max >= "2024-06-01") | .file'
  done
  ```

  Row-group-level statistics stay in the Parquet footer, where Parquet readers already use them for pruning.

Text files (`unit: lines`, `index/files/<name>.json`): the same envelope, with `lineStart`, `lineCount`, `byteOffset` and `byteLength` per chunk of 1,000 lines. Blob contents stay unchanged in the source, so for uncompressed text a chunk is read directly from the source by its byte range.

---

## 7. Security

### 7.1 Read-only guarantee

**Principle.** Read-only must hold **even when the credential can write**: a shared database user, a database admin, a Cosmos or Storage account key. Read-only credentials are welcome as an extra layer where they are easy to set up, but the guarantee never relies on them. Every layer **fails closed**: anything that is not understood is rejected.

**Scope of the guarantee:** Periscope never writes to a **source**. It does write results to its **own result store**. That happens through a separate client with its own permission scope (§7.4), which can't reach sources, while sources can't be configured to point at the store.

The source types fall into three categories.

#### A. Writes are never offered: Cosmos DB, Blob Storage, Log Analytics, KIM

These APIs have a fixed set of operations, and Periscope only implements the read ones. There is no generic pass-through. KIM additionally takes a query text, which gets the short check described below.
1. **Read-only capability surface.** The source adapter interface has only read methods. A build-time check fails when source adapter code calls write-capable SDK methods: `create*`, `upsert*`, `replace*`, `delete*`, `patch*`, `upload*`, `set*`, `execute` (stored procedures), `acquireLease`, `generateSas*`, `beginCopy*`, …. The result store writer lives in a separate module that source adapters cannot import.
2. **Wire guard.** A guard at the SDK's HTTP layer checks every outgoing request against an allowlist and blocks everything else. It holds even when a bug or a future change calls a write method.

| Type          | Allowed on the wire                                                                                                                                                                                                                                                          | Blocked                                                                                                                                                                                                              |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cosmos DB     | `GET` (metadata, point reads, feeds); `POST` only with `x-ms-documentdb-isquery: true` (queries) or the query-plan header                                                                                                                                                    | `PUT`/`PATCH`/`DELETE`; any other `POST`: create/upsert, batch, **stored procedure execution**                                                                                                                       |
| Blob (source) | `GET`, `HEAD`                                                                                                                                                                                                                                                                | Everything else: upload, delete, set metadata/tags, leases, copy, snapshots                                                                                                                                          |
| Log Analytics | `POST …/query` against the query endpoint                                                                                                                                                                                                                                    | Everything else. The token is requested only for the query API, which has no write operations, and never for ARM (`management.azure.com`).                                                                           |
| KIM           | `POST` to `/rpc/live/query`, `/rpc/collection/listCollections` and `/rpc/resource/capabilities`, and to `/rpc/identity/exchangeApiKey` on the identity origin; `GET`/`HEAD` on `/bytes/…`; `GET` of type definitions in the stage's types collection, without a query string | Everything else, including drafts (a Reader can open drafts), live sessions and subscriptions, agents, file processing, backups, interchange, and `exchangeToken` (which can register users). Redirects are refused. |

The Cosmos NoSQL query language has no DML, and UDFs cannot write, so query strings need no filtering. For Cosmos, the wire guard is passed as the SDK's public `httpClient` option, through which every request goes (data plane, metadata, account discovery). For Storage it is a request policy factory appended to the pipeline of the only client the source creates; child clients inherit it. Two read-like operations are `POST` and therefore blocked as well: user delegation keys and quick query, neither of which Periscope uses.

**KIM.** Neither KIM query language has a writing clause. Periscope talks to KIM with no SDK, through one HTTP client of its own, in three layers:
1. **Credential.** A service account API key with only KIM's built-in _Reader_ role. Periscope exchanges it at `/rpc/identity/exchangeApiKey` for a token valid for one hour, and exchanges it again before it expires and on a `401`.
2. **Wire allowlist** (table above) in that client. Every request, including Periscope's own describe and file reads, is checked before it leaves the process.
3. **Query check**, synchronous in `query`. A lexer that understands KIM strings, comments, URLs and constructor payloads requires:
   - exactly one query, starting with `from`, `at` or `referrers of`
   - no `reveal` unless `ALLOW_REVEAL`: it discloses masked values, and KIM audits it
   - URLs (any `scheme://`) and `Reference(…)` literals only under the configured origin and stage, spelled exactly: no case variants, dot segments or encoded dots
   - no drafts: Periscope never sends a draft clock, only a snapshot

The credential is reported as `unverified`: KIM grants what the service account is assigned, and a Reader cannot inspect its own assignments.

#### B. Free-form query languages, filtered: Postgres, Oracle, SQL Server and Redis

Several independent layers per type. All guard checks run synchronously in `query`, before a result is created.

**Postgres**
1. **Engine: read-only transaction.** Every query runs as `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL statement_timeout = …; <query>; ROLLBACK`. There is never a COMMIT. Postgres itself then rejects INSERT/UPDATE/DELETE/MERGE, all DDL, GRANT/REVOKE, TRUNCATE and sequence changes. That includes writes inside functions and to foreign tables.
2. **Syntax-tree guard (`libpg-query`).** Allows exactly one `SelectStmt`, or `EXPLAIN` of one. It rejects:
   - `SELECT … INTO` (creates a table)
   - `FOR UPDATE`/`FOR SHARE`
   - data-modifying CTEs (`WITH x AS (DELETE … RETURNING *) SELECT …`); every CTE is checked

   Queries run over the extended query protocol, which also rejects multiple statements.
3. **Routine inventory.** This covers side effects that a read-only transaction does _not_ prevent:
   - **Blocked by name:**
     - `dblink*`, `oracle_execute` (oracle_fdw can run arbitrary statements remotely), `pg_background*`, `cron.*`
     - `pg_advisory*`, `pg_notify`, `pg_terminate_backend`, `pg_cancel_backend`, `pg_reload_conf`, `set_config`, `lo_*`
     - also `pg_logical_emit_message`, `pg_stat_reset*`, `pg_stat_statements_reset`, replication-slot and replication-origin functions, `pg_create_restore_point`, `pg_backup_*`, `pg_read_file`/`pg_ls_*`, `nextval`/`setval`, `txid_current`, `pg_sleep`
     - functions that run a query given as text or read a relation given by name, which the guard never sees: `query_to_xml*`, `cursor_to_xml*`, `table_to_xml*`, `schema_to_xml*`, `database_to_xml*`, `ts_stat`, `ts_rewrite`
   - **Views.** Postgres records no dependencies on built-in functions, so `pg_depend` cannot show that a view calls e.g. `pg_advisory_lock`. At startup Periscope therefore parses every readable view definition (`pg_get_viewdef`) with the same parser and blocks views that call a blocked function, transitively through views that read other blocked views. A definition that cannot be parsed blocks its view (fail closed).
   - **Strict mode.** The experiments showed that a user-defined function or a view can wrap `dblink_exec` invisibly, and the remote write persists despite the read-only transaction. So if the role can execute any function that writes outside the transaction (`dblink*`, `oracle_execute`, `pg_background*`, or functions in untrusted languages), the source switches to strict mode: every user-defined function, and every view that uses one, is blocked unless allowlisted with `ALLOW_ROUTINES`.
   - Otherwise plain user-defined functions stay allowed, because the engine blocks their local writes.
   - **Session state.** Session-level advisory locks survive ROLLBACK, so `pg_advisory_unlock_all()` runs before a connection returns to the pool.

**Oracle (reference: 19c, often with a shared write-capable credential)**

Oracle before 23ai has no session-level read-only mode, and DDL commits implicitly, so the statement filter carries the DDL protection.

| Write vector                                            | Blocked by                                                                                                                 |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| DML (INSERT/UPDATE/DELETE/MERGE), `SELECT … FOR UPDATE` | Engine: `SET TRANSACTION READ ONLY` before every query and `ROLLBACK` after it, autocommit off. Also the statement filter. |
| DML inside functions called from a query                | Engine (ORA-14551). Also the statement filter.                                                                             |
| **DDL** (implicit commit)                               | **Statement filter** (see below)                                                                                           |
| PL/SQL blocks, `WITH FUNCTION/PROCEDURE`                | Statement filter                                                                                                           |
| Autonomous transactions, dynamic SQL in routines        | Routine inventory                                                                                                          |
| Side-effecting system packages                          | System package allowlist                                                                                                   |
1. **Statement filter.** A strict lexer handles comments, string literals including the `q'[…]'` syntax, and quoted identifiers. Any character or construct it does not recognize leads to rejection, including Unicode spaces and invisible characters outside literals. A `--` comment ends at CR or LF; a comment containing another line break character is rejected. Rules:
   - exactly one statement
   - first keyword `SELECT` or `WITH`
   - none of: `WITH FUNCTION`/`PROCEDURE`, PL/SQL blocks (`BEGIN`/`DECLARE`), `FOR UPDATE`, `NEXTVAL` (sequences advance even in a read-only transaction), `;`, database links (`@…`, unless `ALLOW_DBLINKS`)
   - one trailing `;` or `/` is removed before the statement is sent
2. **No `getStatementInfo()` check.** The experiments showed that node-oracledb's thin mode sends many statements to the server as a parse call, and Oracle then executes some DDL (`RENAME`, `FLASHBACK TABLE`, `PURGE`). It is therefore not used at all; the lexer is the only DDL guard.
3. **Routine inventory** (at startup, refreshed every 10 minutes), in one of two modes:
   - **Precise**, when the credential can read `DBA_SOURCE` and `DBA_DEPENDENCIES` (e.g. `SELECT_CATALOG_ROLE`): routines whose source contains `PRAGMA AUTONOMOUS_TRANSACTION`, `EXECUTE IMMEDIATE`, `DBMS_SQL`, `DBMS_JOB`/`DBMS_SCHEDULER`, `DBMS_PIPE`/`DBMS_LOCK`/`DBMS_AQ` or `UTL_*`, or that are wrapped, are blocked.
   - **Conservative**, otherwise. Without catalog access a user cannot see package bodies or routines it does not reference directly, so every user-defined routine is blocked.

   In both modes everything that depends on a blocked routine (views, other routines, synonyms, tables with virtual columns) is blocked too, transitively. Matching is **by name**, because Oracle allows calling zero-argument functions without `()`. A reviewed routine can be cleared per source with `ALLOW_ROUTINES`; its dependents are then not blocked because of it.
4. **System package allowlist.** References to `DBMS_*`, `UTL_*` and `SYS.*` are allowed only for read-only packages and functions, such as `DBMS_METADATA.GET_DDL`, `DBMS_LOB.SUBSTR`/`GETLENGTH` and `DBMS_XPLAN`. Everything else is blocked, e.g. `DBMS_PIPE`, `DBMS_LOCK`, `UTL_HTTP`.
5. **Optional, engine-side.** A `BEFORE DDL` trigger that raises an error when `SYS_CONTEXT('USERENV','MODULE') = 'periscope'`. Periscope sets the module name on every connection. This adds DDL protection in the database itself without needing a separate user. It is a recommended operator setup, not a requirement.
6. **Oracle 23ai and newer:** additionally enable the session-level read-only mode where available.

**SQL Server (SQL Server, Azure SQL Database, Azure SQL Managed Instance)**

SQL Server has no read-only transaction mode, and T-SQL runs several statements in one batch. So the layers are a transaction that is always rolled back, a strict statement filter, a routine inventory, and optionally a read-only replica:
1. **Engine: transaction that is always rolled back.** Every query runs in a transaction (`SNAPSHOT` or `READ COMMITTED`, §6.1) that ends with `ROLLBACK`. There is never a COMMIT. The experiments showed that INSERT/UPDATE/DELETE and `CREATE`/`DROP TABLE` are undone. A sequence advanced by `NEXT VALUE FOR` is not, `CREATE DATABASE` is not allowed inside a transaction at all, and side effects outside the database (extended procedures, OLE Automation, CLR, linked servers) are not undone either. The next two layers cover those.
2. **Statement filter.** A strict lexer handles comments (which nest in T-SQL), string literals including `N'…'`, bracketed and quoted identifiers, and variables. Any character it does not recognize leads to rejection, including Unicode spaces and invisible characters outside literals. A `--` comment ends at CR or LF, because SQL Server ends it at a lone CR; a comment containing another line break character is rejected. T-SQL runs several statements in one batch even without semicolons (`SELECT 1 DELETE FROM t`), so checking the first keyword is not enough. Rules:
   - first keyword `SELECT` or `WITH`
   - a second top-level `SELECT` only directly after `UNION`, `EXCEPT` or `INTERSECT` (`ALL`)
   - none of these keywords anywhere in the statement: statement keywords (`INSERT`, `UPDATE`, `DELETE`, `MERGE`, `EXEC`/`EXECUTE`, `CREATE`, `ALTER`, `DROP`, `TRUNCATE`, `GRANT`, `DBCC`, `BACKUP`, `BULK`, …), batch and control-flow keywords (`SET`, `DECLARE`, `BEGIN`, `WAITFOR`, `USE`, `GO`, …), `INTO` (`SELECT … INTO` creates a table), the remote rowset functions `OPENQUERY`, `OPENROWSET` and `OPENDATASOURCE`, and locking hints that hold or escalate locks for the whole export (`UPDLOCK`, `XLOCK`, `TABLOCK`, `TABLOCKX`, `HOLDLOCK`, `PAGLOCK`, `SERIALIZABLE`, `REPEATABLEREAD`)
   - no `NEXT VALUE FOR` (the sequence advances despite the rollback)
   - no four-part names (`server.database.schema.object`), which reach linked servers, unless `ALLOW_LINKED_SERVERS`
   - no `;`, except one trailing `;`, which is removed before the statement is sent
3. **Routine inventory** (at startup, refreshed every 10 minutes). User-defined functions cannot change data, but the experiments showed that a function can still run extended stored procedures (`EXEC xp_msver` inside a function worked). So:
   - Functions whose definition uses `EXEC`, `xp_…`, `sp_OA…` (OLE Automation) or a remote rowset, CLR functions, and functions whose definition cannot be read are always blocked.
   - **Strict mode.** If the login is `sysadmin`, `xp_cmdshell`, OLE Automation or CLR is enabled, the database is `TRUSTWORTHY`, or linked servers exist, every user-defined function is blocked unless allowlisted with `ALLOW_ROUTINES`, and so is every view whose definition cannot be read. `list_sources` names the reasons.
   - Views and functions that reference a linked server are blocked unless `ALLOW_LINKED_SERVERS`.

   Everything that depends on a blocked object (per `sys.sql_expression_dependencies`) is blocked too, transitively. Matching is **by name**, as for Oracle. A reviewed routine can be cleared per source with `ALLOW_ROUTINES`; its dependents are then not blocked because of it.
4. **Read-only replica (optional, engine-side).** With `READ_INTENT`, connections use `ApplicationIntent=ReadOnly` and are routed to a readable secondary where the service provides one; the engine then rejects every write. Periscope reports this in `list_sources` when the database's `Updateability` (`DATABASEPROPERTYEX`) is `READ_ONLY`.

The credential is reported as write-capable if the login is `sysadmin`, `db_owner`, `db_datawriter` or `db_ddladmin`, or holds `INSERT`, `UPDATE`, `DELETE`, `ALTER` or `CREATE TABLE` on the database, unless it is connected to a read-only replica.

**Redis**

Redis has no read-only session mode on a primary, and some commands that look like reads actually write. So the layers are a strict command allowlist, a guard in the client, and optionally replicas:
1. **Command allowlist** for the user's query. A tokenizer that understands Redis quoting parses it into one command with arguments. Only explicitly listed read-only, non-blocking commands are accepted, including their allowed subcommands and options:
   - **Strings and keys:** `GET`, `MGET`, `GETRANGE`, `STRLEN`, `EXISTS`, `TYPE`, `TTL`, `PTTL`, `EXPIRETIME`, `PEXPIRETIME`, `RANDOMKEY`, `DBSIZE`
   - **Hashes:** `HGET`, `HMGET`, `HGETALL`, `HKEYS`, `HVALS`, `HLEN`, `HEXISTS`, `HSTRLEN`, `HRANDFIELD`
   - **Lists:** `LRANGE`, `LINDEX`, `LLEN`, `LPOS`
   - **Sets:** `SMEMBERS`, `SISMEMBER`, `SMISMEMBER`, `SCARD`, `SRANDMEMBER`, `SINTER`, `SUNION`, `SDIFF`, `SINTERCARD`
   - **Sorted sets:** `ZRANGE` (without `STORE`), `ZRANGEBYSCORE`, `ZRANGEBYLEX`, `ZREVRANGE…`, `ZSCORE`, `ZMSCORE`, `ZRANK`, `ZREVRANK`, `ZCARD`, `ZCOUNT`, `ZLEXCOUNT`, `ZRANDMEMBER`
   - **Streams:** `XRANGE`, `XREVRANGE`, `XLEN`, `XINFO STREAM|GROUPS|CONSUMERS`, `XPENDING`
   - **Bitmaps and geo:** `BITCOUNT`, `BITPOS`, `GETBIT`, `BITFIELD_RO`, `GEOSEARCH` (without `STORE`), `GEOPOS`, `GEODIST`, `GEOHASH`, `GEORADIUS_RO`, `SORT_RO`
   - **RedisJSON:** `JSON.GET`, `JSON.MGET`, `JSON.TYPE`, `JSON.OBJKEYS`, `JSON.OBJLEN`, `JSON.ARRLEN`, `JSON.STRLEN`
   - **Introspection:** `MEMORY USAGE`, `OBJECT ENCODING|IDLETIME|FREQ`
   - **Iteration:** `SCAN`, `HSCAN`, `SSCAN`, `ZSCAN`

   Everything else is rejected, notably these **read-looking or harmful** commands:
   - `GETEX`, `GETDEL`, `GETSET`: they change TTL or value.
   - `SPOP`, `LPOP`/`RPOP`/`LMPOP`, `ZPOPMIN`/`ZPOPMAX`: they remove what they return.
   - `BLPOP`/`BRPOP`/`BLMOVE`/`BZPOP…`, `XREAD … BLOCK`: they block, and many also write.
   - `XREADGROUP`, `XCLAIM`, `XAUTOCLAIM`: they change consumer-group state.
   - `SORT`, `GEORADIUS`: their `STORE` options write; the `_RO` variants are allowed instead.
   - `PFCOUNT`: it may rewrite the HyperLogLog's cached cardinality.
   - `TOUCH`: it changes access metadata.
   - `KEYS`: O(N) and blocking; `SCAN` is used instead.
   - Every scripting and transaction command: `EVAL`/`EVALSHA`/`FCALL` and their `_RO` variants, `MULTI`/`EXEC`.
   - Pub/sub and `MONITOR`, `SELECT` (the database comes from configuration), and all `CONFIG`, `CLIENT`, `DEBUG`, `FLUSH*`, `MODULE` and `ACL` commands.
2. **Client guard.** Periscope's Redis client is wrapped so that **every** command sent on the wire, including Periscope's own internal ones, is checked against the same allowlist plus the handshake and topology commands the client needs (`HELLO`, `AUTH`, `PING`, `READONLY`, `CLUSTER SLOTS|SHARDS`). This is Redis's counterpart to the wire guard in category A, and it holds even if a code path builds a write command by mistake.
3. **Replicas (optional, engine-side).** With `READ_FROM_REPLICAS`, reads go to replicas. Redis replicas reject writes themselves (`READONLY You can't write against a read only replica`).
4. **Credential (optional extra).** An ACL user restricted to `+@read -@write -@dangerous -@scripting`, or a service access policy such as _Data Reader_ where the managed Redis offering provides one.

#### C. Operator-declared reads: REST

HTTP methods say whether a request writes only by convention, and an API may offer anything on any path. So no list of reads is built into Periscope: the operator declares, per source, which requests are reads, and Periscope sends nothing else.
1. **Request allowlist.** Every request must match an `ALLOW` rule (`METHOD pattern`, §4.2) in method, origin and path. `HEAD` counts as `GET`. A URL Periscope does not fully understand is rejected rather than interpreted, because a server may resolve it to another path than the one checked:
   - dot segments and empty segments, also percent-encoded (`%2e`)
   - encoded slashes and backslashes (`%2f`, `%5c`), backslashes, spaces and control characters
   - user info and fragments, schemes other than `http` and `https`
2. **No method override.** The headers `X-HTTP-Method-Override`, `X-HTTP-Method` and `X-Method-Override` and query parameters of these names or `_method` are always rejected: a server may treat a `GET` that carries one as a `DELETE`.
3. **Agent input is limited.** An agent may set only the headers in `ALLOW_HEADERS` and a few harmless defaults, never credentials, and a `GET` or `HEAD` has no body. Periscope adds credentials through the script.
4. **Script check (optional).** The script's `check` sees every request and rejects one by throwing, for rules a path pattern cannot express (a query parameter's value, a body field).
5. **Wire guard.** All of this is checked synchronously in `query`, and again for every request that leaves the process: after `prepare` changed it, for every `next` request of `transform`, for every redirect hop and for every file read. Periscope follows redirects itself; for each hop `prepare` runs again for the new URL, so credentials reach another origin only if the script adds them there.

**The script is configuration.** The operator writes and deploys it, like the allowlist. Its own `fetch` calls (sign-in, token refresh) are not checked: they go to identity endpoints Periscope cannot know. Every request that carries agent input is checked.

**What the guarantee rests on.** It holds as far as the allowed requests are reads for the API. Allow only methods and paths the API documents as reads, and `POST` only for a known read endpoint (a search, a GraphQL query endpoint that takes no mutations). The credential is reported as `unverified`.

#### Known limits

- **Database-owned policy functions.** VPD and FGA handlers run on SELECT and are owned by the database. Periscope cannot control them, and they are not a path for agent-triggered writes.
- **Read-only does not mean no load.** Large queries put real load on sources. The mitigations are duration and size limits per source, a Cosmos RU budget, concurrency limits, and cancellation. Operators should take care when connecting production sources (§7.3).
- **APIs that write on a read.** An HTTP API that changes data on a `GET` defeats a `rest` allowlist that covers the path. Such paths must stay out of `ALLOW`.

### 7.2 Authentication

**No static API keys.** They cannot identify the user, they don't expire, and they end up in configs. Users always sign in with Microsoft Entra ID. Periscope supports two modes (`PERISCOPE_AUTH`):

| Mode | Authorization server for MCP clients | Entra app registration | Use when |
|---|---|---|---|
| `entra` | Entra ID itself; Periscope is an **OAuth 2.1 resource server** | Application ID URI = the MCP URL on a **verified domain**, exposed scope | the Periscope host is on a domain verified in the tenant |
| `entra-broker` | **Periscope**, which signs the user in at Entra (see *Broker mode* below) | plain web app: one redirect URI, app roles; no identifier URI, no scope | the host is not on a verified domain |

MCP clients send the MCP URL as the RFC 8707 `resource` parameter, as the MCP specification requires, and no Claude client can change or omit it. Entra accepts that only if it matches an Application ID URI of the app, and HTTPS Application ID URIs are limited to verified domains. An `api://` identifier fails with `AADSTS9010010`. Without a verified domain, only broker mode works.

#### Direct mode (`entra`)

**What Periscope does:**
- **Discovery.** Serves Protected Resource Metadata (RFC 9728) at `/.well-known/oauth-protected-resource/mcp`:

  ```json
  {
    "resource": "https://periscope.example.com/mcp",
    "authorization_servers": ["https://login.microsoftonline.com/<tenant-id>/v2.0"],
    "scopes_supported": ["https://periscope.example.com/mcp/Periscope.Access"],
    "bearer_methods_supported": ["header"]
  }
  ```

  `scopes_supported` must contain the **fully qualified** scope (App ID URI plus scope name). Entra rejects a bare scope name combined with the `resource` parameter.
- **Challenge.** Answers unauthenticated requests with `401` and `WWW-Authenticate: Bearer resource_metadata="https://periscope.example.com/.well-known/oauth-protected-resource/mcp", scope="https://periscope.example.com/mcp/Periscope.Access"`. Claude Code takes the scope from this challenge; claude.ai takes it from `scopes_supported`.
- **Validation.** Checks every bearer token against the tenant's JWKS:
  - `iss` = `https://login.microsoftonline.com/<tenant-id>/v2.0`, `ver` = `2.0`, `tid`
  - `aud` = **the app's client ID (GUID)**. With v2 tokens, `aud` is always the GUID, never the URL.
  - `exp`/`nbf`
  - `scp` contains `Periscope.Access`
  - app roles in `roles`
  - optionally `azp` against an allowlist of known client IDs
- **Audit.** Writes `oid`/`upn` into the audit log for every call.
- **No OAuth token issuance.** In this mode Periscope never issues OAuth tokens. It only signs download URLs (§6.4).

**Entra setup**, one app registration per deployment (e.g. with the `azuread` Terraform provider). The order and exactness matter:

| Setting              | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Access token version | `requestedAccessTokenVersion = 2`.**Set this first.** Apps on v1 tokens can't use custom HTTPS identifier URIs.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Application ID URI   | **Exactly** the MCP URL, `https://periscope.example.com/mcp`. Path-qualified, no trailing slash, on a **verified domain** (platform default domains don't work). MCP clients send this URL as the RFC 8707 `resource` parameter, and Entra v2 accepts `resource` only if it matches an identifier URI of the app that owns the requested scope character for character. Otherwise it fails with `AADSTS9010010` / `invalid_target`. The path-qualified form also avoids a known client-side problem where host-only URLs get a trailing `/` appended. |
| Exposed scope        | `Periscope.Access` (delegated). Clients request `https://periscope.example.com/mcp/Periscope.Access`, plus `offline_access` for refresh tokens.                                                                                                                                                                                                                                                                                                                                                                                                       |
| App roles            | `Periscope.Reader`, the only role (§7.3)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Assignment required  | Yes, assigned to an Entra group. Users outside the group can't get a token at all.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Redirect URIs        | **Web** (confidential, with a client secret for claude.ai): `https://claude.ai/api/mcp/auth_callback`.**Mobile and desktop** (public client, PKCE, for Claude Code): `http://localhost` and `http://127.0.0.1` loopback redirects.                                                                                                                                                                                                                                                                                                                    |
| Consent              | Admin consent for the scope, so users aren't prompted and the scope can't be requested by unknown clients                                                                                                                                                                                                                                                                                                                                                                                                                                             |

Entra has no Dynamic Client Registration and no Client ID Metadata Documents, so clients use this **pre-registered client ID**. Entra only serves OIDC discovery (`/v2.0/.well-known/openid-configuration`, no RFC 8414 path). Claude falls back to it, and PKCE (S256) works even though Entra's metadata doesn't advertise it.

**How each client connects:**

| Client                                                                       | How                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **claude.ai custom connector** (preferred)                                   | An org admin adds one connector per deployment: URL, client ID and client secret (Team/Enterprise: only admins can add connectors). Each user signs in to Entra once, and claude.ai stores and refreshes the token. The connector is then available in **Claude Code on the web**, in **scheduled cloud tasks (routines)** and in **local Claude Code** when logged in with the claude.ai account. Connector traffic is routed through Anthropic's servers, so cloud environments need no network allowlist entry for `/mcp`.        |
| `claude mcp add` / `.mcp.json` (local fallback)                              | `claude mcp add --transport http --client-id <id> --callback-port <port> periscope https://periscope.example.com/mcp`. Alternatively a `headersHelper` running `az account get-access-token --scope https://periscope.example.com/mcp/.default`, which needs the Azure CLI pre-authorized on the scope.                                                                                                                                                                                                                              |
| **Unattended cloud agents** (scheduled tasks / routines, API-triggered runs) | They use the claude.ai connectors of the user who owns the task, and everything they do through Periscope appears as that user (audit log included). Claude refreshes tokens before they expire. The Entra refresh token has a sliding lifetime of about 90 days, unless Conditional Access sign-in frequency shortens it. If the refresh token dies, there is no unattended re-authentication: runs fail on Periscope calls until the user reconnects the connector in claude.ai. Scheduled tasks are currently a research preview. |

**Known risks of direct mode:**
- **End to end with Claude Code against a path-qualified App ID URI.** Microsoft and Anthropic both document this configuration, but no first-hand report of a successful Claude Code sign-in has been found yet.
- **Reconnects.** Community reports describe an Entra error on reconnect, where the requested scope falls back to Microsoft Graph (`AADSTS650053`). Broker mode is not affected: Claude only ever talks to Periscope.

**Network.**
- **The endpoints must be publicly reachable over IPv4** for claude.ai connectors and cloud sessions.
- **Cloud downloads need an allowlist entry.** Connector traffic needs no allowlist, but downloads (`curl` from the sandbox) do: the Periscope hostname must be in the cloud environment's network access list (Custom access level). Otherwise the sandbox gets `403` with `x-deny-reason: host_not_allowed`.
- **No IP allowlisting is planned.** Security rests on authentication (OAuth for `/mcp`) and on signed, expiring URLs (for `/r/…`). Operators who want an extra network layer can restrict `/mcp` at their gateway to Anthropic's published egress range (`160.79.104.0/21`) plus their own egress addresses. That is purely optional and not part of Periscope. An IP allowlist on the _claude.ai organization_ itself is a different feature: it breaks Anthropic-hosted cloud sessions.

#### Broker mode (`entra-broker`)

Periscope is the **authorization server** towards MCP clients and an ordinary **confidential web client** towards Entra. The user still signs in at Entra, and every request carries that user.

| Step | What happens |
|---|---|
| Discovery | Protected Resource Metadata names Periscope itself as authorization server; RFC 8414 metadata at `/.well-known/oauth-authorization-server` |
| Registration | Dynamic client registration at `/oauth/register`, **stateless**: the client ID is the registered metadata plus an HMAC. Redirect URIs must be loopback (`http://localhost`, `127.0.0.1`, `[::1]`, any port) or listed in `PERISCOPE_AUTH_REDIRECT_URIS` (default: the claude.ai and claude.com connector callbacks), so a registered client can never send codes elsewhere. Public clients (`none`) and confidential ones (`client_secret_post`/`_basic`, secret = HMAC of the client ID) |
| Authorization | `GET /oauth/authorize` requires `response_type=code`, PKCE S256, a registered redirect URI (loopback on any port, RFC 8252) and, if sent, `resource` = the MCP URL (a trailing slash is tolerated). It answers with a **consent page** that names the client and its redirect host. Entra would sign a user in silently (single sign-on), so without this step a crafted link could hand a session to a client the user never started |
| Confirmation | The page posts back to `POST /oauth/authorize`. The request is sealed and bound to an HttpOnly `SameSite=Lax` cookie set with the page; browsers don't send that cookie on cross-site POSTs, so another site cannot confirm for the user. The page can't be framed. Periscope then redirects to Entra with its own PKCE, a nonce, scopes `openid profile offline_access` and an encrypted `state` (10 min) bound to the same cookie |
| Callback | `/oauth/callback` checks state and cookie, redeems the Entra code with a **client assertion** (the federated service account token of workload identity, or a token of a managed identity the app registration trusts) or a client secret, and verifies the ID token: signature (JWKS from Entra's discovery), issuer, audience, nonce, tenant, `oid`, and the required app role. It returns its own authorization code (encrypted, 2 min, single use) with `state` and `iss` (RFC 9207) |
| Token | `/oauth/token` checks the client, the redirect URI and PKCE, then issues an **access token** (HS256 JWT, `typ` `at+jwt`, `aud` = the MCP URL, 1 h) and a **refresh token** (encrypted, bound to the client, carries the Entra refresh token, valid for the session length, 30 days by default) |
| Refresh | Every refresh signs in at Entra again with the Entra refresh token and re-reads the roles. A disabled account, a revoked session or a removed app role ends the session at the next refresh, so within the access token lifetime. An Entra outage answers `temporarily_unavailable` (503), so clients keep their refresh token; only a refusal by Entra answers `invalid_grant` |

**Keys and state.** All keys are derived (HKDF, one key per purpose) from `PERISCOPE_DOWNLOAD_SIGNING_KEY`; rotating it signs everybody out. Nothing is stored except a replay cache for authorization codes, which only has to outlive a code (2 minutes). Replicas behind a load balancer share everything else through the key.

**Known limits of the stateless design:**
- **Refresh tokens can't be revoked one by one.** A refreshed token doesn't invalidate its predecessor, so a leaked refresh token stays usable until the session ends. Every use still signs in at Entra, so disabling the account, revoking its sessions or removing the app role stops it within an hour; rotating the signing key stops all.
- **The replay cache is per replica.** With several replicas, a code could be redeemed once per replica within its 2 minutes, but only by the client holding the PKCE verifier. Run one replica or route `/oauth/token` stickily for strict single use.

**Entra setup:** one app registration with a **web** redirect URI `https://<host>/oauth/callback`, the app roles, *assignment required*, and a credential: a **federated identity credential** for the Periscope service account (AKS: issuer = the cluster's OIDC issuer, subject `system:serviceaccount:<namespace>:<account>`) or for its managed identity (Container Apps, App Service: issuer `https://login.microsoftonline.com/<tenant>/v2.0`, subject = the identity's principal ID, `PERISCOPE_AUTH_ASSERTION_IDENTITY`), audience `api://AzureADTokenExchange` in both cases; or a client secret. No Application ID URI, no exposed scope, no admin consent for a custom scope.

**Clients:** Claude Code (`claude mcp add --transport http periscope https://<host>/mcp`, no client ID needed) and the claude.ai connector (URL only) register themselves.

### 7.3 Authorization

- **One app role.** `PERISCOPE_AUTH_REQUIRED_ROLE` (by default `Periscope.Reader`) grants access to every source of the deployment, including downloads. There are no per-source roles: a deployment serves one environment, and data that needs a different audience belongs in a separate deployment.
- **Results are not isolated between users.** A result is just the output of a read-only query, and anyone with the role could run the same query:
  - `get_result`, `read_result` and `cancel_query` work for every holder of the role.
  - The role is checked on every call, so revoking it takes effect immediately (in broker mode at the next token refresh, within the access token lifetime).
  - Result IDs can therefore be handed between agents and team members.
  - The internal job state records who created a result, and the audit log records every access.
- **Download URLs** are bearer capabilities, because `curl` in a sandbox can't do OAuth. They are bound to one result and expire after `PERISCOPE_DOWNLOAD_URL_TTL`. They are only issued to holders of the role, and every download is audited with the user who issued the URL. Rotating the signing key revokes all of them.

### 7.4 Identities and permissions

Periscope uses **its own user-assigned managed identity** and its own secrets. Don't reuse the application's identity, which typically holds write roles. Users are authorized at Periscope, and the data sources only trust Periscope (trusted subsystem). Read-only roles should be assigned where it costs nothing, as extra defense:

| Target           | Recommended credential                                                                                                                                                                                                                                   | Required for the guarantee?                                                   |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Cosmos DB        | Managed identity, _Cosmos DB Built-in Data Reader_ (`…0001`). Alternatively a connection string.                                                                                                                                                         | No (wire guard)                                                               |
| Blob (source)    | Managed identity, _Storage Blob Data Reader_. Alternatively a connection string or SAS.                                                                                                                                                                  | No (wire guard)                                                               |
| Log Analytics    | Managed identity, _Log Analytics Reader_ on the workspace                                                                                                                                                                                                | No (query API is read-only)                                                   |
| Redis            | A read-only ACL user (`+@read -@write -@dangerous -@scripting`) or a _Data Reader_-style access policy where available; otherwise the existing credential. Entra auth with the managed identity where supported.                                         | No (command allowlist, client guard)                                          |
| KIM              | A service account API key with only the built-in _Reader_ role. Reported as `unverified`, because a Reader cannot inspect its own assignments.                                                                                                           | No (wire allowlist, query check)                                              |
| REST             | A read-only API user or token where the API offers one; otherwise the existing credential, as `VAR_*` secrets for the script. Reported as `unverified`.                                                                                                  | No (request allowlist, wire guard), as long as the allowed requests are reads |
| Postgres         | A read-only role (e.g. `pg_read_all_data`), Entra auth for the managed identity, or an existing credential                                                                                                                                               | No (layers B1–B3)                                                             |
| Oracle           | A read-only user where possible, otherwise a shared credential                                                                                                                                                                                           | No (layers B1–B6)                                                             |
| SQL Server       | A login with `db_datareader` (plus `VIEW DEFINITION` for the routine inventory and `SHOWPLAN` for `explain`), Entra auth for the managed identity, otherwise a shared credential. Read-only at the server only with a read-only replica (`READ_INTENT`). | No (layers B1–B4)                                                             |
| **Result store** | Managed identity, _Storage Blob Data Contributor_ scoped to the result container only                                                                                                                                                                    | n/a. This is Periscope's own storage, never a source.                         |

`list_sources` reports the credential state for information only. No source is refused because its credential can write.

### 7.5 Data protection and audit

- **Audit log** as JSONL to stdout, collected by the platform's log pipeline. Every MCP call is logged, with timestamp, user (`oid`, `upn`), source, tool, query text, result ID, row count, bytes, duration and outcome. Guard rejections are logged with their reason, and so are **URL issuance and every download** (result, part, bytes, client IP). Result data is never logged.
- **Errors to clients are summaries.** A driver or SDK error reaches the agent as its first line (at most 300 characters). Hostnames, request paths, headers and credential chains that follow go only to the operational log, together with the full error. The same holds for a source that failed to initialize: `list_sources` shows the short reason and retries the source once its retry time (one minute) has passed.
- **Results are data at rest.** Query results are a copy of source data in Periscope's private result store, encrypted at rest and deleted after `PERISCOPE_RESULTS_RETENTION`. Blob contents and offloaded KIM contents are the exception: they are never copied, only referenced. Operators choose the retention to match their data-protection rules.
- **Data leaves the network.** Windows go into LLM context, and downloads land in agent sandboxes. Access is therefore limited to the members of the app role. Connecting production or personal data is an explicit operator decision per deployment.
- **No table or column filters inside Periscope.** They would be easy to get around with views and functions. Where finer scoping is needed, it belongs in the database (grants).

---

## 8. Deployment

### 8.1 Image

- `ghcr.io/coreprocess/periscope-mcp:<semver>`, public, built by GitHub Actions on each tag, with SBOM and provenance attestation. Deployments pin the version or digest.
- The same image runs in stdio mode for local development (`docker run -i …`, with a mounted results directory).
- **Restricted egress:** environments that limit outbound traffic either allow `ghcr.io` and `pkg-containers.githubusercontent.com`, or import the image into a private registry first (e.g. `az acr import`).

### 8.2 Reference deployment on Azure

- **Container App:** in a Container Apps environment with VNet integration and internal ingress, single revision mode. Set **`minReplicas: 1`**, so scale-to-zero doesn't kill running queries. On shutdown, running jobs are marked `failed` with partial data.
- **Result store:** a dedicated storage account with a private endpoint and no public access. One container, plus a lifecycle rule that deletes blobs after the retention period.
- **User-assigned identity** with the role assignments from §7.4, plus `AcrPull` (if using a private registry) and _Key Vault Secrets User_ on each of its secrets (never on the whole vault).
- **Entra app registration** (§7.2) with the group assignment.
- **Key Vault secrets** for SQL credentials and the download signing key, referenced as Container App secrets.
- **Public gateway** with a verified custom domain in front of the internal ingress, e.g. Application Gateway or Front Door. Requirements:
  - **No response buffering:** Streamable HTTP uses SSE and downloads stream. Azure API Management, for example, buffers by default.
  - **Timeouts:** downloads transfer data continuously, so they only need a gateway timeout that doesn't cap the _total_ response time. Range resume covers interruptions anyway. **Idle timeouts can be short (about 10 s).** No Periscope endpoint keeps a connection open without sending data for longer than that:
    - `get_result` waits at most 10 s.
    - MCP runs in stateless Streamable HTTP mode without the standalone server-to-client SSE stream (`GET /mcp` returns 405).
  - **No compression or other transformation of `/r/…` responses.** Respect `no-transform`, or disable gateway compression for that path. The files are already compressed, and re-encoding would break byte ranges (§6.4).
  - **No access logs with `/r/…` paths.** The path carries the download token, a bearer capability; anyone who can read such a log can download the result until the URL expires. Disable access logging for Periscope's host or drop the path. Periscope audits every download itself.
- **Reachability:** sources are reached through private endpoints or VNet routing from the Container Apps environment.

### 8.3 Terraform module

A reusable module in this repository (`terraform/`). It takes a `sources` list, generating the indexed `PERISCOPE_SOURCE_*` variables with secret values routed to Key Vault references. It creates:
- the identity and role assignments
- the app registration
- the result storage account with its lifecycle rule
- the download signing key in Key Vault
- the Container App

It outputs the internal FQDN for the gateway configuration.

---

## 9. Implementation

### 9.1 Technology choices

**Language: TypeScript on Node.js 24 LTS.**
- **Team fit.** It is the stack of the teams that will run and extend Periscope, which matters for a security-critical server.
- **MCP SDK.** The TypeScript MCP SDK is the reference implementation, including Streamable HTTP.
- **Drivers.** Every source has a first-class driver: `pg`, Oracle's official `oracledb` (thin mode, no Instant Client), `mssql` on Microsoft's `tedious`, and Microsoft's official Azure SDKs for Cosmos DB, Blob Storage, Monitor and Identity. KIM needs no SDK: its HTTP API is called with Node's global `fetch`.
- **Alternatives considered:**
  - **Go:** limited Cosmos SDK (historically weak cross-partition queries), only community Oracle drivers.
  - **Rust:** its Oracle driver needs the Instant Client, and its Cosmos SDK is a preview.
  - **Python** has the strongest Parquet tooling (pyarrow), but would add a second stack. The research below shows the Node Parquet ecosystem is sufficient.

**Stack**

| Area                | Choice                                                                                                                                                                                                                                                                     | Notes                                                                                                                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime and tooling | Node.js 24 LTS, TypeScript (strict), pnpm, Biome, `node:test`, Testcontainers                                                                                                                                                                                              |                                                                                                                                                                                                    |
| HTTP                | Express 5                                                                                                                                                                                                                                                                  | One server for `/mcp` and `/r/…`. The MCP SDK's Streamable HTTP transport plugs in without adapters. Range responses are a few lines of our own code.                                              |
| MCP                 | `@modelcontextprotocol/server`, `/express`, `/node` (v2 SDK)                                                                                                                                                                                                               | Stateless Streamable HTTP (2025 and 2026 protocol revisions), and stdio. Bearer validation uses the SDK's `requireBearerAuth` with our Entra verifier on `jose`.                                   |
| Validation          | `zod`                                                                                                                                                                                                                                                                      | Configuration and tool schemas                                                                                                                                                                     |
| Sources             | `pg` with `pg-cursor`, `oracledb` (thin), `mssql` (on `tedious`, pinned and patched), `@azure/cosmos`, `@azure/storage-blob`, the Log Analytics REST query API and KIM's HTTP API via `fetch` (no SDK), `@redis/client` (pinned, with `@redis/entraid`), `@azure/identity` | The Redis wire guard patches the client's RESP encoder, so the version is pinned and covered by tests. A small patch to `tedious` returns `decimal`/`numeric` and `money` values as exact strings. |
| Guards              | `libpg-query` (Postgres' own parser), our own Oracle, T-SQL and KIM lexers                                                                                                                                                                                                 |                                                                                                                                                                                                    |
| NDJSON              | `node:zlib`                                                                                                                                                                                                                                                                | One gzip member per block                                                                                                                                                                          |
| **Parquet writer**  | **`hyparquet-writer`** (pure JS, MIT)                                                                                                                                                                                                                                      | See below                                                                                                                                                                                          |
| **Parquet reader**  | **`hyparquet`** (pure JS, MIT)                                                                                                                                                                                                                                             | See below                                                                                                                                                                                          |
| Logging and audit   | `pino`                                                                                                                                                                                                                                                                     | JSON lines to stdout                                                                                                                                                                               |
| Build and image     | `tsc` / esbuild, slim Node 24 image                                                                                                                                                                                                                                        | The chosen stack is pure JS/WASM, so a distroless image is possible                                                                                                                                |

**Parquet: research results**

Measured on Node 24 with a 9-column schema (~132 bytes/row), ZSTD, 50,000-row row groups. The files were read back with pyarrow, polars and DuckDB.

| Library                                                                 | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Role                                             |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `hyparquet-writer`                                                      | Streaming `ParquetWriter`: one `write()` per row group, with an async `flush()` hook after each one. **Memory stayed flat** (~356 MB RSS from 1M to 3M rows). **All logical types round-trip** in pyarrow, polars and DuckDB: DECIMAL(38,10), UTC microsecond timestamps, DATE, JSON, LIST, BINARY, STRING, nullability. Writes statistics and the column and offset index. ZSTD works through Node 24's built-in `zlib`. Throughput about 330k rows/s (≈43 MB/s raw including JS row building; the encoder alone ≈55 MB/s). Actively maintained. | **Writer**                                       |
| `hyparquet`                                                             | Async ranged reads through a pluggable `AsyncBuffer`. With the offset index, a 100-row window from a 3M-row file read **126 KB** in 19 small requests (990 KB without the index). The only JS implementation listed on the Apache Parquet implementation-status page. **Caveats:** it decodes DECIMAL to float64, losing precision, with no hook for it, and returns timestamps as millisecond `Date` objects by default (a parser override exists).                                                                                              | **Reader** (with decimal handling, see §12)      |
| `@duckdb/node-api`                                                      | Fastest writer (~710k rows/s), correct types, native binaries for glibc and musl. But it **writes no page index**, stages a whole part in memory before writing, and marks columns REQUIRED when a part happens to have no nulls, so the schema can drift between parts.                                                                                                                                                                                                                                                                          | Fallback writer, if throughput becomes a problem |
| `parquet-wasm` + `apache-arrow`                                         | Streams and writes a page index, but WASM memory grew steadily (612 → 915 MB), the JSON logical type was lost (written as plain STRING), and the reader can't send custom headers. Decodes decimals exactly.                                                                                                                                                                                                                                                                                                                                      | Fallback reader for exact decimals               |
| `@dsnp/parquetjs`, `nodejs-polars`, `duckdb-wasm`, `apache-arrow` alone | No ZSTD or modern logical types (parquetjs); no way to feed batches from a JS cursor (polars); browser-oriented dev builds (duckdb-wasm); no Parquet support at all (Arrow JS)                                                                                                                                                                                                                                                                                                                                                                    | Not suitable                                     |

**How Periscope uses them:**
- **Writing.** Periscope writes each Parquet part with `hyparquet-writer`: an explicit schema with logical types, one `write()` per row group of ~50,000 rows, ZSTD, `columnIndex: true`, and a page size of about 64 KiB. A custom output `Writer` stages one Azure block per row-group flush and commits the block list in `finish()`. Memory therefore stays bounded per row group, not per part.
- **Reading.** Windows are read with `hyparquet` over a ranged-read `AsyncBuffer` on the result store, with `useOffsetIndex: true`. Timestamps use the microsecond parser. Decimals need exact handling (§12).
- **Throughput.** Pure-JS writing reaches roughly the 40–55 MB/s range. In practice the database drivers producing JS rows are likely the bottleneck, and jobs run in parallel. If a source needs more, `@duckdb/node-api` is the documented fallback writer, at the price of the page index.

### 9.2 Code structure

```
src/
  index.ts                 CLI entry: transport selection, --env-file
  config/                  env discovery, zod schema per type
  auth/                    PRM endpoint, JWT validation, role checks; broker (authorization server in front of Entra)
  tools/                   the six MCP tools
  results/                 job runner, manifest, schema inference, result store (azureblob, filesystem)
    writers/               Parquet (row groups + page index), block-gzip NDJSON (+ block index),
                           file copy (+ line index for text)
    readers/               window reader: index/footer lookup, ranged reads, LRU cache
  download/                HTTP endpoints, URL signing, Range, headers
  core/                    limits, truncation, audit, errors
  sources/
    adapter.ts             read-only source interface: describe, validate, stream
    postgres/              adapter, describe, guard (AST), inventory, posture
    oracle/                adapter, describe, guard (lexer), inventory, posture
    mssql/                 adapter, describe, guard (lexer), inventory, types
    cosmos/                adapter, describe (schema sampling), wire-guard, RU throttle
    blob/                  adapter, wire-guard (pipeline policy)
    loganalytics/          adapter, describe, wire-guard, time-window splitting
    redis/                 adapter, describe (prefix sampling), command parser + allowlist, client guard
    kim/                   adapter (with describe and file reads), client (wire allowlist, key exchange),
                           guard (lexer, query check), paging plans + anchor literals, node documents
    rest/                  adapter (with describe and file reads), guard (request parser, allowlist),
                           script loader
terraform/                 reference deployment module
test/
  unit/                    config, guards, manifest, windows, URL signing
  guard-corpus/            attack corpus + property-based lexer fuzzing
  integration/             testcontainers per type, end-to-end query → read → download
```

Each source adapter implements just three operations: `describe`, `validate` (synchronous guard) and `stream` (an async iterator of rows or files). Everything else (jobs, parts, schema inference, windows and downloads) is generic in `results/` and `download/`.

---

## 10. Testing

**Read-only guarantee.** Deployments may run with write-capable credentials, so the tests do too.
- **Test environments:**
  - `pgvector/pgvector:pg17` with `dblink` and `oracle_fdw`
  - `gvenzl/oracle-xe:21-slim`, closest to 19c among the free images (`oracle-free` is 23ai and accepts syntax 19c rejects); a 19c image from Oracle's container registry where licensing allows
  - `mcr.microsoft.com/mssql/server:2022-latest` in CI; Azure SQL Edge (the same engine) locally on ARM64
  - Azurite
  - the Cosmos DB emulator
  - Redis, standalone and cluster, with RedisJSON
  - a mock of the KIM HTTP API, with request and answer shapes recorded from a real kim-server; it asserts that no request outside the wire allowlist arrives
  - a write-capable HTTP API for `rest`, with a password-grant sign-in and paged endpoints; it records every request that is not a read, and every `GET` on an endpoint that stands for one that writes
- **Admin or owner credentials** everywhere.
- **Planted traps:**
  - an autonomous-transaction function and a view on top of it
  - a function using `EXECUTE IMMEDIATE`
  - a dblink / `oracle_execute` wrapper
  - a T-SQL function running an extended procedure, wrapped by another function and by views
  - a Cosmos stored procedure
- **Attack corpus:**
  - DDL and DML, CTE tricks
  - comment, quote and Unicode obfuscation, unusual whitespace
  - zero-argument function calls, `WITH` chains
  - stored procedure execution, blob uploads and metadata writes
  - Redis write and read-looking write commands (`GETEX`, `GETDEL`, `SPOP`, `PFCOUNT`, `XREADGROUP`, `SORT … STORE`, …), blocking commands, scripts and transactions, quoting tricks in the command tokenizer
  - KIM `reveal`, URLs and `Reference(…)` literals on foreign origins or other stages, texts that are not a query, bind parameters, and calls to draft, live session, backup and token-exchange endpoints
  - REST: other methods, paths and origins, dot segments and encoded slashes, method override headers and parameters, credentials set by the agent, bodies on `GET`, and redirects, pages and script-prepared requests outside the allowlist

  This is complemented by property-based fuzzing of the Oracle lexer, and by unit tests of the KIM lexer, paging plans, anchor literals and wire allowlist, and of the REST request parser and allowlist.
- **Pass criteria:**
  1. A database or account checksum before and after the run is identical.
  2. **Every layer is tested on its own with the other layers disabled**, which shows that each one holds by itself.
- **Build-time checks:**
  - no write-capable SDK calls in source adapter code
  - no imports of the result store writer from `sources/`

**Results and downloads.**
- End to end: `query` → `read_result` while running → `get_result` → download → checksum.
- Range requests, resume after interruption, DuckDB reading Parquet parts over HTTP.
- **Manifest and indexes:** relative paths resolve correctly (including blob names that need percent-encoding); every listed gzip block, fetched alone by Range, decompresses to exactly `rowCount` rows; Parquet index row groups and stats match the file footer and the actual data; a manifest read during a running query only lists complete parts; `state.json` is never served.
- **Block-gzip compatibility:** multi-block `.ndjson.gz` parts read completely and identically with `zcat`, `gzip -d`, Python `gzip`, pandas and DuckDB `read_json`. This guards against readers that stop after the first gzip member.
- **Window reads** at every boundary: first and last row of a block, a row group, a part; windows spanning blocks and parts; rows larger than the block size; column projection on Parquet. Plus a check that a typical window costs one ranged read.
- **No transport re-encoding:** downloads through the reference gateway arrive byte-identical (checksum) with and without `Accept-Encoding`.
- Parquet type mapping: a round trip per source type covering every supported column type, including the edge cases (unconstrained decimals, time zones, JSON, vectors, LOBs), checked with DuckDB and pyarrow as readers.
- URL tampering and expiry; access checks against source roles (including role revocation while a result exists).
- Blob references: download and line windows of an unchanged blob; a blob changed or deleted after the query returns `412`/`404`; references to versions and snapshots stay valid; line index built on first use.
- Cancellation; a replica dying mid-job (heartbeat expiry → `failed`).
- Log Analytics time-window splitting; Cosmos RU throttling.
- KIM paging: record windows and typed node anchors at one pinned snapshot, the halving page size on the result budget, written windows sent as they are, offloaded contents read by Range, and the key exchange on an expired token.
- REST sign-in, paging and a new sign-in after a `401` through the script; redirects; file reads with and without Range support; the request and response size limits.
- Retention expiry.

---

## 11. Implementation status

All of §1–§10 is implemented. Instead of a spike, targeted experiments settled the technical questions before the build (Parquet streaming and exact decimals, Cosmos and Blob wire guards, block-gzip compatibility, Postgres, Oracle and SQL Server write paths, the Redis client guard, the MCP v2 server). Their findings are reflected above.

Every source is tested against a real database or emulator with write-capable credentials (`test/integration`): Postgres (`pgvector/pgvector:pg17`), Oracle (Free 23ai locally on ARM64, XE 21 in CI), SQL Server (Azure SQL Edge locally on ARM64, SQL Server 2022 in CI), the Cosmos DB emulator, Azurite, Redis 8, and mocks of the Log Analytics query API, the KIM HTTP API and a REST API. An end-to-end test runs the real process with Entra-style tokens from a local issuer, the MCP client, downloads and stdio mode.

The KIM adapter was also verified once against a real local kim-server with a synthetic stage: paging 1,200 records and objects, typed anchors, withheld and offloaded nodes, and file ranges.

What remains is verification in a real deployment (§12).

---

## 12. Open questions

**To verify at deployment**

1. **Entra end to end.** Sign-in with local Claude Code and with the claude.ai connector, in direct mode (path-qualified App ID URI on a verified domain, fully qualified scope, v2 tokens) and in broker mode, including a reconnect and a scheduled cloud task. Broker mode is tested against an Entra stand-in and the official MCP client SDK; a sign-in against a real tenant is still to be done.
2. **Gateway behaviour** for SSE on `/mcp` and long downloads (no buffering, no compression, no total-duration cap).

**Design**

3. `explain` for Oracle uses `DBMS_XPLAN.DISPLAY_CURSOR`, which needs access to `V$SQL_PLAN`, `V$SQL` and `V$SESSION`. A fallback without those privileges would be `EXPLAIN PLAN` into the session-private `PLAN_TABLE` inside the read-only transaction, if Oracle allows it there; to be checked on the target database.

**Decided**
- Result retention: 24 hours (`PT24H`).
- Results are shared: access follows source permissions, not the user who started the query (§7.3).
- One result format per source type, with no format option: Parquet (ZSTD) for Postgres, Oracle, SQL Server and Log Analytics; gzip-compressed NDJSON for Cosmos, Redis, KIM and blob listings (§6.1).
- Blob contents are referenced, never copied. Listing rows point to the source blobs, which Periscope serves read-only from the source, pinned to the ETag (or version or snapshot) at query time (§6.1, §6.4).
- Redis is a source type: read-only command allowlist, `SCAN` with optional values as key export, a client guard on every wire command, and optional replica reads (§7.1).
- REST is a source type: one HTTP request per query, an operator-declared allowlist checked on every request that leaves the process, and one optional script module that signs in, pages and shapes responses. Binary responses are referenced and fetched again on read (§6.1, §7.1).
- KIM is a source type: one node or record query over its HTTP API, paged by Periscope at one pinned snapshot, offloaded contents referenced like blobs, a wire allowlist in the only HTTP client, and a query check (§6.1, §7.1).
- Compression at rest, files served exactly as stored. NDJSON is block-compressed gzip (independent ~1 MiB members) with a block index, and Parquet uses row groups and the page index. Windows cost one ranged read, and downloads need no transport compression (§6.2, §6.4).
- One download URL per result: `get_result` returns only the manifest URL. The manifest lists files and block indexes by relative path, and everything except internal job state is downloadable (§6.4).
- Manifest and indexes are Periscope's own format-independent JSON. Every part has an index (gzip members or row groups). Parquet indexes add per-part column statistics, and the Parquet schema shows each column's stored type (§6.4).
- No IP allowlisting. Security rests on OAuth and signed, expiring download URLs; gateway IP restrictions are an optional operator add-on (§7.2).
- Idle waits are short. `get_result` waits at most 10 s, and gateway idle timeouts of about 10 s are fine. Downloads only need a timeout that doesn't cap the total transfer time (§5.3, §8.2).
- Users sign in with Entra ID v2. Directly (`entra`) where the host is on a verified domain; otherwise through Periscope's broker (`entra-broker`), because no Claude client can change the `resource` parameter that Entra matches against the Application ID URI (§7.2).
- Unattended cloud agents use claude.ai connectors (scheduled tasks and API-triggered runs) and act as the user who owns them (§7.2).
- TypeScript on Node.js 24. Parquet is written with `hyparquet-writer` in a worker thread per part and read with `hyparquet`; exact decimals are read by stripping the DECIMAL annotation from the footer metadata and formatting the raw unscaled values (§9.1).
- Image name `ghcr.io/coreprocess/periscope-mcp`, license MIT.
