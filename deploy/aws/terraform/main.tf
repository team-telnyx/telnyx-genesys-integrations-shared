locals {
  name_prefix = var.deployment_name
  common_tags = merge({
    Name       = var.deployment_name
    Deployment = var.deployment_name
    ManagedBy  = "terraform"
    Component  = "telnyx-genesys-integrations"
  }, var.tags)

  app_port            = 3000
  app_env_secret_name = "${var.deployment_name}/app/env"
  db_secret_name      = "${var.deployment_name}/db/credentials"
  public_url          = "https://${var.domain}"


}

data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"]

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }

  filter {
    name   = "architecture"
    values = ["x86_64"]
  }
}

data "aws_caller_identity" "current" {}

data "aws_s3_bucket" "artifacts" {
  count  = var.artifact_bucket == "" ? 0 : 1
  bucket = var.artifact_bucket
}

resource "aws_s3_bucket" "artifacts" {
  count  = var.artifact_bucket == "" ? 1 : 0
  bucket = "${var.deployment_name}-${data.aws_caller_identity.current.account_id}-${var.region}"
  tags   = local.common_tags
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  count                   = var.artifact_bucket == "" ? 1 : 0
  bucket                  = aws_s3_bucket.artifacts[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "artifacts" {
  count  = var.artifact_bucket == "" ? 1 : 0
  bucket = aws_s3_bucket.artifacts[0].id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

locals {
  artifact_bucket_name = var.artifact_bucket == "" ? aws_s3_bucket.artifacts[0].id : data.aws_s3_bucket.artifacts[0].id
  artifact_bucket_arn  = var.artifact_bucket == "" ? aws_s3_bucket.artifacts[0].arn : data.aws_s3_bucket.artifacts[0].arn
}

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = merge(local.common_tags, { Name = "${local.name_prefix}-vpc" })
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = merge(local.common_tags, { Name = "${local.name_prefix}-igw" })
}

resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.main.id
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  cidr_block              = var.public_subnet_cidrs[count.index]
  map_public_ip_on_launch = true
  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-public-${count.index + 1}"
    Tier = "public"
  })
}

resource "aws_subnet" "private" {
  count                   = 2
  vpc_id                  = aws_vpc.main.id
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  cidr_block              = var.private_subnet_cidrs[count.index]
  map_public_ip_on_launch = false
  tags = merge(local.common_tags, {
    Name = "${local.name_prefix}-private-${count.index + 1}"
    Tier = "private"
  })
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = merge(local.common_tags, { Name = "${local.name_prefix}-public" })
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id
  tags   = merge(local.common_tags, { Name = "${local.name_prefix}-private" })
}

resource "aws_route_table_association" "private" {
  count          = 2
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

resource "aws_security_group" "alb" {
  name        = "${local.name_prefix}-alb-sg"
  description = "Public HTTPS entry point"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "HTTP redirect"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.common_tags, { Name = "${local.name_prefix}-alb-sg" })
}

resource "aws_security_group" "app" {
  name        = "${local.name_prefix}-app-sg"
  description = "Application port only from ALB; no SSH ingress"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "HTTP and WebSocket upgrades from ALB"
    from_port       = local.app_port
    to_port         = local.app_port
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  dynamic "ingress" {
    for_each = var.portainer_agent_enabled && length(var.portainer_server_cidrs) > 0 ? [1] : []
    content {
      description = "Portainer agent from the existing central server"
      from_port   = var.portainer_agent_port
      to_port     = var.portainer_agent_port
      protocol    = "tcp"
      cidr_blocks = sort(tolist(var.portainer_server_cidrs))
    }
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.common_tags, { Name = "${local.name_prefix}-app-sg" })
}

resource "aws_security_group" "rds" {
  name        = "${local.name_prefix}-rds-sg"
  description = "PostgreSQL only from the application node"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "PostgreSQL from app"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.common_tags, { Name = "${local.name_prefix}-rds-sg" })
}

resource "aws_db_subnet_group" "main" {
  name       = "${local.name_prefix}-db-subnets"
  subnet_ids = aws_subnet.private[*].id
  tags       = merge(local.common_tags, { Name = "${local.name_prefix}-db-subnets" })
}

