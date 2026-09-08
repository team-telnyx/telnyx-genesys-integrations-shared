output "app_url" {
  value = local.public_url
}

output "instance_id" {
  value = aws_instance.app.id
}

output "alb_dns_name" {
  value = aws_lb.main.dns_name
}

output "app_env_secret_arn" {
  value = aws_secretsmanager_secret.app_env.arn
}

output "app_env_secret_name" {
  value = aws_secretsmanager_secret.app_env.name
}

output "db_secret_arn" {
  value = aws_secretsmanager_secret.db.arn
}

output "db_secret_name" {
  value = aws_secretsmanager_secret.db.name
}

output "db_endpoint" {
  value = aws_db_instance.main.address
}

output "artifact_bucket" {
  value = local.artifact_bucket_name
}

output "artifact_prefix" {
  value = var.artifact_prefix
}

output "target_group_arn" {
  value = aws_lb_target_group.app.arn
}

output "portainer_agent_enabled" {
  value = var.portainer_agent_enabled
}

output "portainer_agent_port" {
  value = var.portainer_agent_port
}

output "region" {
  value = var.region
}
