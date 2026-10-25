# Entra ID app registration (concept §7.2). Order and exactness matter:
# v2 tokens first, then the Application ID URI equal to the MCP URL (verified domain, no trailing slash).

data "azuread_client_config" "current" {}

locals {
  mcp_url = "${var.public_url}/mcp"
}

resource "random_uuid" "scope" {}

# Periscope.Reader is the only app role: it grants access to every source.
resource "random_uuid" "reader" {}

resource "azuread_application" "periscope" {
  display_name     = var.name
  sign_in_audience = "AzureADMyOrg"
  identifier_uris  = [local.mcp_url]
  owners           = [data.azuread_client_config.current.object_id]

  api {
    requested_access_token_version = 2

    oauth2_permission_scope {
      id                         = random_uuid.scope.result
      value                      = "Periscope.Access"
      type                       = "User"
      enabled                    = true
      admin_consent_display_name = "Access Periscope"
      admin_consent_description  = "Query the data sources configured in Periscope (read-only)."
      user_consent_display_name  = "Access Periscope"
      user_consent_description   = "Query the data sources configured in Periscope (read-only)."
    }
  }

  app_role {
    id                   = random_uuid.reader.result
    value                = "Periscope.Reader"
    display_name         = "Periscope.Reader"
    description          = "Access to every source of this Periscope"
    allowed_member_types = ["User"]
    enabled              = true
  }

  # claude.ai custom connector (confidential client with secret)
  web {
    redirect_uris = ["https://claude.ai/api/mcp/auth_callback"]
  }

  # Claude Code and other local clients (public client, PKCE, loopback redirect on any port)
  public_client {
    redirect_uris = ["http://localhost/", "http://127.0.0.1/"]
  }
}

resource "azuread_service_principal" "periscope" {
  client_id                    = azuread_application.periscope.client_id
  app_role_assignment_required = true
  owners                       = [data.azuread_client_config.current.object_id]
}

resource "azuread_app_role_assignment" "readers" {
  for_each = toset(var.readers)

  app_role_id         = random_uuid.reader.result
  principal_object_id = each.value
  resource_object_id  = azuread_service_principal.periscope.object_id
}

resource "azuread_application_password" "connector" {
  count          = var.create_connector_secret ? 1 : 0
  application_id = azuread_application.periscope.id
  display_name   = "claude.ai connector"
}

resource "azuread_application_pre_authorized" "azure_cli" {
  count                = var.preauthorize_azure_cli ? 1 : 0
  application_id       = azuread_application.periscope.id
  authorized_client_id = "04b07795-8ddb-461a-bbee-02f9e1bf7b46"
  permission_ids       = [random_uuid.scope.result]
}
