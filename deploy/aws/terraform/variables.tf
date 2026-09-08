variable "region" {
  description = "AWS region for the deployment and the existing ACM certificate."
  type        = string
  default     = "us-east-2"
}

variable "deployment_name" {
  description = "Stable environment key used for AWS resource and secret names."
  type        = string
  default     = "genesys-integrations"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,25}$", var.deployment_name))
    error_message = "deployment_name must be a 2-26 character lowercase slug."
  }
}

variable "domain" {
  description = "Public application hostname."
  type        = string
}

variable "route53_zone_id" {
  description = "Existing public Route53 hosted zone id for domain."
  type        = string
}

variable "acm_certificate_arn" {
  description = "Existing ISSUED ACM certificate ARN covering domain."
  type        = string
}

variable "instance_type" {
  description = "Single application node size."
  type        = string
  default     = "t3.medium"
}

variable "root_volume_size" {
  description = "Encrypted EC2 gp3 root volume size in GiB."
  type        = number
  default     = 30
}

variable "db_instance_class" {
  description = "RDS PostgreSQL instance class."
  type        = string
  default     = "db.t4g.micro"
}

variable "db_allocated_storage" {
  description = "Initial RDS gp3 storage in GiB."
  type        = number
  default     = 20
}

variable "db_backup_retention_days" {
  description = "Automated RDS backup retention."
  type        = number
  default     = 7
}

variable "db_skip_final_snapshot" {
  description = "Set true only for disposable environments."
  type        = bool
  default     = false
}

variable "artifact_bucket" {
  description = "Existing S3 artifact bucket; empty creates a private deployment-owned bucket."
  type        = string
  default     = ""
}

variable "artifact_prefix" {
  description = "Application prefix in artifact_bucket."
  type        = string
  default     = "genesys-integrations"
}

variable "owner_email" {
  description = "Deployment owner."
  type        = string

  validation {
    condition     = can(regex("^[^@[:space:]]+@[^@[:space:]]+$", var.owner_email))
    error_message = "owner_email must be an email address."
  }
}

variable "vpc_cidr" {
  type    = string
  default = "10.84.0.0/16"
}

variable "public_subnet_cidrs" {
  type    = list(string)
  default = ["10.84.0.0/24", "10.84.1.0/24"]
}

variable "private_subnet_cidrs" {
  type    = list(string)
  default = ["10.84.10.0/24", "10.84.11.0/24"]
}

variable "alb_deletion_protection" {
  type    = bool
  default = false
}

variable "portainer_agent_enabled" {
  description = "Whether to run the Portainer agent container on the application node."
  type        = bool
  default     = false
}

variable "portainer_agent_port" {
  description = "Host TCP port mapped to the Portainer agent's port 9001."
  type        = number
  default     = 9001

  validation {
    condition     = var.portainer_agent_port >= 1 && var.portainer_agent_port <= 65535
    error_message = "portainer_agent_port must be between 1 and 65535."
  }
}

variable "portainer_server_cidrs" {
  description = "IPv4 CIDRs of existing Portainer servers allowed to reach the agent. Empty keeps the agent port closed."
  type        = set(string)
  default     = []

  validation {
    condition = alltrue([
      for cidr in var.portainer_server_cidrs : can(cidrnetmask(cidr)) && cidr != "0.0.0.0/0"
    ])
    error_message = "Every portainer_server_cidrs entry must be a valid IPv4 CIDR, and 0.0.0.0/0 is forbidden."
  }
}

variable "tags" {
  type    = map(string)
  default = {}
}
