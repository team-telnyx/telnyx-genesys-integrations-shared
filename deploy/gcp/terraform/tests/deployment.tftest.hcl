mock_provider "google" {}
mock_provider "random" {}
run "private_single_node" {
  command = plan
  variables {
    project_id = "test-project"
    domain     = "genesys.example.com"
  }
  assert {
    condition     = !google_sql_database_instance.db.settings[0].ip_configuration[0].ipv4_enabled && google_sql_database_instance.db.settings[0].ip_configuration[0].ssl_mode == "ENCRYPTED_ONLY"
    error_message = "Cloud SQL must be private and require encrypted connections."
  }
  assert {
    condition     = google_compute_firewall.iap.source_ranges == toset(["35.235.240.0/20"])
    error_message = "SSH must only be reachable through IAP."
  }
  assert {
    condition     = google_storage_bucket.artifacts.public_access_prevention == "enforced" && !google_storage_bucket.artifacts.force_destroy
    error_message = "Artifacts must be private and protected from accidental deletion."
  }
  assert {
    condition     = google_sql_database_instance.db.deletion_protection
    error_message = "Database deletion must require opting out of protection."
  }
}
