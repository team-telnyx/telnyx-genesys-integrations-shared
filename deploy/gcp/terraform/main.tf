terraform {
  required_version = ">= 1.11.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.7"
    }
  }
}
provider "google" {
  project = var.project_id
  region  = var.region
  zone    = var.zone
}
resource "google_project_service" "required" {
  for_each           = toset(["compute.googleapis.com", "sqladmin.googleapis.com", "servicenetworking.googleapis.com", "secretmanager.googleapis.com", "storage.googleapis.com", "iam.googleapis.com", "iap.googleapis.com", "oslogin.googleapis.com"])
  project            = var.project_id
  service            = each.key
  disable_on_destroy = false
}
resource "random_id" "suffix" { byte_length = 4 }
locals {
  name   = var.deployment_name
  labels = { deployment = local.name, managed_by = "terraform", component = "genesys-integrations" }
}
resource "google_compute_network" "main" {
  name                    = "${local.name}-vpc"
  auto_create_subnetworks = false
  depends_on              = [google_project_service.required]
}
resource "google_compute_subnetwork" "app" {
  name                     = "${local.name}-app"
  network                  = google_compute_network.main.id
  region                   = var.region
  ip_cidr_range            = "10.87.1.0/24"
  private_ip_google_access = true
}
resource "google_compute_firewall" "web" {
  name          = "${local.name}-web"
  network       = google_compute_network.main.id
  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["${local.name}-app"]
  allow {
    protocol = "tcp"
    ports    = ["80", "443"]
  }
}
resource "google_compute_firewall" "iap" {
  name          = "${local.name}-iap"
  network       = google_compute_network.main.id
  source_ranges = ["35.235.240.0/20"]
  target_tags   = ["${local.name}-app"]
  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}
resource "google_compute_address" "app" {
  name       = "${local.name}-ip"
  region     = var.region
  depends_on = [google_project_service.required]
}
resource "google_service_account" "app" {
  account_id   = "gix-${random_id.suffix.hex}"
  display_name = "${local.name} runtime"
  depends_on   = [google_project_service.required]
}
resource "google_compute_instance" "app" {
  name         = "${local.name}-app"
  machine_type = var.instance_type
  zone         = var.zone
  boot_disk {
    initialize_params {
      image = "ubuntu-os-cloud/ubuntu-2404-lts-amd64"
      type  = "pd-balanced"
      size  = var.disk_size_gb
    }
  }
  network_interface {
    subnetwork = google_compute_subnetwork.app.id
    access_config { nat_ip = google_compute_address.app.address }
  }
  service_account {
    email  = google_service_account.app.email
    scopes = ["https://www.googleapis.com/auth/cloud-platform"]
  }
  metadata                = { enable-oslogin = "TRUE", block-project-ssh-keys = "TRUE" }
  metadata_startup_script = file("${path.module}/../../runtime/cloud-init.sh")
  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }
  tags   = ["${local.name}-app"]
  labels = local.labels
  lifecycle { ignore_changes = [boot_disk[0].initialize_params[0].image, metadata_startup_script] }
}
resource "google_storage_bucket" "artifacts" {
  name                        = "${local.name}-${random_id.suffix.hex}"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  labels                      = local.labels
  depends_on                  = [google_project_service.required]
}
resource "google_storage_bucket_iam_member" "reader" {
  bucket = google_storage_bucket.artifacts.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.app.email}"
}
resource "google_compute_global_address" "db" {
  name          = "${local.name}-db-range"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = google_compute_network.main.id
}
resource "google_service_networking_connection" "db" {
  network                 = google_compute_network.main.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.db.name]
  deletion_policy         = "ABANDON"
}
resource "google_sql_database_instance" "db" {
  name                = "${local.name}-${random_id.suffix.hex}-pg"
  region              = var.region
  database_version    = "POSTGRES_17"
  deletion_protection = var.db_deletion_protection
  settings {
    tier              = var.db_instance_type
    edition           = "ENTERPRISE"
    disk_type         = "PD_SSD"
    disk_size         = 20
    disk_autoresize   = true
    availability_type = "ZONAL"
    ip_configuration {
      ipv4_enabled    = false
      private_network = google_compute_network.main.id
      ssl_mode        = "ENCRYPTED_ONLY"
    }
    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      transaction_log_retention_days = 7
    }
    user_labels = local.labels
  }
  depends_on = [google_service_networking_connection.db]
}
resource "google_sql_database" "app" {
  name            = "telnyx_genesys"
  instance        = google_sql_database_instance.db.name
  deletion_policy = "ABANDON"
}
# Database credentials are sensitive Terraform state; use a protected backend.
resource "random_password" "db" {
  length  = 32
  special = false
}
resource "google_sql_user" "app" {
  name            = "telnyx_genesys"
  instance        = google_sql_database_instance.db.name
  password        = random_password.db.result
  deletion_policy = "ABANDON"
}
resource "google_project_iam_member" "sql_client" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.app.email}"
  condition {
    title      = "deployment-database-only"
    expression = "resource.name == 'projects/${var.project_id}/instances/${google_sql_database_instance.db.name}'"
  }
}
resource "google_secret_manager_secret" "runtime" {
  for_each  = toset(["app-env", "db-credentials"])
  secret_id = "${local.name}-${each.key}"
  replication {
    auto {}
  }
  labels     = local.labels
  depends_on = [google_project_service.required]
}
resource "google_secret_manager_secret_iam_member" "reader" {
  for_each  = google_secret_manager_secret.runtime
  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.app.email}"
}
resource "google_secret_manager_secret_version" "db" {
  secret = google_secret_manager_secret.runtime["db-credentials"].id
  secret_data = jsonencode({
    username = google_sql_user.app.name
    password = random_password.db.result
    host     = "cloud-sql-proxy"
    port     = 5432
    dbname   = google_sql_database.app.name
  })
}
output "deployment" {
  value = {
    target         = "gcp"
    project_id     = var.project_id
    region         = var.region
    zone           = var.zone
    domain         = var.domain
    instance       = google_compute_instance.app.name
    public_ip      = google_compute_address.app.address
    bucket         = google_storage_bucket.artifacts.name
    app_secret     = google_secret_manager_secret.runtime["app-env"].secret_id
    db_secret      = google_secret_manager_secret.runtime["db-credentials"].secret_id
    sql_connection = google_sql_database_instance.db.connection_name
    app_url        = "https://${var.domain}"
  }
}
