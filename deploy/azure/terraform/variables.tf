variable "deployment_name" {
  type    = string
  default = "genesys-integrations"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,25}$", var.deployment_name))
    error_message = "Use a 2-26 character lowercase slug starting with a letter."
  }
}
variable "domain" {
  type        = string
  description = "Public hostname whose DNS A record will point to the application IP."
  validation {
    condition     = can(regex("^[a-zA-Z0-9][a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$", var.domain))
    error_message = "Use a hostname, without a scheme, port or path."
  }
}
variable "disk_size_gb" {
  type    = number
  default = 64
}
variable "region" {
  type    = string
  default = "westeurope"
}
variable "instance_type" {
  type    = string
  default = "Standard_D2s_v5"
}
variable "db_instance_type" {
  type    = string
  default = "B_Standard_B1ms"
}
variable "subscription_id" { type = string }
variable "ssh_public_key" {
  type        = string
  description = "Operator SSH public key; never supply a private key."
}
variable "admin_cidr" {
  type        = string
  description = "Operator public IPv4 CIDR for interactive SSH bootstrap."
  validation {
    condition     = can(cidrnetmask(var.admin_cidr)) && can(regex("/(2[4-9]|3[0-2])$", var.admin_cidr))
    error_message = "Restrict SSH to an IPv4 /24 through /32 CIDR."
  }
}
