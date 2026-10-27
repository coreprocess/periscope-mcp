# Configuration reference

All configuration comes from environment variables. For local use, `--env-file <path>` loads one or more dotenv files. Periscope refuses to start, naming the variable, if anything is missing, unknown or invalid.

## Global settings

| Variable | Default | Description |
|---|---|---|
| `PERISCOPE_TRANSPORT` | `stdio` | `stdio` (local MCP over stdin/stdout) or `http` (Streamable HTTP for deployments) |
| `PERISCOPE_HOST` | `0.0.0.0` (http), `127.0.0.1` (stdio) | Bind address of the HTTP listener |
| `PERISCOPE_PORT` | `8080` (http), random (stdio) | HTTP port. In stdio mode the listener only serves downloads. |
| `PERISCOPE_PUBLIC_URL` | derived from host and port | Public base URL, e.g. `https://periscope.example.com`. The MCP endpoint is `<base>/mcp`, downloads are `<base>/r/…`. Required for http with Entra auth. |
| `PERISCOPE_AUTH` | `entra` (http), `none` (stdio) | `entra`: Entra issues the tokens (needs the host on a verified domain). `entra-broker`: Periscope is the authorization server and signs users in at Entra (any host). `none` is only allowed with stdio or a localhost bind, and then rejects requests whose Host or Origin is not localhost or the public URL's host (DNS rebinding) |
| `PERISCOPE_AUTH_TENANT_ID` | | Entra tenant ID (required for `entra` and `entra-broker`) |
| `PERISCOPE_AUTH_CLIENT_ID` | | Client ID of the Periscope app registration: the expected token audience (`entra`) or the client Periscope signs in as (`entra-broker`) |
| `PERISCOPE_AUTH_CLIENT_ASSERTION_FILE` | `AZURE_FEDERATED_TOKEN_FILE` | `entra-broker`: file with the federated token Periscope presents to Entra (AKS workload identity provides it) |
| `PERISCOPE_AUTH_ASSERTION_IDENTITY` | | `entra-broker`: client ID of a user-assigned managed identity; its token is presented to Entra (Container Apps, App Service). The app registration trusts the identity as federated credential |
| `PERISCOPE_AUTH_CLIENT_SECRET` | | `entra-broker`: client secret instead of a federated token |
| `PERISCOPE_AUTH_REDIRECT_URIS` | `https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback` | `entra-broker`: HTTPS redirect URIs MCP clients may register; loopback (`http://localhost`, `127.0.0.1`, `[::1]`, any port) is always allowed |
| `PERISCOPE_AUTH_ACCESS_TOKEN_TTL` | `PT1H` | `entra-broker`: access token lifetime; roles are re-read from Entra at every refresh |
| `PERISCOPE_AUTH_SESSION_TTL` | `P30D` | `entra-broker`: refresh token lifetime, after which users sign in again |
| `PERISCOPE_AUTH_REQUIRED_ROLE` | `Periscope.Reader` | The one app role: it grants access to every source, including downloads |
| `PERISCOPE_AUTH_SCOPE` | `Periscope.Access` | `entra`: name of the delegated scope; clients request `<public url>/mcp/<scope>` |
| `PERISCOPE_AUTH_ISSUER` | `https://login.microsoftonline.com/<tenant>/v2.0` | Entra issuer; `entra-broker` reads its endpoints from the issuer's discovery document (override for sovereign clouds or tests) |
| `PERISCOPE_AUTH_JWKS_URI` | `https://login.microsoftonline.com/<tenant>/discovery/v2.0/keys` | Signing keys (override for sovereign clouds or tests) |
| `PERISCOPE_AUTH_AUTHORIZATION_SERVER` | the issuer | `entra`: authorization server announced in the protected resource metadata |
| `PERISCOPE_RESULTS_STORE` | `azureblob` (http), `filesystem` (stdio) | Where results are written |
| `PERISCOPE_RESULTS_ACCOUNT_URL` | | Result store account for `azureblob`, accessed with the managed identity |
| `PERISCOPE_RESULTS_CONNECTION_STRING` | | Alternative to the account URL (e.g. Azurite) |
| `PERISCOPE_RESULTS_CONTAINER` | `results` | Result store container; the deployment creates it, Periscope does not |
| `PERISCOPE_RESULTS_DIR` | `./.periscope/results` | Result store directory for `filesystem` |
| `PERISCOPE_RESULTS_RETENTION` | `PT24H` | How long results are kept (ISO 8601 duration) |
| `PERISCOPE_RESULTS_PART_BYTES` | `104857600` | Target stored size of one result part; the first part closes early |
| `PERISCOPE_DOWNLOAD_URL_TTL` | `PT1H` | Lifetime of signed download URLs |
| `PERISCOPE_DOWNLOAD_SIGNING_KEY` | random per process | HMAC key (≥ 32 bytes) for download URLs and blob references, and for the OAuth tokens of `entra-broker`. Required when replicas share an Azure result store and for `entra-broker`. Rotating it revokes all URLs and signs everybody out. |
| `PERISCOPE_READ_MAX_ROWS` | `500` | Maximum rows per `read_result` window |
| `PERISCOPE_READ_MAX_BYTES` | `65536` | Maximum response size per window |
| `PERISCOPE_READ_MAX_VALUE_CHARS` | `2000` | Longer values are truncated in windows (never in downloads) |
| `PERISCOPE_MAX_CONCURRENT_QUERIES` | `4` | Running queries per user and replica |
| `PERISCOPE_MAX_QUERY_DURATION` | `PT15M` | Default maximum query duration for sources |
| `PERISCOPE_MAX_RESULT_BYTES` | `10737418240` | Default maximum stored result size for sources |
| `PERISCOPE_AUDIT_LOG` | `stdout` (http), `stderr` (stdio) | `stdout`, `stderr` or a file path (JSON lines) |
| `PERISCOPE_LOG_LEVEL` | `info` | Operational log level |
| `PERISCOPE_ORACLE_DRIVER` | `thin` | `thick`: every Oracle source connects through Oracle's client libraries, the Instant Client Basic Light shipped in the image, which databases that require Native Network Encryption or checksumming need. Basic Light supports the database character sets US7ASCII, WE8DEC, WE8ISO8859P1, WE8MSWIN1252, UTF8 and AL32UTF8 (national: AL16UTF16, UTF8). |
| `PERISCOPE_EXTRA_CA_CERTS` | | PEM certificates trusted in addition to Node's bundled CAs, for every TLS connection: sources behind an internal CA (an on-premises API, a database with TLS) |
| `AZURE_CLIENT_ID` | | Client ID of a user-assigned managed identity for `DefaultAzureCredential` |
| `PERISCOPE_VERSION` | set by the image build | Version reported by `--version` and to MCP clients; the release pipeline sets it from the tag |

