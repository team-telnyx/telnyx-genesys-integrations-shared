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
  default = "europe-west1"
}
variable "zone" {
  type    = string
  default = "europe-west1-b"
}
variable "instance_type" {
  type    = string
  default = "e2-medium"
}
variable "db_instance_type" {
  type    = string
  default = "db-custom-1-3840"
}
variable "project_id" { type = string }
variable "db_deletion_protection" {
  type    = bool
  default = true
}
