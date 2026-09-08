# Deploy Genesys Integrations

Use `./deploy/deploy` (or `npm run deploy`) to choose **local, AWS, Azure or Google
Cloud**. The CLI follows the Contact Center deployment pattern: select a target,
collect infrastructure inputs, review a Terraform plan, deploy the container,
then run the Genesys/Telnyx installer. Cloud deployments are single-node; they
are not highly available.

## Targets

| Target | Application | Database | Secrets / artifacts | Administration | HTTPS |
|---|---|---|---|---|---|
| Local | Docker Compose | Bundled PostgreSQL 17 or external database | Private env file / local image | Docker Compose | Your reverse proxy or tunnel |
| AWS | EC2 Ubuntu 24.04 | Private RDS PostgreSQL 17 | Secrets Manager / S3 | AWS SSM, no SSH | ALB + existing ACM certificate + Route53 |
| Azure | Ubuntu 24.04 VM | Private PostgreSQL Flexible Server 17 | Key Vault / private Blob Storage | VM Run Command; restricted SSH for interactive installer | Caddy + your DNS A record |
| GCP | Compute Engine Ubuntu 24.04 | Private Cloud SQL PostgreSQL 17 | Secret Manager / private GCS | IAP SSH with OS Login | Caddy + your DNS A record |

All HTTP, SSE and Audio Connector WebSocket traffic reaches the application's
port 3000. Azure/GCP publish only Caddy's ports 80/443; port 3000 is bound to the
VM loopback interface. Caddy flushes streamed responses immediately. No
additional public WebSocket port is needed.

## Prerequisites

Install Node.js 22, enable Corepack and install the application dependencies:

```bash
corepack enable
yarn install --immutable
```

Cloud targets also require Terraform >= 1.11, Docker with `linux/amd64` build
support, `zstd`, `tar`, and authenticated cloud CLI tools. Local deployments
require Docker Compose v2. Azure/GCP VMs install Docker Compose >= 2.30 (needed
for raw secret env files) from Docker's Ubuntu repository.

Authenticate to your own cloud account:

- **AWS:** standard AWS credential chain, for example an AWS CLI SSO profile.
  Set `AWS_PROFILE` only if using a named profile. Install the Session Manager
  plugin for `bootstrap`. The operator needs permissions to manage the VPC,
  EC2/IAM, RDS, ALB, Route53, Secrets Manager and S3 resources in the Terraform
  root, upload artifacts and invoke SSM. Supply an existing public Route53 zone
  and an issued ACM certificate covering your hostname in the chosen region.
- **Azure:** `az login`; use a subscription where you can create the resource
  group, VM/network, PostgreSQL, Storage and Key Vault resources and role
  assignments. Terraform uses the Azure CLI session or standard `ARM_*`
  credentials. Use the same principal for Terraform and the CLI: the stack
  grants that principal artifact-write and Key Vault secret permissions.
  Supply an SSH **public** key and a restricted public IPv4 CIDR (/24 to /32)
  for interactive bootstrap. Private keys remain on your computer.
- **GCP:** `gcloud auth login` and `gcloud auth application-default login` for
  Terraform. Both identities must have access to the same project. The project
  must have billing enabled. Provisioning needs Compute, Cloud SQL, Service
  Networking, Secret Manager, Storage, service-account/IAM and API-enablement
  permissions. The deployment operator also needs artifact upload and secret
  read/write permissions, `roles/iap.tunnelResourceAccessor`,
  `roles/compute.osAdminLogin` and permission to act as the VM service account
  (`roles/iam.serviceAccountUser`). These operator roles are not granted by the
  stack. The VM gets only its own secret/artifact access and Cloud SQL access.


Cloud provider credentials, Genesys OAuth credentials and Telnyx API keys do
not belong in deployment JSON or Terraform variables.

## First deployment

Start the wizard:

```bash
./deploy/deploy up
```

Or select the provider explicitly:

```bash
./deploy/deploy up --target azure
./deploy/deploy up --target gcp
./deploy/deploy up --target aws
```

Both `up` and `plan` collect all required infrastructure inputs in a terminal;
no file needs to be prepared. The dialogue asks for the deployment name, hostname,
region, VM and database size, plus provider-specific parameters. Azure lists the
signed-in account's subscriptions, checks quota for suggested VM sizes, and asks
for the SSH CIDR and public-key file (including `~/` paths). Quota checks do not
guarantee live capacity or SKU availability. GCP suggests the active CLI project.
AWS asks for the existing Route53 zone, issued ACM certificate and owner email.

