variable "dns_zone_name" {
  type        = string
  default     = ""
  description = "Existing public Azure DNS zone in this subscription; empty means externally managed DNS."
  validation {
    condition     = var.dns_zone_name == "" || (var.domain == var.dns_zone_name || endswith(var.domain, ".${var.dns_zone_name}"))
    error_message = "The hostname must belong to the selected DNS zone."
  }
}
variable "dns_zone_resource_group" {
  type        = string
  default     = ""
  description = "Resource group containing the existing public DNS zone."
  validation {
    condition     = (var.dns_zone_name == "") == (var.dns_zone_resource_group == "")
    error_message = "Supply both DNS zone name and resource group, or neither."
  }
}
resource "azurerm_dns_a_record" "app" {
  count               = var.dns_zone_name == "" ? 0 : 1
  name                = var.domain == var.dns_zone_name ? "@" : trimsuffix(var.domain, ".${var.dns_zone_name}")
  zone_name           = var.dns_zone_name
  resource_group_name = var.dns_zone_resource_group
  ttl                 = 300
  records             = [azurerm_public_ip.app.ip_address]
}
