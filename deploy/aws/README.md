# AWS single-node deployment

Use the [shared deployment CLI](../README.md) to provision a standard AWS stack
in your own account:

```bash
# The dialogue collects and saves the required inputs.
./deploy/deploy plan --target aws
./deploy/deploy up --target aws
./deploy/deploy bootstrap --target aws
```

The stack has a dedicated VPC, two public and two private subnets, one Ubuntu
24.04 EC2 node, private encrypted RDS PostgreSQL 17, Secrets Manager, an ALB,
and a Route53 alias. The ALB terminates an existing ACM certificate and forwards
HTTP/SSE/WebSocket traffic to port 3000. EC2 accepts that port only from the ALB;
there is no SSH ingress. Management uses standard AWS Systems Manager.

Terraform creates a private encrypted S3 artifact bucket by default. Set
`artifact_bucket` to use an existing bucket. No organization-specific profile,
domain, bucket, tags or deployment controller is required. `AWS_PROFILE` is
optional; normal AWS CLI credentials (including SSO) work.

The underlying shell entrypoint remains available:

```bash
AWS_REGION=us-east-2 \
DOMAIN=genesys.example.com \
ROUTE53_ZONE_ID=Z0123456789EXAMPLE \
ACM_CERTIFICATE_ARN=arn:aws:acm:us-east-2:123456789012:certificate/00000000-0000-0000-0000-000000000000 \
OWNER_EMAIL=owner@example.com \
./deploy/aws/deploy.sh plan
```

`help` lists overrides and commands. `up` applies a reviewed plan, writes the
runtime environment to Secrets Manager, builds a `linux/amd64` image, uploads
an immutable S3 artifact and deploys through SSM. `update` updates the app only,
with confirmation. `status` and `bootstrap` use resource IDs from Terraform
outputs. The optional workflow `build-s3-image-artifact.yml` builds generic S3
artifacts through a user-configured GitHub OIDC role; it does not deploy them.

The application encryption key is retained on subsequent `up` runs. An
unreadable or malformed secret fails closed rather than replacing the key.
The VM composes `DATABASE_URL` from the separate database secret and verifies
RDS TLS with the public AWS CA bundle. Terraform write-only arguments keep the
DB password out of plan/state; other resource metadata remains in state.

Application volumes persist across container updates. Routine AMI/user-data
changes are ignored to avoid replacing the VM's local state. Explicit VM
replacement or destruction requires a backup of those volumes. An unhealthy
new application image triggers a container rollback when a previous image is
available; database migrations are not reversed.

An optional standard Portainer **agent**, disabled by default, can connect to
your own server. Supply `portainer_agent_enabled: true` and explicit
`portainer_server_cidrs` in the config. The stack installs no Portainer server
and prohibits public `0.0.0.0/0` access to the agent.

`destroy` reviews a Terraform destroy plan before applying it. RDS takes a
final snapshot unless `db_skip_final_snapshot` is explicitly enabled. An owned
nonempty artifact bucket must be archived/emptied before Terraform can delete
it. Keep the encryption key and database backup together.

## Optional internal FDE integration

Standard AWS remains the default. Enable FDE discovery/management tags with:

```bash
./deploy/deploy plan --target aws --fde
./deploy/deploy up --target aws --fde
# The shell entrypoint also supports --fde (alias: -fde).
./deploy/aws/deploy.sh up --fde
```

To retain the setting across infrastructure runs, add `"fde_enabled": true`
to your ignored `deploy/aws/config.json`. A command-line `--fde` overrides a
false config value for that invocation without rewriting the config file.
Without the flag or a persisted true setting, the next infrastructure apply
removes the FDE tags. `update`, `status` and `bootstrap` do not change tags.

See [internal FDE integration and public-sync exclusions](../../docs/INTERNAL_AWS_FDE_DEPLOYMENT.md).