Answers are saved automatically to `deploy/<target>/config.json` (ignored by Git,
permissions 0600). On subsequent interactive runs choose **Reuse** or **Edit**;
`--configure` opens the editor directly. Provider credentials stay in the provider
credential chain. Genesys and Telnyx credentials are collected by `bootstrap`.

```bash
npm run deploy -- plan --target azure
npm run deploy -- up --target azure
npm run deploy -- plan --target azure --configure
```

For unattended runs, the optional `--config /absolute/path/config.json` accepts
inputs following `config.example.json`. `--yes` requires prepared configuration
and skips the dialogue. One
Terraform state per target is supported in this checkout; a different config
file does not create an isolated deployment. Use a separate checkout/backend
for another environment. Terraform root-local `*.tfvars` files take precedence
over CLI config inputs supplied as `TF_VAR_*`; avoid mixing those methods.

`plan` refreshes infrastructure and writes a local plan but does not apply it.
`up` shows that plan and asks for confirmation before applying it. `--yes`
accepts this decision for unattended runs. `--dry-run` performs no cloud or
Docker calls and does not write files; supply an existing valid cloud config.

Azure/GCP `up` builds the image, uploads a release to private storage, verifies
its SHA-256 on the VM and starts the app. The VM reads secrets using its native
identity. If DNS is managed externally, set your public **DNS A record** to the IP printed at completion and
remove conflicting AAAA records. Caddy obtains and renews the certificate once
DNS resolves and inbound ports 80/443 are reachable. AWS creates its Route53
alias to the ALB automatically. For Azure, the wizard discovers matching public Azure DNS zones in the selected
subscription. Selecting a zone lets Terraform create the A record automatically.
Choose external DNS when using another provider; GCP DNS remains manual.

Confirm public HTTPS before installing provider integrations:

```bash
./deploy/deploy status --target azure
./deploy/deploy bootstrap --target azure
```

`bootstrap` opens the interactive Genesys/Telnyx installer. Azure uses SSH
(`--ssh-key /path/to/key` is optional when your SSH agent already has the key),
AWS uses a Session Manager terminal, and GCP uses IAP SSH. Normal SSH host-key
verification remains enabled. After bootstrap, open **Apps > Telnyx
Integrations** in Genesys Cloud. No phone numbers are bought or assigned by
these infrastructure scripts.

The cloud `up` command reports **VM application health**, not successful DNS or
certificate issuance. `status` checks public HTTPS and fails if it is not ready.

## Lifecycle

```bash
./deploy/deploy plan --target gcp       # Infrastructure plan only
./deploy/deploy up --target gcp         # Infrastructure + app deployment
./deploy/deploy update --target gcp     # Current working tree; no Terraform apply
./deploy/deploy status --target gcp     # Provider state + public HTTPS health
./deploy/deploy bootstrap --target gcp  # Interactive Genesys/Telnyx setup
./deploy/deploy destroy --target gcp    # Review destroy plan and confirm
```

`update`, `status` and `bootstrap` obtain resource identifiers from Terraform
outputs. Azure/GCP updates preserve the runtime encryption key and refuse to
replace a missing or unreadable key. If initial infrastructure creation completed
but secret initialization failed, explicitly initialize `app-env` in the cloud
secret manager before retrying: use a new base64-encoded 32-byte key only for a
new, empty application database. For an existing installation, restore its key
from backup. The CLI never infers that an existing database is empty. Failed application startup or health
checks trigger a return to the previous release when available. This rollback
changes containers only: database migrations are not reversed. Test schema
compatibility before updating production.

Azure/GCP release helpers live under `/opt/genesys-integrations/releases` and
`current` points to the healthy release. Docker volumes preserve installer
state and widget assets across container updates. Certificates also use named
volumes. VM/disk deletion destroys those local volumes: back them up separately
from the managed database. Do not manually prune images needed for rollback.
The VM checks disk headroom before downloading a release and refuses to
proceed when space is insufficient. Monitor disk usage and archive/remove old
releases during maintenance.

For local operations, use existing options:

```bash
./deploy/deploy up --target local
./deploy/deploy up --target local --mode external --env-file .env --skip-genesys
./deploy/deploy plan --target local --env-file .env
./deploy/deploy update --target local
./deploy/deploy destroy --target local  # Stops Compose; retains named volumes
```

Local `--remove-volumes` with `destroy`/`--down` deletes **all** Compose named
volumes, including database, installer state and widget assets. See
[container deployment](../docs/DEPLOYMENT.md) for the full local workflow.


Local `up` asks whether to use bundled or external PostgreSQL. Missing external
connection details and TLS mode are collected in the terminal; the connection
URL is masked and stored in the protected env file. No manual env-file creation
is needed. Existing values are reused. CLI flags remain available for automation.

## Secrets, transport and state

