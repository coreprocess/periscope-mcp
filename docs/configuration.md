# Configuration reference

All configuration comes from environment variables. For local use, `--env-file <path>` loads one or more dotenv files. Periscope refuses to start, naming the variable, if anything is missing, unknown or invalid.

## Global settings

| Variable | Default | Description |
|---|---|---|
| `PERISCOPE_TRANSPORT` | `stdio` | `stdio` (local MCP over stdin/stdout) or `http` (Streamable HTTP for deployments) |
| `PERISCOPE_HOST` | `0.0.0.0` (http), `127.0.0.1` (stdio) | Bind address of the HTTP listener |
| `PERISCOPE_PORT` | `8080` (http), random (stdio) | HTTP port. In stdio mode the listener only serves downloads. |
| `PERISCOPE_PUBLIC_URL` | derived from host and port | Public base URL, e.g. `https://periscope.example.com`. The MCP endpoint is `<base>/mcp`, downloads are `<base>/r/…`. Required for http with Entra auth. |
| `PERISCOPE_AUTH` | `entra` (http), `none` (stdio) | `none` is only allowed with stdio or a localhost bind |
| `PERISCOPE_AUTH_TENANT_ID` | | Entra tenant ID (required for `entra`) |
| `PERISCOPE_AUTH_CLIENT_ID` | | Client ID of the Periscope app registration; the expected token audience (required for `entra`) |
| `PERISCOPE_AUTH_REQUIRED_ROLE` | `Periscope.Reader` | App role required for any access |
| `PERISCOPE_AUTH_SCOPE` | `Periscope.Access` | Name of the delegated scope; clients request `<public url>/mcp/<scope>` |
| `PERISCOPE_AUTH_ISSUER` | `https://login.microsoftonline.com/<tenant>/v2.0` | Token issuer (override for sovereign clouds or tests) |
| `PERISCOPE_AUTH_JWKS_URI` | `https://login.microsoftonline.com/<tenant>/discovery/v2.0/keys` | Signing keys (override for sovereign clouds or tests) |
| `PERISCOPE_AUTH_AUTHORIZATION_SERVER` | the issuer | Authorization server announced in the protected resource metadata |
| `PERISCOPE_RESULTS_STORE` | `azureblob` (http), `filesystem` (stdio) | Where results are written |
| `PERISCOPE_RESULTS_ACCOUNT_URL` | | Result store account for `azureblob`, accessed with the managed identity |
| `PERISCOPE_RESULTS_CONNECTION_STRING` | | Alternative to the account URL (e.g. Azurite) |
| `PERISCOPE_RESULTS_CONTAINER` | `results` | Result store container |
| `PERISCOPE_RESULTS_DIR` | `./.periscope/results` | Result store directory for `filesystem` |
| `PERISCOPE_RESULTS_RETENTION` | `PT24H` | How long results are kept (ISO 8601 duration) |
| `PERISCOPE_RESULTS_PART_BYTES` | `104857600` | Target stored size of one result part; the first part closes early |
| `PERISCOPE_DOWNLOAD_URL_TTL` | `PT1H` | Lifetime of signed download URLs |
| `PERISCOPE_DOWNLOAD_SIGNING_KEY` | random per process | HMAC key (≥ 32 bytes) for download URLs and blob references. Required when replicas share an Azure result store. Rotating it revokes all URLs. |
| `PERISCOPE_READ_MAX_ROWS` | `500` | Maximum rows per `read_result` window |
| `PERISCOPE_READ_MAX_BYTES` | `65536` | Maximum response size per window |
| `PERISCOPE_READ_MAX_VALUE_CHARS` | `2000` | Longer values are truncated in windows (never in downloads) |
| `PERISCOPE_MAX_CONCURRENT_QUERIES` | `4` | Running queries per user and replica |
| `PERISCOPE_MAX_QUERY_DURATION` | `PT15M` | Default maximum query duration for sources |
| `PERISCOPE_MAX_RESULT_BYTES` | `10737418240` | Default maximum stored result size for sources |
| `PERISCOPE_AUDIT_LOG` | `stdout` (http), `stderr` (stdio) | `stdout`, `stderr` or a file path (JSON lines) |
| `PERISCOPE_LOG_LEVEL` | `info` | Operational log level |
| `AZURE_CLIENT_ID` | | Client ID of a user-assigned managed identity for `DefaultAzureCredential` |
| `PERISCOPE_VERSION` | set by the image build | Version reported by `--version` and to MCP clients; the release pipeline sets it from the tag |

## Sources

```bash
PERISCOPE_SOURCE_N=3                 # number of sources; indices run 0 … N-1
PERISCOPE_SOURCE_<i>_NAME=…          # identifier used in tool calls: [a-z0-9_-]{1,64}, unique
PERISCOPE_SOURCE_<i>_TYPE=…          # postgres | oracle | cosmos | blob | loganalytics | redis
PERISCOPE_SOURCE_<i>_<KEY>=…
```

Keys for every source:

| Key | Description |
|---|---|
| `DESCRIPTION` | Shown to the agent in `list_sources`; describe what the data is |
| `REQUIRED_ROLE` | App role needed to see and use this source |
| `DOWNLOAD_ROLE` | App role needed to get download URLs; without it results can only be paged with `read_result` |
| `MAX_QUERY_DURATION` | ISO 8601 duration, overrides the global default |
| `MAX_RESULT_BYTES` | Overrides the global default |

`AUTH=azure` uses `DefaultAzureCredential`: the managed identity in Azure, `az login` locally.

### `postgres`

| Key | Description |
|---|---|
| `URL` | Connection string, e.g. `postgres://user:password@host:5432/db?sslmode=require` |
| `HOST`, `PORT`, `DATABASE`, `USER`, `PASSWORD` | Alternative to `URL` |
| `AUTH` | `azure`: Entra token as password (Azure Database for PostgreSQL) |
| `SSL` | `disable`, `require` (no certificate check) or `verify-full` |
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

## Query options and parameters

| Type | `params` | `options` |
|---|---|---|
| `postgres` | array for `$1, $2, …` | `explain`, `analyze` |
| `oracle` | object for `:name` or array for `:1, :2` | `explain` |
| `cosmos` | `{ "@name": value }` or `[{ name, value }]` | `database`, `container` (required), `partitionKey` |
| `blob` | not used | `container`, `tagFilter`, `include` (`metadata`, `tags`, `versions`, `snapshots`) |
| `loganalytics` | not used | `timespan` (ISO 8601 duration or `start/end` interval) |
| `redis` | not used | `values` (with `SCAN`: fetch type, TTL and value of every key) |