ephemeral "random_password" "db" {
  length           = 28
  special          = true
  override_special = "!#$%^&*()-_=+[]{}<>:?"
}

resource "random_id" "db_lifecycle" {
  byte_length = 4

  keepers = {
    db_identifier = "${local.name_prefix}-pg"
  }
}

resource "aws_secretsmanager_secret" "db" {
  name                    = local.db_secret_name
  description             = "Genesys Integrations RDS PostgreSQL credentials"
  recovery_window_in_days = 0
  tags                    = local.common_tags
}

# Persist the generated password before RDS creation. If apply is interrupted
# after RDS succeeds, a retry reads this exact version instead of generating a
# different password that would no longer match the database.
resource "aws_secretsmanager_secret_version" "db_bootstrap" {
  secret_id = aws_secretsmanager_secret.db.id
  secret_string_wo = jsonencode({
    username = "telnyx_genesys"
    password = ephemeral.random_password.db.result
    engine   = "postgres"
    port     = 5432
    dbname   = "telnyx_genesys"
  })
  secret_string_wo_version = 1
}

ephemeral "aws_secretsmanager_secret_version" "db_bootstrap" {
  secret_id  = aws_secretsmanager_secret.db.id
  version_id = aws_secretsmanager_secret_version.db_bootstrap.version_id
}

resource "aws_db_instance" "main" {
  identifier                 = "${local.name_prefix}-pg"
  engine                     = "postgres"
  engine_version             = "17"
  instance_class             = var.db_instance_class
  allocated_storage          = var.db_allocated_storage
  max_allocated_storage      = max(var.db_allocated_storage * 2, 100)
  storage_type               = "gp3"
  storage_encrypted          = true
  db_name                    = "telnyx_genesys"
  username                   = "telnyx_genesys"
  password_wo                = jsondecode(ephemeral.aws_secretsmanager_secret_version.db_bootstrap.secret_string).password
  password_wo_version        = 1
  port                       = 5432
  multi_az                   = false
  db_subnet_group_name       = aws_db_subnet_group.main.name
  vpc_security_group_ids     = [aws_security_group.rds.id]
  publicly_accessible        = false
  backup_retention_period    = var.db_backup_retention_days
  copy_tags_to_snapshot      = true
  auto_minor_version_upgrade = true
  apply_immediately          = true
  deletion_protection        = false
  skip_final_snapshot        = var.db_skip_final_snapshot
  final_snapshot_identifier  = var.db_skip_final_snapshot ? null : "${local.name_prefix}-pg-final-${random_id.db_lifecycle.hex}"
  tags                       = merge(local.common_tags, { Name = "${local.name_prefix}-pg" })
}

resource "aws_secretsmanager_secret_version" "db" {
  secret_id = aws_secretsmanager_secret.db.id
  secret_string_wo = jsonencode({
    username = jsondecode(ephemeral.aws_secretsmanager_secret_version.db_bootstrap.secret_string).username
    password = jsondecode(ephemeral.aws_secretsmanager_secret_version.db_bootstrap.secret_string).password
    engine   = jsondecode(ephemeral.aws_secretsmanager_secret_version.db_bootstrap.secret_string).engine
    host     = aws_db_instance.main.address
    port     = jsondecode(ephemeral.aws_secretsmanager_secret_version.db_bootstrap.secret_string).port
    dbname   = jsondecode(ephemeral.aws_secretsmanager_secret_version.db_bootstrap.secret_string).dbname
  })
  secret_string_wo_version = 1
}

resource "aws_secretsmanager_secret" "app_env" {
  name                    = local.app_env_secret_name
  description             = "Genesys Integrations runtime environment; populated by deploy.sh outside Terraform state"
  recovery_window_in_days = 0
  tags                    = local.common_tags
}

resource "aws_secretsmanager_secret_version" "app_env_placeholder" {
  secret_id     = aws_secretsmanager_secret.app_env.id
  secret_string = "# placeholder - populated by deploy.sh"

  lifecycle {
    ignore_changes = [secret_string]
  }
}

