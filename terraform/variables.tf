variable "name" {
  description = "Base name for all resources, e.g. \"periscope-tst\"."
  type        = string
}

variable "resource_group_name" {
  description = "Resource group for the identity, the result storage account and the Container App."
  type        = string
}

variable "location" {
  description = "Azure region."
  type        = string
}

variable "tags" {
  description = "Tags applied to all Azure resources."
  type        = map(string)
  default     = {}
}

variable "container_app_environment_id" {
  description = "Existing Container Apps environment (VNet-integrated, so the sources are reachable)."
  type        = string
}

variable "image" {
  description = "Container image, pinned to a version or digest."
  type        = string
  default     = "ghcr.io/coreprocess/periscope-mcp:0.1.0"
}

variable "registry" {
  description = "Optional private registry the image is pulled from with the Periscope identity (e.g. after az acr import)."
  type = object({
    server = string # e.g. myregistry.azurecr.io
    id     = string # resource ID, for the AcrPull role assignment
  })
  default = null
}

variable "public_url" {
  description = "Public base URL on a verified domain, without trailing slash, e.g. \"https://periscope.example.com\". The MCP endpoint is <public_url>/mcp."
  type        = string

  validation {
    condition     = can(regex("^https://[^/]+$", var.public_url))
    error_message = "public_url must be https://<host> without path or trailing slash."
  }
}

variable "ingress_external" {
  description = "Expose the app on the environment's ingress (still internal if the environment uses an internal load balancer)."
  type        = bool
  default     = true
}

variable "cpu" {
  type    = number
  default = 1
}

variable "memory" {
  type    = string
  default = "2Gi"
}

variable "max_replicas" {
  type    = number
  default = 3
}

variable "sources" {
  description = <<-EOT
    Data sources, in order. `settings` become PERISCOPE_SOURCE_<i>_<KEY> plain values; `secrets` map a key to a
    versionless Key Vault secret ID and become Key Vault references read with the Periscope identity.
  EOT
  type = list(object({
    name     = string
    type     = string
    settings = optional(map(string), {})
    secrets  = optional(map(string), {})
  }))
}

variable "settings" {
  description = "Additional global PERISCOPE_* settings, e.g. { PERISCOPE_READ_MAX_ROWS = \"1000\" }."
  type        = map(string)
  default     = {}
}

variable "key_vault_id" {
  description = "Key Vault for the download signing key and source secrets. The Periscope identity gets Key Vault Secrets User on it."
  type        = string
}

variable "results_retention_days" {
  description = "Days after which result files are deleted (lifecycle rule). Keep in sync with PERISCOPE_RESULTS_RETENTION."
  type        = number
  default     = 1
}

variable "results_storage_public_network_access" {
  description = "Allow public network access to the result storage account. Keep false and use a private endpoint where possible."
  type        = bool
  default     = false
}

variable "data_role_assignments" {
  description = "Azure RBAC roles for the Periscope identity, e.g. Storage Blob Data Reader on a storage account, Log Analytics Reader on a workspace."
  type = list(object({
    scope                = string
    role_definition_name = string
  }))
  default = []
}

variable "cosmos_data_readers" {
  description = "Cosmos DB accounts on which the Periscope identity gets the built-in Data Reader role."
  type = list(object({
    resource_group_name = string
    account_name        = string
  }))
  default = []
}

variable "readers" {
  description = "Object IDs of users or groups that get the app role Periscope.Reader (access to every source)."
  type        = list(string)
  default     = []
}

variable "create_connector_secret" {
  description = "Create a client secret for the claude.ai custom connector (confidential client)."
  type        = bool
  default     = true
}

variable "preauthorize_azure_cli" {
  description = "Pre-authorize the Azure CLI on the scope, so local clients can use `az account get-access-token`."
  type        = bool
  default     = false
}
