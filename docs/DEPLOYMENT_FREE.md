# Free-tier production deployment

This is the zero-cost-eligible alternative to [DEPLOYMENT_M12.md](DEPLOYMENT_M12.md),
which targets Railway (no longer free). It uses Google Cloud Run's free tier for
compute and free tiers of managed Neon/Upstash/Qdrant Cloud for state. The CI/CD
pipeline is `.github/workflows/deploy-free.yml`.

**Status:** the workflow and this guide are written and locally verified for
syntax/logic, but no external account has been provisioned from this workspace
and no deploy has run. Follow every phase below in order — later phases assume
earlier ones are done.

## Topology

| Component | Provider | Free tier | Public? |
| --- | --- | --- | --- |
| Frontend | Vercel | Yes, generous | Yes, HTTPS |
| API | Cloud Run | 2M requests/mo free | Yes, HTTPS |
| Indexing worker | Cloud Run **Job**, triggered by Cloud Scheduler every 2 min | Free tier covers light use | No public URL |
| Embedding service | Cloud Run | Free tier covers light use | Yes, HTTPS, but gated by its own bearer token (`EMBEDDING_SERVICE_TOKEN`) — see caveat below |
| PostgreSQL | Neon | 0.5GB storage free | TLS only |
| Redis | Upstash | 10K commands/day free | TLS only |
| Vectors | Qdrant Cloud | 1GB cluster free forever | TLS only |

**Caveat vs. the Railway plan:** DEPLOYMENT_M12.md kept the worker and embedding
service off the public internet entirely, using Railway's private networking.
Cloud Run doesn't have a no-cost equivalent (real network isolation needs a VPC
connector, which isn't free). Instead:

- The **worker** has no public URL at all — Cloud Run Jobs aren't HTTP services,
  so there's nothing to expose.
- The **embedding service** gets a public `*.run.app` URL, but every request
  still requires the same bearer token (`EMBEDDING_SERVICE_TOKEN`) it always
  checked locally. This is a real reduction from "unreachable" to "reachable but
  authenticated" — acceptable for a personal deployment, worth revisiting with a
  VPC connector if this ever needs a stronger boundary.

## Phase 0 — accounts you need

Create these (all free, most want a card on file even for the free tier):

1. Google Cloud account + a new project (billing account required to enable
   Cloud Run, but the free tier itself doesn't charge at this project's scale)