## Sources

```bash
PERISCOPE_SOURCE_N=3                 # number of sources; indices run 0 … N-1
PERISCOPE_SOURCE_<i>_NAME=…          # identifier used in tool calls: [a-z0-9_-]{1,64}, unique
PERISCOPE_SOURCE_<i>_TYPE=…          # postgres | oracle | mssql | cosmos | blob | loganalytics | redis | kim | rest
PERISCOPE_SOURCE_<i>_<KEY>=…
```

Keys for every source:

| Key | Description |
|---|---|
| `DESCRIPTION` | Shown to the agent in `list_sources`; describe what the data is |
| `MAX_QUERY_DURATION` | ISO 8601 duration, overrides the global default |
| `MAX_RESULT_BYTES` | Overrides the global default |

`AUTH=azure` uses `DefaultAzureCredential`: the managed identity in Azure, `az login` locally.

### `postgres`

| Key | Description |
|---|---|
| `URL` | Connection string, e.g. `postgres://user:password@host:5432/db?sslmode=require` |
| `HOST`, `PORT`, `DATABASE`, `USER`, `PASSWORD` | Alternative to `URL` |
| `AUTH` | `azure`: Entra token as password (Azure Database for PostgreSQL) |
| `SSL` | `disable`, `require` or `verify-full` (both verify the server certificate and host name), or `no-verify` (encrypted without a certificate check, open to interception) |
| `SEARCH_PATH` | Session search path |
| `ALLOW_ROUTINES` | Comma-separated functions (`schema.name` or `name`) cleared after review; only relevant in strict mode |

### `oracle`

| Key | Description |
|---|---|
| `CONNECT_STRING` | EZConnect (`host:1521/service`) or a full descriptor |
| `HOST`, `PORT`, `SID` or `SERVICE_NAME` | Alternative to `CONNECT_STRING`; `SID` builds a descriptor |
| `USER`, `PASSWORD` | Required |
| `ALLOW_ROUTINES` | Comma-separated routines (`OWNER.NAME` or `NAME`) cleared after review |
| `ALLOW_DBLINKS` | `true` to allow `@dblink` references |

A database that requires Native Network Encryption fails in the default thin driver with NJS-533; set `PERISCOPE_ORACLE_DRIVER=thick` for the whole instance.

### `mssql`

SQL Server 2017+, Azure SQL Database and Azure SQL Managed Instance.

| Key | Description |
|---|---|
| `CONNECTION_STRING` | ADO.NET style, e.g. `Server=tcp:host,1433;Database=db;User Id=…;Password=…;Encrypt=true` |
| `HOST`, `PORT`, `DATABASE`, `USER`, `PASSWORD` | Alternative to `CONNECTION_STRING`; `PORT` defaults to `1433` |
| `AUTH` | `azure`: Entra token instead of `USER`/`PASSWORD` (Azure SQL) |
| `ENCRYPT` | Default `true` |
| `TRUST_SERVER_CERTIFICATE` | Default `false`; `true` only for self-signed test servers |
| `READ_INTENT` | `true`: connect with `ApplicationIntent=ReadOnly` (readable secondary). Defaults to `true` when the connection string contains it. |
| `ALLOW_ROUTINES` | Comma-separated functions (`schema.name` or `name`) cleared after review |
| `ALLOW_LINKED_SERVERS` | `true` to allow four-part names and views that use linked servers |