The database and `ADMIN_SECRETS_MASTER_KEY` are backed up as a pair. Losing the
key makes encrypted Genesys/Telnyx configuration unreadable. Secrets never enter
image build contexts, release archives, VM user-data or printed command lines.
The application env is rendered atomically as a root-readable file on Azure/GCP.

- AWS verifies RDS TLS with the AWS trust bundle. Its DB password uses Terraform
  write-only arguments and its application key is stored outside state.
- Azure uses `PGSSLMODE=verify-full` with the runtime's trusted roots against the
  private PostgreSQL hostname.
- GCP connects through the Cloud SQL Auth Proxy on a private Docker network.
  The local app-to-proxy hop has no TLS; the proxy uses IAM and verified TLS
  over the private VPC connection to Cloud SQL. No database port is published.

**Azure/GCP database passwords are sensitive values in Terraform state/plan.**
Their application encryption keys are created outside Terraform and placed in
Key Vault / Secret Manager. Use a protected, encrypted remote backend with
locking for team use; restrict access to local state and plan files as well.
All three roots include provider lock files for reproducible installation.

## Teardown

Back up the managed database, encryption key and VM volumes before teardown.
Azure database deletion has no automatic final export in this script; create
and verify your backup first. AWS requests a final RDS snapshot by default.
GCP has deletion protection enabled: after backing up, set
`db_deletion_protection` to `false`, review/apply that Terraform change, and then
run `destroy`. Azure Key Vault remains soft-deleted and purge-protected for its
retention period.

Deployment-owned artifact buckets are deliberately not force-deleted. If a
bucket is nonempty, destroy stops with the provider's error; review/archive and
empty that deployment's artifacts before retrying. An explicitly supplied
existing AWS bucket is not owned or deleted by Terraform. Azure destroys the
storage account and its artifacts with the resource group.

## Repository layout

- `deploy/cli.mjs`, `deploy/deploy`: target selection and lifecycle routing.
- `scripts/deploy.mjs`, `compose.yaml`: existing local deployment.
- `deploy/aws/`: AWS lifecycle scripts and Terraform root.
- `deploy/azure/terraform/`, `deploy/gcp/terraform/`: new cloud roots.
- `deploy/lib/cloud.mjs`: artifact packaging, provider commands and validation.
- `deploy/runtime/`: VM bootstrap, identity-based secret/artifact access,
  Compose runtime, reverse proxy and rollback.

Runtime inputs, plans/state, generated reports and temporary files are excluded
from Git and Docker contexts. Before a public release, review tracked files and
Git history separately: ignore rules do not remove previously committed data.

## Validation without provisioning

```bash
terraform fmt -check -recursive deploy
terraform -chdir=deploy/azure/terraform init -backend=false
terraform -chdir=deploy/azure/terraform validate
terraform -chdir=deploy/gcp/terraform init -backend=false
terraform -chdir=deploy/gcp/terraform validate
```

Validation checks configuration syntax. It does not establish account permissions,
quotas, region capacity or working public DNS. Verify those with a reviewed plan
and a first deployment in your own account.

Provider references: [Azure VM Run Command](https://learn.microsoft.com/en-us/azure/virtual-machines/linux/run-command),
[Cloud SQL Auth Proxy](https://docs.cloud.google.com/sql/docs/postgres/connect-auth-proxy),
[Cloud SQL IAM conditions](https://docs.cloud.google.com/sql/docs/postgres/iam-conditions),
and [Docker Compose raw env files](https://docs.docker.com/compose/how-tos/environment-variables/set-environment-variables/).

### Azure DNS ownership

The optional `dns_zone_name` and `dns_zone_resource_group` inputs select an
existing public Azure DNS zone in the deployment subscription. The operator
needs permission to manage records in that zone. Terraform creates only the
application A record (TTL 300), including `@` for a zone-apex hostname; it does
not create or delete the zone. Ensure the zone is delegated by your registrar.
Destroy removes the managed application record along with the deployment.
Conflicting CNAME/AAAA records must be resolved before enabling this option.

For an existing record, review its address and import it before applying:

```bash
# Supply the saved configuration as TF_VAR_* inputs, as the CLI does.
terraform -chdir=deploy/azure/terraform import 'azurerm_dns_a_record.app[0]' \
  /subscriptions/SUBSCRIPTION/resourceGroups/DNS_RG/providers/Microsoft.Network/dnsZones/ZONE/A/RECORD
```

Terraform does not silently take over an existing unmanaged record. Selecting
external DNS later plans deletion of the previously managed record; review the
plan before changing ownership. Application container health alone does not
establish public HTTPS readiness; verify with `npm run deploy -- status --target azure` after DNS propagates.