2. [Neon](https://neon.tech) — Postgres
3. [Upstash](https://upstash.com) — Redis
4. [Qdrant Cloud](https://cloud.qdrant.io) — vectors
5. [Vercel](https://vercel.com) — frontend
6. You already have the GitHub App and Google OAuth client from earlier this
   session — their callback URLs get updated in Phase 7 once real URLs exist.

## Phase 1 — provision the data stores

**Neon**: create a project. Copy two connection strings from the dashboard:
- The **pooled** connection string (has `-pooler` in the hostname) → this becomes
  `DATABASE_URL`.
- The **direct** connection string (no `-pooler`) → this becomes
  `MIGRATION_DATABASE_URL`. Migrations need a direct, non-pooled connection.

Both arrive as `postgresql://...`; the app needs `postgresql+asyncpg://...` —
change the scheme, keep everything else.

**Important:** Neon's copied string ends in `?sslmode=require`. The app's
production validator specifically checks for a query parameter named `ssl`,
not `sslmode` (this is deliberately tested — `sslmode=require` is a rejected
value in the test suite). Change it to `?ssl=require` or the API will refuse
to start with `DATABASE_URL must require TLS in production`.

**Upstash**: create a Redis database in a region close to wherever you set
`GCP_REGION` (e.g. `us-central1`). Copy the `rediss://` connection string
(TLS, required) → this becomes `REDIS_URL`.

**Qdrant Cloud**: create a free cluster. Copy the cluster URL (`QDRANT_URL`) and
generate an API key (`QDRANT_API_KEY`).

## Phase 2 — GCP project setup

Set these once, in your shell, for the rest of this phase:

```bash
export PROJECT_ID="your-gcp-project-id"
export REGION="us-central1"
export PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
```

Enable the APIs this needs:

```bash
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  cloudscheduler.googleapis.com \
  iamcredentials.googleapis.com \
  --project="$PROJECT_ID"
```

Create the Artifact Registry repo images get pushed to:

```bash
gcloud artifacts repositories create codenaut \
  --repository-format=docker \
  --location="$REGION" \
  --project="$PROJECT_ID"
```

Create one service account used both to deploy (from GitHub Actions) and to run
the services (so its Secret Manager grants cover both):

```bash
gcloud iam service-accounts create codenaut-deployer \
  --display-name="Codenaut CI deploy + runtime" \
  --project="$PROJECT_ID"

export SA_EMAIL="codenaut-deployer@${PROJECT_ID}.iam.gserviceaccount.com"

for role in roles/run.admin roles/artifactregistry.writer roles/iam.serviceAccountUser roles/secretmanager.secretAccessor roles/cloudscheduler.admin; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="$role"
done
```

Set up Workload Identity Federation so GitHub Actions can deploy without a
long-lived JSON key:

```bash
gcloud iam workload-identity-pools create "github-pool" \
  --project="$PROJECT_ID" --location="global" \
  --display-name="GitHub Actions"

gcloud iam workload-identity-pools providers create-oidc "github-provider" \
  --project="$PROJECT_ID" --location="global" \
  --workload-identity-pool="github-pool" \
  --display-name="GitHub" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --issuer-uri="https://token.actions.githubusercontent.com"

# Replace OWNER/REPO with your actual GitHub owner/repo, e.g. codelikeharsh/CodeNaut
gcloud iam service-accounts add-iam-policy-binding "$SA_EMAIL" \
  --project="$PROJECT_ID" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github-pool/attribute.repository/OWNER/REPO"
```

Create a second, narrowly-scoped service account just for Cloud Scheduler to
invoke the worker job:

```bash
gcloud iam service-accounts create codenaut-scheduler \
  --display-name="Codenaut Cloud Scheduler" \
  --project="$PROJECT_ID"

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:codenaut-scheduler@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/run.invoker"
```

Note the workload identity provider's full resource name — you'll need it in
Phase 4:

```bash
gcloud iam workload-identity-pools providers describe "github-provider" \
  --project="$PROJECT_ID" --location="global" \
  --workload-identity-pool="github-pool" \
  --format="value(name)"
```

## Phase 3 — populate Secret Manager

Every secret below is created once; `deploy-free.yml` references them by name
with `:latest`. Generate random secrets with `openssl rand -hex 32`.

```bash
# Data stores (from Phase 1)
printf '%s' 'postgresql+asyncpg://...-pooler.../neondb?ssl=require' | gcloud secrets create database-url --data-file=- --project="$PROJECT_ID"
printf '%s' 'rediss://default:...@....upstash.io:6379' | gcloud secrets create redis-url --data-file=- --project="$PROJECT_ID"
printf '%s' 'https://your-cluster.qdrant.io:6333' | gcloud secrets create qdrant-url --data-file=- --project="$PROJECT_ID"
printf '%s' 'your-qdrant-api-key' | gcloud secrets create qdrant-api-key --data-file=- --project="$PROJECT_ID"

# GitHub App (same values you already have in your local .env)
printf '%s' '4391092' | gcloud secrets create github-app-id --data-file=- --project="$PROJECT_ID"
gcloud secrets create github-app-private-key --data-file=/path/to/your-private-key.pem --project="$PROJECT_ID"
printf '%s' 'your-github-client-id' | gcloud secrets create github-client-id --data-file=- --project="$PROJECT_ID"
printf '%s' 'your-github-client-secret' | gcloud secrets create github-client-secret --data-file=- --project="$PROJECT_ID"
printf '%s' 'your-github-webhook-secret' | gcloud secrets create github-webhook-secret --data-file=- --project="$PROJECT_ID"

# Google OAuth
printf '%s' 'your-google-client-id' | gcloud secrets create google-client-id --data-file=- --project="$PROJECT_ID"
printf '%s' 'your-google-client-secret' | gcloud secrets create google-client-secret --data-file=- --project="$PROJECT_ID"

# App-generated secrets — new random values, do not reuse local dev ones
openssl rand -hex 32 | gcloud secrets create access-token-secret --data-file=- --project="$PROJECT_ID"
openssl rand -hex 32 | gcloud secrets create token-hash-secret --data-file=- --project="$PROJECT_ID"
openssl rand -hex 32 | gcloud secrets create embedding-service-token --data-file=- --project="$PROJECT_ID"

# LLM (Groq, per your current setup)
printf '%s' 'https://api.groq.com/openai/v1' | gcloud secrets create llm-api-url --data-file=- --project="$PROJECT_ID"
printf '%s' 'your-groq-api-key' | gcloud secrets create llm-api-key --data-file=- --project="$PROJECT_ID"

# Placeholder — you'll overwrite this in Phase 6 once the embedding service has a real URL
printf '%s' 'https://placeholder.invalid' | gcloud secrets create embedding-service-url --data-file=- --project="$PROJECT_ID"
```

Grant the deploy/runtime service account access to every secret:

```bash
for s in database-url redis-url qdrant-url qdrant-api-key github-app-id \
  github-app-private-key github-client-id github-client-secret github-webhook-secret \
  google-client-id google-client-secret access-token-secret token-hash-secret \
  embedding-service-token llm-api-url llm-api-key embedding-service-url; do
  gcloud secrets add-iam-policy-binding "$s" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="roles/secretmanager.secretAccessor" \
    --project="$PROJECT_ID"
done
```

## Phase 4 — GitHub repository configuration

In **Settings → Environments**, create an environment named `production`
(optionally with required reviewers — recommended, since this triggers real
deploys).

In **Settings → Secrets and variables → Actions**, add:

**Variables** (repository-level or inside the `production` environment):
| Name | Value |
| --- | --- |
| `GCP_PROJECT_ID` | your GCP project ID |
| `GCP_REGION` | `us-central1` (or your chosen region) |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | the full resource name from Phase 2's last command |
| `GCP_DEPLOY_SERVICE_ACCOUNT` | `codenaut-deployer@<project>.iam.gserviceaccount.com` |
| `GCP_SCHEDULER_SERVICE_ACCOUNT` | `codenaut-scheduler@<project>.iam.gserviceaccount.com` |
| `LLM_MODEL` | `llama-3.3-70b-versatile` (or whichever Groq model you're using) |
| `PRODUCTION_API_ORIGIN` | filled in after Phase 6's first deploy |
| `PRODUCTION_FRONTEND_ORIGIN` | filled in after Phase 5 |
| `PRODUCTION_API_HOST` | the API origin's hostname only, no scheme |

**Secrets** (inside the `production` environment):
| Name | Value |
| --- | --- |
| `MIGRATION_DATABASE_URL` | Neon's **direct** (non-pooled) connection string, `postgresql+asyncpg://...` |
| `VERCEL_TOKEN` | a personal token from Vercel account settings |
| `VERCEL_ORG_ID` | from Phase 5 |
| `VERCEL_PROJECT_ID` | from Phase 5 |

## Phase 5 — Vercel project

From the `frontend/` directory on your machine:

```bash
cd frontend
npx vercel@56.4.1 link
```

This creates the Vercel project and writes `.vercel/project.json` locally,
which contains the `orgId` and `projectId` you need for the GitHub secrets
above. Do **not** commit `.vercel/`.

Note the project's default `*.vercel.app` URL (or attach a custom domain now if
you have one) — that's `PRODUCTION_FRONTEND_ORIGIN`.

## Phase 6 — first deploy

1. Push your current `main` and let `ci.yml` run green.
2. Set `PRODUCTION_API_ORIGIN` to a placeholder for now — Cloud Run only assigns
   the real URL on first deploy, so this is a chicken-and-egg step. Simplest
   path: trigger the workflow once, let `deploy-api` fail or use a throwaway
   origin, note the real Cloud Run URL from the job output, then fix the
   variable and re-run.
3. From **Actions → Deploy free tier (Cloud Run + Vercel) → Run workflow**,
   enter the exact 40-character SHA of the `main` commit that passed CI.
4. Watch it run: `validate-release` → `migrate` → `build-images` →
   `deploy-embedding` / `deploy-worker-job` → `deploy-api` → `deploy-frontend`
   → `smoke`.
5. Once `deploy-embedding` finishes, copy its printed URL and update the
   `embedding-service-url` secret for real:
   ```bash
   printf '%s' 'https://embedding-service-xxxxx-uc.a.run.app' | \
     gcloud secrets versions add embedding-service-url --data-file=- --project="$PROJECT_ID"
   ```
   Then re-run `deploy-worker-job` and `deploy-api` (or just re-run the whole
   workflow) so they pick up the real value.
6. Once `deploy-api` finishes, copy its printed URL into the
   `PRODUCTION_API_ORIGIN` GitHub variable and `PRODUCTION_API_HOST` (hostname
   only). Re-run the workflow once more end-to-end so the frontend build and
   `smoke` step use the real origin.

## Phase 7 — point GitHub App and Google OAuth at the real URLs

Now that you have real `https://*.run.app` and `https://*.vercel.app` origins:

- **GitHub App settings**: update the callback URL to
  `https://<api-origin>/api/v1/auth/github/callback` and the webhook URL to
  `https://<api-origin>/api/v1/webhooks/github`.
- **Google Cloud Console → OAuth client**: add
  `https://<api-origin>/api/v1/auth/google/callback` as an authorized redirect
  URI.

## Phase 8 — verify

The `smoke` job already checks HTTPS headers, CORS, and webhook signature
rejection automatically on every deploy. After that passes, do the two things
no smoke test can: sign in for real with GitHub and Google, and index one real
repository end to end.

## Ongoing cost watch

Free tier limits worth knowing before they surprise you:
- Cloud Run: 2M requests, 360K GB-seconds, 180K vCPU-seconds per month, free.
- Neon free tier: 0.5GB storage, project auto-suspends after 5 minutes idle
  (adds a cold-start delay to the first request after inactivity — expected,
  not a bug).
- Upstash free tier: 10K commands/day.
- Qdrant Cloud free tier: 1GB cluster, forever.

If any of these get tight, the embedding service is the one most likely to need
a small paid bump first — it's the heaviest compute in this stack.