data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "app" {
  name               = "${local.name_prefix}-app-role"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
  tags               = local.common_tags
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.app.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "app" {
  statement {
    sid       = "ReadRuntimeEnvironment"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.app_env.arn]
  }

  statement {
    sid       = "ReadDatabaseCredentials"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.db.arn]
  }

  statement {
    sid       = "ReadArtifacts"
    actions   = ["s3:GetObject"]
    resources = ["${local.artifact_bucket_arn}/${var.artifact_prefix}/*"]
  }

  statement {
    sid       = "ReadArtifactBucketMetadata"
    actions   = ["s3:GetBucketLocation"]
    resources = [local.artifact_bucket_arn]
  }

  statement {
    sid       = "ListArtifactPrefix"
    actions   = ["s3:ListBucket"]
    resources = [local.artifact_bucket_arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["${var.artifact_prefix}/*"]
    }
  }
}

resource "aws_iam_role_policy" "app" {
  name   = "${local.name_prefix}-app"
  role   = aws_iam_role.app.id
  policy = data.aws_iam_policy_document.app.json
}

resource "aws_iam_instance_profile" "app" {
  name = "${local.name_prefix}-app-profile"
  role = aws_iam_role.app.name
}

resource "aws_instance" "app" {
  ami                         = data.aws_ami.ubuntu.id
  instance_type               = var.instance_type
  subnet_id                   = aws_subnet.public[0].id
  vpc_security_group_ids      = [aws_security_group.app.id]
  iam_instance_profile        = aws_iam_instance_profile.app.name
  associate_public_ip_address = true
  user_data_replace_on_change = false

  user_data = templatefile("${path.module}/user_data.sh.tpl", {
    region                  = var.region
    app_env_secret          = aws_secretsmanager_secret.app_env.arn
    db_secret               = aws_secretsmanager_secret.db.arn
    portainer_agent_enabled = var.portainer_agent_enabled
    portainer_agent_port    = var.portainer_agent_port
  })

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "enabled"
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.root_volume_size
    encrypted             = true
    delete_on_termination = true
  }

  depends_on = [
    aws_iam_role_policy.app,
    aws_iam_role_policy_attachment.ssm,
  ]

  # The node owns persistent Docker volumes. Routine provider/AMI or
  # cloud-init template refreshes must not silently replace it.
  lifecycle {
    ignore_changes = [ami, user_data]
  }

  tags = merge(local.common_tags, { Name = "${local.name_prefix}-app", Owner = var.owner_email }, local.fde_tags)

}

resource "aws_lb" "main" {
  name                       = "${local.name_prefix}-alb"
  load_balancer_type         = "application"
  internal                   = false
  security_groups            = [aws_security_group.alb.id]
  subnets                    = aws_subnet.public[*].id
  idle_timeout               = 300
  enable_deletion_protection = var.alb_deletion_protection
  tags                       = merge(local.common_tags, { Name = "${local.name_prefix}-alb" })
}

resource "aws_lb_target_group" "app" {
  name        = "${local.name_prefix}-app"
  port        = local.app_port
  protocol    = "HTTP"
  target_type = "instance"
  vpc_id      = aws_vpc.main.id

  health_check {
    enabled             = true
    path                = "/api/health"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  deregistration_delay = 30
  tags                 = merge(local.common_tags, { Name = "${local.name_prefix}-app" })
}

resource "aws_lb_target_group_attachment" "app" {
  target_group_arn = aws_lb_target_group.app.arn
  target_id        = aws_instance.app.id
  port             = local.app_port
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.acm_certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}

resource "aws_route53_record" "app" {
  zone_id = var.route53_zone_id
  name    = var.domain
  type    = "A"

  alias {
    name                   = aws_lb.main.dns_name
    zone_id                = aws_lb.main.zone_id
    evaluate_target_health = true
  }
}

check "two_availability_zones" {
  assert {
    condition     = length(data.aws_availability_zones.available.names) >= 2
    error_message = "The selected AWS region must expose at least two availability zones for ALB and RDS subnet groups."
  }
}
