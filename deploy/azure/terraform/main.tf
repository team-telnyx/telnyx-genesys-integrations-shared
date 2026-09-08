terraform {
  required_version = ">= 1.11.0"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.7"
    }
  }
}
provider "azurerm" {
  features {}
  subscription_id     = var.subscription_id
  storage_use_azuread = true
}
data "azurerm_client_config" "current" {}
resource "random_id" "suffix" {
  byte_length = 4
}
locals {
  name = var.deployment_name
  tags = { Deployment = local.name, ManagedBy = "terraform", Component = "genesys-integrations" }
}
resource "azurerm_resource_group" "main" {
  name     = "${local.name}-rg"
  location = var.region
  tags     = local.tags
}
resource "azurerm_virtual_network" "main" {
  name                = "${local.name}-vnet"
  resource_group_name = azurerm_resource_group.main.name
  location            = var.region
  address_space       = ["10.86.0.0/16"]
  tags                = local.tags
}
resource "azurerm_subnet" "app" {
  name                 = "app"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = ["10.86.1.0/24"]
}
resource "azurerm_subnet" "db" {
  name                 = "database"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = ["10.86.2.0/24"]
  delegation {
    name = "postgresql"
    service_delegation {
      name    = "Microsoft.DBforPostgreSQL/flexibleServers"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}
resource "azurerm_network_security_group" "app" {
  name                = "${local.name}-app-nsg"
  resource_group_name = azurerm_resource_group.main.name
  location            = var.region
  security_rule {
    name                       = "https"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_ranges    = ["80", "443"]
    source_address_prefix      = "Internet"
    destination_address_prefix = "*"
  }
  security_rule {
    name                       = "admin-ssh"
    priority                   = 110
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "22"
    source_address_prefix      = var.admin_cidr
    destination_address_prefix = "*"
  }
  tags = local.tags
}
resource "azurerm_subnet_network_security_group_association" "app" {
  subnet_id                 = azurerm_subnet.app.id
  network_security_group_id = azurerm_network_security_group.app.id
}
resource "azurerm_public_ip" "app" {
  name                = "${local.name}-ip"
  resource_group_name = azurerm_resource_group.main.name
  location            = var.region
  allocation_method   = "Static"
  sku                 = "Standard"
  tags                = local.tags
}
resource "azurerm_network_interface" "app" {
  name                = "${local.name}-nic"
  resource_group_name = azurerm_resource_group.main.name
  location            = var.region
  ip_configuration {
    name                          = "app"
    subnet_id                     = azurerm_subnet.app.id
    private_ip_address_allocation = "Dynamic"
    public_ip_address_id          = azurerm_public_ip.app.id
  }
  tags = local.tags
}
resource "azurerm_linux_virtual_machine" "app" {
  name                            = "${local.name}-app"
  resource_group_name             = azurerm_resource_group.main.name
  location                        = var.region
  size                            = var.instance_type
  admin_username                  = "gixadmin"
  disable_password_authentication = true
  network_interface_ids           = [azurerm_network_interface.app.id]
  custom_data                     = filebase64("${path.module}/../../runtime/cloud-init.sh")
  admin_ssh_key {
    username   = "gixadmin"
    public_key = var.ssh_public_key
  }
  identity { type = "SystemAssigned" }
  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "Premium_LRS"
    disk_size_gb         = var.disk_size_gb
  }
  source_image_reference {
    publisher = "Canonical"
    offer     = "ubuntu-24_04-lts"
    sku       = "server"
    version   = "latest"
  }
  lifecycle { ignore_changes = [custom_data, source_image_reference] }
  tags = local.tags
}
resource "azurerm_storage_account" "artifacts" {
  name                            = "gix${random_id.suffix.hex}"
  resource_group_name             = azurerm_resource_group.main.name
  location                        = var.region
  account_tier                    = "Standard"
  account_replication_type        = "LRS"
  min_tls_version                 = "TLS1_2"
  shared_access_key_enabled       = false
  allow_nested_items_to_be_public = false
  tags                            = local.tags
}
resource "azurerm_role_assignment" "artifact_writer" {
  scope                = azurerm_storage_account.artifacts.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = data.azurerm_client_config.current.object_id
}
resource "azurerm_storage_container" "artifacts" {
  name                  = "releases"
  storage_account_id    = azurerm_storage_account.artifacts.id
  container_access_type = "private"
  depends_on            = [azurerm_role_assignment.artifact_writer]
}
resource "azurerm_role_assignment" "artifact_reader" {
  scope                = azurerm_storage_account.artifacts.id
  role_definition_name = "Storage Blob Data Reader"
  principal_id         = azurerm_linux_virtual_machine.app.identity[0].principal_id
}
resource "azurerm_key_vault" "app" {
  name                       = "gix-${random_id.suffix.hex}"
  resource_group_name        = azurerm_resource_group.main.name
  location                   = var.region
  tenant_id                  = data.azurerm_client_config.current.tenant_id
  sku_name                   = "standard"
  soft_delete_retention_days = 7
  purge_protection_enabled   = true
  rbac_authorization_enabled = false
  access_policy {
    tenant_id          = data.azurerm_client_config.current.tenant_id
    object_id          = data.azurerm_client_config.current.object_id
    secret_permissions = ["Get", "List", "Set", "Delete", "Recover", "Backup", "Restore"]
  }
  access_policy {
    tenant_id          = data.azurerm_client_config.current.tenant_id
    object_id          = azurerm_linux_virtual_machine.app.identity[0].principal_id
    secret_permissions = ["Get"]
  }
  tags = local.tags
}
resource "azurerm_private_dns_zone" "db" {
  name                = "${local.name}.postgres.database.azure.com"
  resource_group_name = azurerm_resource_group.main.name
}
resource "azurerm_private_dns_zone_virtual_network_link" "db" {
  name                  = "database"
  resource_group_name   = azurerm_resource_group.main.name
  private_dns_zone_name = azurerm_private_dns_zone.db.name
  virtual_network_id    = azurerm_virtual_network.main.id
}
# Database credentials are sensitive Terraform state; use a protected backend.
resource "random_password" "db" {
  length  = 32
  special = false
}
resource "azurerm_postgresql_flexible_server" "db" {
  name                          = "${local.name}-${random_id.suffix.hex}-pg"
  resource_group_name           = azurerm_resource_group.main.name
  location                      = var.region
  version                       = "17"
  delegated_subnet_id           = azurerm_subnet.db.id
  private_dns_zone_id           = azurerm_private_dns_zone.db.id
  public_network_access_enabled = false
  administrator_login           = "gixadmin"
  administrator_password        = random_password.db.result
  sku_name                      = var.db_instance_type
  storage_mb                    = 32768
  backup_retention_days         = 7
  depends_on                    = [azurerm_private_dns_zone_virtual_network_link.db]
  tags                          = local.tags
}
resource "azurerm_postgresql_flexible_server_database" "app" {
  name      = "telnyx_genesys"
  server_id = azurerm_postgresql_flexible_server.db.id
  charset   = "UTF8"
  collation = "en_US.utf8"
}
resource "azurerm_key_vault_secret" "db" {
  name         = "db-credentials"
  key_vault_id = azurerm_key_vault.app.id
  value = jsonencode({
    username = azurerm_postgresql_flexible_server.db.administrator_login
    password = random_password.db.result
    host     = azurerm_postgresql_flexible_server.db.fqdn
    port     = 5432
    dbname   = azurerm_postgresql_flexible_server_database.app.name
  })
}
output "deployment" {
  value = {
    target          = "azure"
    subscription_id = var.subscription_id
    region          = var.region
    domain          = var.domain
    resource_group  = azurerm_resource_group.main.name
    instance        = azurerm_linux_virtual_machine.app.name
    public_ip       = azurerm_public_ip.app.ip_address
    storage_account = azurerm_storage_account.artifacts.name
    container       = azurerm_storage_container.artifacts.name
    vault           = azurerm_key_vault.app.name
    app_secret      = "app-env"
    db_secret       = azurerm_key_vault_secret.db.name
    app_url         = "https://${var.domain}"
  }
}
