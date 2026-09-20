mock_provider "azurerm" {
  mock_data "azurerm_client_config" {
    defaults = {
      tenant_id = "00000000-0000-0000-0000-000000000000"
      object_id = "00000000-0000-0000-0000-000000000001"
    }
  }
}
mock_provider "random" {}
run "private_single_node" {
  command = plan
  variables {
    subscription_id = "00000000-0000-0000-0000-000000000000"
    domain          = "genesys.example.com"
    admin_cidr      = "203.0.113.10/32"
    ssh_public_key  = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEhWVf4ksI91EgjsTDEMVIOGbZiqVCDlcGGntVPpyYqg"
  }
  assert {
    condition     = length(azurerm_dns_a_record.app) == 0
    error_message = "External DNS must not create records."
  }
  assert {
    condition     = azurerm_postgresql_flexible_server.db.public_network_access_enabled == false
    error_message = "The managed database must not have public network access."
  }
  assert {
    condition     = azurerm_linux_virtual_machine.app.disable_password_authentication && azurerm_linux_virtual_machine.app.identity[0].type == "SystemAssigned"
    error_message = "VM must use SSH keys and native managed identity."
  }
  assert {
    condition     = !azurerm_storage_account.artifacts.allow_nested_items_to_be_public && !azurerm_storage_account.artifacts.shared_access_key_enabled
    error_message = "Artifact storage must require identity-based access."
  }
}
run "public_dns" {
  command = plan
  variables {
    subscription_id         = "00000000-0000-0000-0000-000000000000"
    domain                  = "genesys.example.com"
    admin_cidr              = "203.0.113.10/32"
    ssh_public_key          = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEhWVf4ksI91EgjsTDEMVIOGbZiqVCDlcGGntVPpyYqg"
    dns_zone_name           = "example.com"
    dns_zone_resource_group = "existing-dns-rg"
  }
  assert {
    condition     = azurerm_dns_a_record.app[0].name == "genesys" && azurerm_dns_a_record.app[0].resource_group_name == "existing-dns-rg" && azurerm_dns_a_record.app[0].ttl == 300
    error_message = "Create the hostname in the selected existing zone."
  }
}

run "zone_apex" {
  command = plan
  variables {
    subscription_id         = "00000000-0000-0000-0000-000000000000"
    domain                  = "example.com"
    admin_cidr              = "203.0.113.10/32"
    ssh_public_key          = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEhWVf4ksI91EgjsTDEMVIOGbZiqVCDlcGGntVPpyYqg"
    dns_zone_name           = "example.com"
    dns_zone_resource_group = "existing-dns-rg"
  }
  assert {
    condition     = azurerm_dns_a_record.app[0].name == "@"
    error_message = "The zone apex must use @."
  }
}
