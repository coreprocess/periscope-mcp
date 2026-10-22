output "mcp_url" {
  description = "MCP endpoint (also the Application ID URI)."
  value       = local.mcp_url
}

output "scope" {
  description = "Fully qualified scope clients request."
  value       = "${local.mcp_url}/Periscope.Access"
}

output "client_id" {
  description = "Client ID of the app registration (token audience; client ID for claude.ai and Claude Code)."
  value       = azuread_application.periscope.client_id
}

output "connector_client_secret" {
  description = "Client secret for the claude.ai custom connector."
  value       = var.create_connector_secret ? azuread_application_password.connector[0].value : null
  sensitive   = true
}

output "internal_fqdn" {
  description = "FQDN of the Container App inside the environment; point the public gateway at it."
  value       = azurerm_container_app.periscope.ingress[0].fqdn
}

output "identity_principal_id" {
  description = "Principal ID of the Periscope identity, for additional role assignments (e.g. database logins)."
  value       = azurerm_user_assigned_identity.periscope.principal_id
}

output "identity_client_id" {
  value = azurerm_user_assigned_identity.periscope.client_id
}

output "results_storage_account_id" {
  value = azurerm_storage_account.results.id
}
