locals {
  storage_name = substr(replace(lower("${var.name}res"), "/[^a-z0-9]/", ""), 0, 24)

  global_env = merge({
    PERISCOPE_TRANSPORT           = "http"
    PERISCOPE_PUBLIC_URL          = var.public_url
    PERISCOPE_AUTH                = "entra"
    PERISCOPE_AUTH_TENANT_ID      = data.azuread_client_config.current.tenant_id
    PERISCOPE_AUTH_CLIENT_ID      = azuread_application.periscope.client_id
    PERISCOPE_RESULTS_STORE       = "azureblob"
    PERISCOPE_RESULTS_ACCOUNT_URL = azurerm_storage_account.results.primary_blob_endpoint
    PERISCOPE_RESULTS_CONTAINER   = azurerm_storage_container.results.name
    PERISCOPE_RESULTS_RETENTION   = "P${var.results_retention_days}D"
    AZURE_CLIENT_ID               = azurerm_user_assigned_identity.periscope.client_id
    PERISCOPE_SOURCE_N            = tostring(length(var.sources))
  }, var.settings)

  source_env = merge([
    for index, source in var.sources : merge(
      {
        "PERISCOPE_SOURCE_${index}_NAME" = source.name
        "PERISCOPE_SOURCE_${index}_TYPE" = source.type
      },
      { for key, value in source.settings : "PERISCOPE_SOURCE_${index}_${upper(key)}" => value }
    )
  ]...)

  source_secrets = merge([
    for index, source in var.sources : {
      for key, secret_id in source.secrets : "PERISCOPE_SOURCE_${index}_${upper(key)}" => {
        name = lower(replace("src-${index}-${key}", "_", "-"))
        id   = secret_id
      }
    }
  ]...)

  # Key Vault Secrets User per secret, never on the whole vault: the vault may hold other applications' secrets.
  key_vault_secret_scopes = merge(
    { download-signing-key = azurerm_key_vault_secret.signing_key.resource_versionless_id },
    { for env, secret in local.source_secrets : env => "${var.key_vault_id}/secrets/${regex("/secrets/([^/]+)", secret.id)[0]}" }
  )
}

resource "azurerm_user_assigned_identity" "periscope" {
  name                = "id-${var.name}"
  resource_group_name = var.resource_group_name
  location            = var.location
  tags                = var.tags
}

# Result store: Periscope's own storage, never a source.
resource "azurerm_storage_account" "results" {
  name                            = local.storage_name
  resource_group_name             = var.resource_group_name
  location                        = var.location
  account_tier                    = "Standard"
  account_replication_type        = "LRS"
  min_tls_version                 = "TLS1_2"
  shared_access_key_enabled       = false
  allow_nested_items_to_be_public = false
  public_network_access_enabled   = var.results_storage_public_network_access
  default_to_oauth_authentication = true
  tags                            = var.tags
}

resource "azurerm_storage_container" "results" {
  name                  = "results"
  storage_account_id    = azurerm_storage_account.results.id
  container_access_type = "private"
}

resource "azurerm_storage_management_policy" "results" {
  storage_account_id = azurerm_storage_account.results.id

  rule {
    name    = "expire-results"
    enabled = true
    filters {
      blob_types   = ["blockBlob"]
      prefix_match = ["results/"]
    }
    actions {
      base_blob {
        delete_after_days_since_creation_greater_than = var.results_retention_days
      }
    }
  }
}

resource "azurerm_role_assignment" "results" {
  scope                = azurerm_storage_container.results.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_user_assigned_identity.periscope.principal_id
}

resource "azurerm_role_assignment" "key_vault" {
  for_each = local.key_vault_secret_scopes

  scope                = each.value
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.periscope.principal_id
}

resource "azurerm_role_assignment" "data" {
  for_each = { for a in var.data_role_assignments : "${a.role_definition_name}@${a.scope}" => a }

  scope                = each.value.scope
  role_definition_name = each.value.role_definition_name
  principal_id         = azurerm_user_assigned_identity.periscope.principal_id
}

resource "azurerm_role_assignment" "registry" {
  count                = var.registry == null ? 0 : 1
  scope                = var.registry.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.periscope.principal_id
}

data "azurerm_cosmosdb_account" "readers" {
  for_each            = { for r in var.cosmos_data_readers : "${r.resource_group_name}/${r.account_name}" => r }
  name                = each.value.account_name
  resource_group_name = each.value.resource_group_name
}

resource "azurerm_cosmosdb_sql_role_assignment" "readers" {
  for_each = data.azurerm_cosmosdb_account.readers

  resource_group_name = each.value.resource_group_name
  account_name        = each.value.name
  # Cosmos DB Built-in Data Reader
  role_definition_id = "${each.value.id}/sqlRoleDefinitions/00000000-0000-0000-0000-000000000001"
  principal_id       = azurerm_user_assigned_identity.periscope.principal_id
  scope              = each.value.id
}

resource "random_password" "signing_key" {
  length  = 64
  special = false
}

resource "azurerm_key_vault_secret" "signing_key" {
  name         = "${var.name}-download-signing-key"
  key_vault_id = var.key_vault_id
  value        = random_password.signing_key.result
  content_type = "periscope download signing key"
}

resource "azurerm_container_app" "periscope" {
  name                         = var.name
  resource_group_name          = var.resource_group_name
  container_app_environment_id = var.container_app_environment_id
  revision_mode                = "Single"
  tags                         = var.tags

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.periscope.id]
  }

  dynamic "registry" {
    for_each = var.registry == null ? [] : [var.registry]
    content {
      server   = registry.value.server
      identity = azurerm_user_assigned_identity.periscope.id
    }
  }

  secret {
    name                = "download-signing-key"
    key_vault_secret_id = azurerm_key_vault_secret.signing_key.versionless_id
    identity            = azurerm_user_assigned_identity.periscope.id
  }

  dynamic "secret" {
    for_each = local.source_secrets
    content {
      name                = secret.value.name
      key_vault_secret_id = secret.value.id
      identity            = azurerm_user_assigned_identity.periscope.id
    }
  }

  ingress {
    external_enabled = var.ingress_external
    target_port      = 8080
    transport        = "http"

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    # Running queries live in the replica that started them; never scale to zero.
    min_replicas = 1
    max_replicas = var.max_replicas

    container {
      name   = "periscope"
      image  = var.image
      cpu    = var.cpu
      memory = var.memory

      dynamic "env" {
        for_each = merge(local.global_env, local.source_env)
        content {
          name  = env.key
          value = env.value
        }
      }

      env {
        name        = "PERISCOPE_DOWNLOAD_SIGNING_KEY"
        secret_name = "download-signing-key"
      }

      dynamic "env" {
        for_each = local.source_secrets
        content {
          name        = env.key
          secret_name = env.value.name
        }
      }

      liveness_probe {
        transport = "HTTP"
        path      = "/healthz"
        port      = 8080
      }

      readiness_probe {
        transport = "HTTP"
        path      = "/healthz"
        port      = 8080
      }
    }
  }

  depends_on = [azurerm_role_assignment.key_vault, azurerm_role_assignment.results]
}
