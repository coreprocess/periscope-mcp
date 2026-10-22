# Example: Periscope next to an application, with a Cosmos DB, a storage account,
# a Log Analytics workspace and an Oracle database reachable from the environment.

provider "azurerm" {
  features {}
}

provider "azuread" {}

variable "resource_group_name" { type = string }
variable "container_app_environment_id" { type = string }
variable "key_vault_id" { type = string }
variable "cosmos_account_name" { type = string }
variable "storage_account_id" { type = string }
variable "storage_blob_endpoint" { type = string }
variable "log_analytics_workspace_id" { type = string }
variable "log_analytics_workspace_resource_id" { type = string }
variable "reader_group_object_id" { type = string }

module "periscope" {
  source = "../.."

  name                         = "periscope-tst"
  resource_group_name          = var.resource_group_name
  location                     = "germanywestcentral"
  container_app_environment_id = var.container_app_environment_id
  key_vault_id                 = var.key_vault_id
  public_url                   = "https://tst-periscope.example.com"

  sources = [
    {
      name = "appdata"
      type = "cosmos"
      settings = {
        endpoint    = "https://${var.cosmos_account_name}.documents.azure.com:443/"
        auth        = "azure"
        database    = "main"
        description = "Application documents and processing state"
      }
    },
    {
      name     = "files"
      type     = "blob"
      settings = { account_url = var.storage_blob_endpoint, auth = "azure" }
    },
    {
      name     = "logs"
      type     = "loganalytics"
      settings = { workspace_id = var.log_analytics_workspace_id }
    },
    {
      name     = "erp"
      type     = "oracle"
      settings = { description = "ERP (Oracle 19c)" }
      secrets = {
        connect_string = "${var.key_vault_id}/secrets/erp-connect-string"
        user           = "${var.key_vault_id}/secrets/erp-user"
        password       = "${var.key_vault_id}/secrets/erp-password"
      }
    },
  ]

  data_role_assignments = [
    { scope = var.storage_account_id, role_definition_name = "Storage Blob Data Reader" },
    { scope = var.log_analytics_workspace_resource_id, role_definition_name = "Log Analytics Reader" },
  ]
  cosmos_data_readers = [
    { resource_group_name = var.resource_group_name, account_name = var.cosmos_account_name },
  ]
  app_role_members = {
    "Periscope.Reader" = [var.reader_group_object_id]
  }
}

output "mcp_url" { value = module.periscope.mcp_url }
output "client_id" { value = module.periscope.client_id }
output "internal_fqdn" { value = module.periscope.internal_fqdn }
