# Entra ID app registration (concept §7.2). Order and exactness matter:
# v2 tokens first, then the Application ID URI equal to the MCP URL (verified domain, no trailing slash).

data "azuread_client_config" "current" {}

locals {
  mcp_url   = "${var.public_url}/mcp"
  app_roles = ["Periscope.Reader", "Periscope.ProdReader", "Periscope.Download"]
}

resource "random_uuid" "scope" {}

resource "random_uuid" "role" {
  for_each = toset(local.app_roles)
}

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

  dynamic "app_role" {
    for_each = toset(local.app_roles)
    content {
      id                   = random_uuid.role[app_role.value].result
      value                = app_role.value
      display_name         = app_role.value
      description          = "Periscope role ${app_role.value}"
      allowed_member_types = ["User"]
      enabled              = true
    }
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

locals {
  role_members = flatten([
    for role, members in var.app_role_members : [
      for member in members : { role = role, member = member }
    ]
  ])
}

resource "azuread_app_role_assignment" "members" {
  for_each = { for m in local.role_members : "${m.role}/${m.member}" => m }

  app_role_id         = random_uuid.role[each.value.role].result
  principal_object_id = each.value.member
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