### `cosmos`

| Key | Description |
|---|---|
| `CONNECTION_STRING` | `AccountEndpoint=…;AccountKey=…;` (a read-only key is recommended) |
| `ENDPOINT` + `KEY` or `ENDPOINT` + `AUTH=azure` | Alternatives |
| `DATABASE` | Default database |
| `MAX_RU_PER_SEC` | Request-unit budget for queries of this source |
| `LOW_PRIORITY` | `true`: send queries with priority-based execution `Low` |

### `blob`

| Key | Description |
|---|---|
| `CONNECTION_STRING` | Storage connection string (account key or SAS) |
| `ACCOUNT_URL` + `SAS` or `ACCOUNT_URL` + `AUTH=azure` | Alternatives |
| `CONTAINER` | Default container |

### `loganalytics`

| Key | Description |
|---|---|
| `WORKSPACE_ID` | Log Analytics workspace (customer) ID |
| `RESOURCE_ID` | Alternative: an Application Insights resource ID; queries are scoped to it and classic table names work |
| `DEFAULT_TIMESPAN` | Default `P1D` |
| `ENDPOINT` | Default `https://api.loganalytics.io` (other clouds) |

Authentication is always Entra (`DefaultAzureCredential`) with the role *Log Analytics Reader*.

### `redis`

| Key | Description |
|---|---|
| `URL` | `redis://` or `rediss://` URL with credentials |
| `HOST`, `PORT`, `USERNAME`, `PASSWORD`, `TLS` | Alternative to `URL` |
| `AUTH` | `azure`: Entra token (Azure Cache for Redis, Azure Managed Redis) |
| `DATABASE` | Database index (standalone only) |
| `CLUSTER` | `true` for cluster mode; `SCAN` covers all shards |
| `READ_FROM_REPLICAS` | `true`: send reads to replicas |
| `MAX_OPS_PER_SEC` | Command budget for queries of this source |

### `kim`

| Key | Description |
|---|---|
| `URL` | Origin of the stage's KIM environment, e.g. `https://kim.example.com` |
| `STAGE` | Stage as `org.solution.stage` or stage id |
| `API_KEY` | API key (`kim_sk_…`) of a service account; assign it only the built-in *Reader* role |
| `IDENTITY_URL` | Origin of the instance hosting the management stage, where the key is exchanged; default `URL` |
| `ALLOW_REVEAL` | `true` to allow `reveal` clauses (they disclose masked values and are audited by KIM); default `false` |

### `rest`

Any HTTP API. The query is one HTTP request; the response body becomes the documents of the result (concept §2, §6.1).

| Key | Description |
|---|---|
| `BASE_URL` | Required. Base URL of the API, e.g. `https://api.example.com/v1`; request paths starting with `/` are appended to it |
| `ALLOW` | The requests Periscope may send, as `METHOD pattern` rules separated by commas or line breaks; default `GET /**`. A pattern is a path under `BASE_URL` or an absolute URL for another origin; `*` matches within a path segment, `**` across segments, a pattern without wildcards matches exactly. `HEAD` is allowed wherever `GET` is. Allow only reads (concept §7.1 C). |
| `ALLOW_HEADERS` | Comma-separated headers agents may set, besides `accept`, `accept-language`, `content-type`, `if-none-match` and `if-modified-since`. Method override headers are never allowed. |
| `SCRIPT` | An ES module exporting any of `check`, `prepare` and `transform`: rejects requests, adds credentials, pages and shapes responses (concept §4.2) |
| `VAR_<NAME>` | A value for the script, available as `context.vars.<NAME>`; every `VAR_*` key is treated as a secret |
| `GUIDE` | Usage notes for agents (endpoints, paging, field meanings), returned by `describe` |
| `MAX_RESPONSE_BYTES` | Largest response body read into memory; default `67108864` (64 MiB) |
| `MAX_REQUESTS` | Most requests one query may send, pages and retries included; default `1000` |

The script is trusted configuration: its own `fetch` calls, such as a sign-in, are not checked against `ALLOW`. Every request that carries the agent's query is.

## Query options and parameters

| Type | `params` | `options` |
|---|---|---|
| `postgres` | array for `$1, $2, …` | `explain`, `analyze` |
| `oracle` | object for `:name` or array for `:1, :2` | `explain` |
| `mssql` | object for `@name` | `explain` (estimated plan, `SET SHOWPLAN_TEXT`) |
| `cosmos` | `{ "@name": value }` or `[{ name, value }]` | `database`, `container` (required), `partitionKey` |
| `blob` | not used | `container`, `tagFilter`, `include` (`metadata`, `tags`, `versions`, `snapshots`) |
| `loganalytics` | not used | `timespan` (ISO 8601 duration or `start/end` interval) |
| `redis` | not used | `values` (with `SCAN`: fetch type, TTL and value of every key) |
| `kim` | not used; literals go into the query (`PreciseNumber(1.25)`, `Instant(…)`) | `snapshotId` (read at this snapshot) |
| `rest` | not used; the request is the query | none |
