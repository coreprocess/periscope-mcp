# Deployment on Azure

Periscope runs as one container per project and environment, next to the data sources it reads. This guide uses the Terraform module in [`terraform/`](../terraform/) and Azure Container Apps. The same image runs anywhere that provides the environment variables.

## 1. Prerequisites

- A Container Apps environment with VNet integration, from which the sources are reachable (private endpoints, delegated subnets, on-premises routes).
- A public gateway with a **verified custom domain**, e.g. `https://periscope.example.com`, that forwards to the Container App's internal FQDN. Application Gateway and Front Door work. The gateway must not buffer or compress responses (`/mcp` uses server-sent events, downloads are stored compressed files with byte ranges) and must not cap the total duration of downloads. Idle timeouts of about 10 seconds are fine.
- A Key Vault for the download signing key and source credentials.
- Permission to create Entra app registrations, and an Entra group for the people who may use Periscope.

## 2. Terraform

```hcl
module "periscope" {
  source = "github.com/coreprocess/periscope-mcp//terraform?ref=v0.1.0"

  name                         = "periscope-tst"
  resource_group_name          = "rg-app-tst"
  location                     = "germanywestcentral"
  container_app_environment_id = azurerm_container_app_environment.main.id
  key_vault_id                 = azurerm_key_vault.main.id
  public_url                   = "https://tst-periscope.example.com"

  sources = [
    { name = "appdata", type = "cosmos", settings = { endpoint = "https://…documents.azure.com:443/", auth = "azure", database = "main" } },
    { name = "logs", type = "loganalytics", settings = { workspace_id = azurerm_log_analytics_workspace.main.workspace_id } },
    { name = "erp", type = "oracle", secrets = { connect_string = "<kv secret id>", user = "<kv secret id>", password = "<kv secret id>" } },
  ]

  data_role_assignments = [
    { scope = azurerm_log_analytics_workspace.main.id, role_definition_name = "Log Analytics Reader" },
  ]
  cosmos_data_readers = [{ resource_group_name = "rg-app-tst", account_name = "cosmos-app-tst" }]
  app_role_members    = { "Periscope.Reader" = [azuread_group.periscope_users.object_id] }
}
```

The module creates:

- **A user-assigned identity for Periscope.** Don't reuse the application's own identity, which usually holds write roles.
- **A private result storage account** with a lifecycle rule that deletes results after the retention period. The identity gets *Storage Blob Data Contributor* on the result container only.
- **The Entra app registration** described in step 3.
- **The download signing key** in Key Vault.
- **The Container App**, with a minimum of one replica, so running queries survive.

Point the gateway at the `internal_fqdn` output.

## 3. Entra ID

The module applies this configuration. If you configure Entra by hand, the order and exactness matter:

1. **Set the access token version to 2 first.** Apps on v1 tokens cannot use custom HTTPS identifier URIs.
2. **Set the Application ID URI to exactly the MCP URL:** `https://periscope.example.com/mcp`, with no trailing slash, on a verified domain. MCP clients send this URL as the `resource` parameter, and Entra accepts it only if it matches exactly.
3. **Expose the scope `Periscope.Access`.** Clients request `https://periscope.example.com/mcp/Periscope.Access`.
4. **Add app roles** `Periscope.Reader`, `Periscope.ProdReader` and `Periscope.Download`. Set *assignment required* on the enterprise application and assign groups.
5. **Add redirect URIs:**
   - `https://claude.ai/api/mcp/auth_callback` (web, for the claude.ai connector)
   - `http://localhost` and `http://127.0.0.1` (mobile and desktop, for Claude Code)
6. **Grant admin consent** for the scope.

Periscope validates the following claims:

| Claim | Expected value |
|---|---|
| `iss` | `https://login.microsoftonline.com/<tenant>/v2.0` |
| `tid` | the configured tenant |
| `aud` | the app's client ID (v2 tokens carry the GUID, not the URL) |
| `scp` | contains `Periscope.Access` |
| `roles` | contains the required app role |

## 4. Connect Claude

**claude.ai custom connector (recommended).** An organization admin adds a custom connector with:

- the URL `https://periscope.example.com/mcp`
- the client ID (Terraform output `client_id`)
- the client secret (output `connector_client_secret`)

Each user signs in once. The connector is then available:

- in Claude Code on the web
- in scheduled cloud tasks, which act as the user who owns the task
- in local Claude Code, when you are logged in with the claude.ai account

**Claude Code without the connector:**

```bash
claude mcp add --transport http --client-id <client-id> --callback-port 8765 periscope https://periscope.example.com/mcp
```

**Downloads from cloud sessions.** Connector traffic needs no network allowlist, but `curl` downloads from the cloud sandbox do. Add the Periscope hostname to the cloud environment's allowed domains (custom network access).

## 5. Sources and credentials

Read-only does not depend on the credential, but read-only credentials are a free extra layer where they are easy to set up:

| Source | Read-only credential |
|---|---|
| Cosmos DB | Managed identity with *Cosmos DB Built-in Data Reader* (`cosmos_data_readers`), or the account's read-only key |
| Blob Storage | Managed identity with *Storage Blob Data Reader*, or a SAS with `sp=rl` |
| Log Analytics | Managed identity with *Log Analytics Reader* |
| PostgreSQL | A role with `pg_read_all_data` or per-schema `SELECT`; Entra login for the managed identity |
| Oracle | A user with `CREATE SESSION` and `READ` grants. Add `SELECT_CATALOG_ROLE` for the precise routine analysis. Without it, user-defined routines are blocked unless allowlisted. |
| Redis | An ACL user with `+@read -@write -@dangerous -@scripting`, or a *Data Reader* access policy |

`list_sources` shows each source's credential state (`read-only verified`, `unverified` or `write-capable`).

**Recommended for Oracle,** with DBA approval: a `BEFORE DDL` trigger that raises an error when `SYS_CONTEXT('USERENV', 'MODULE') = 'periscope'`. Periscope sets this module name on every connection.

## 6. Operations

- **Audit log.** JSON lines on stdout (`stream: "audit"`), with one event per tool call, query start and end, and download. Result data is never logged.
- **Retention.** Results expire after `PERISCOPE_RESULTS_RETENTION` (default 24 hours). The storage lifecycle rule deletes them, and their status becomes `expired`.
- **Health.** `GET /healthz`.
- **Limits.** Per source, `MAX_QUERY_DURATION` and `MAX_RESULT_BYTES`; for Cosmos `MAX_RU_PER_SEC`; for Redis `MAX_OPS_PER_SEC`; per user, `PERISCOPE_MAX_CONCURRENT_QUERIES`.
