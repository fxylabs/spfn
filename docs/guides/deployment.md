---
title: "Deployment"
description: "Deploy a Superfunction application to Vercel or to an always-on container"
order: 4
available: true
---

# Deployment

There are two targets, and both ship from the same repository.

| | Vercel (serverless) | Always-on (container or process) |
|---|---|---|
| Setup | `spfn add vercel` | `spfn build && spfn start`, or the generated Docker files |
| Where the backend runs | Vercel Functions on the same origin as the frontend | a long-lived process you host |
| Background jobs | **not processed** — enqueuing works, nothing drains the queue | in-process worker runs |
| WebSocket events | no | yes |
| Periodic DB health check | off | on |

Pick Vercel when the product is request/response and you want no infrastructure to
operate. Pick always-on when background jobs, WebSockets, or the health check matter.
Nothing stops you from running both: the same application, deployed twice, with jobs on
the always-on side.

## Vercel

```bash
spfn add vercel
```

That scaffolds `src/app/api/backend/[[...route]]/route.ts` (a `hono/vercel` adapter),
`vercel.json`, and an `.npmrc` naming the registry the `@spfn` scope resolves to. The SPFN app
mounts under `/api/backend`, so frontend and backend share one origin — set `SPFN_API_URL` to
`https://<your-domain>/api/backend`.

Set two environment variables on the Vercel project: `GITEA_NPM_TOKEN` with the registry token,
and `NPM_RC` with the block `spfn add vercel` prints. The token cannot live in the project
`.npmrc`: pnpm 10 and later refuse to expand an environment variable in a credential that came
from a committed file, drop the line with a warning, and the install then fails as unauthorized.
`NPM_RC` becomes the build container's user-level `~/.npmrc`, which pnpm does still expand.

Three things to know:

- It runs on the **Node runtime, not edge**, because SPFN needs `pg` and native `bcrypt`.
- `hono` must be a direct dependency of the app, so `hono/vercel` resolves.
- Seed and RBAC provisioning move to a deploy-time step (`provisionInfrastructure`) rather
  than running per cold start, and the job worker does not run at all. If your app enqueues
  jobs, drain them from a scheduled endpoint (Vercel Cron calling a route that processes a
  batch) or run an always-on deployment alongside.

If you use the Vercel Supabase integration, the adapter maps the injected `POSTGRES_URL`
onto `DATABASE_URL` for you.

Deploying on the free tiers (Vercel Hobby + Supabase Free)? `spfn cloud` manages
them: `cloud status` shows usage against the plan limits, `cloud keepalive` stops
the Supabase project from pausing when idle, and `cloud env pull`/`push` move keys
between the providers and your local env without printing a value. See
[CLI → spfn cloud](/docs/packages/cli#spfn-cloud).

The rest of this guide covers the **always-on** path.

## Prerequisites

Minimum versions the framework requires:

| | Minimum | Note |
|---|---|---|
| Node.js | 20+ | `@spfn/core` runs on `@hono/node-server` 2, which requires it |
| PostgreSQL | 14+ | required; not optional |
| Redis | — | optional, only for features that use it |

The bundled files pin newer versions than the minimum on purpose: the generated Dockerfile
builds on `node:22-alpine` and the compose file runs `postgres:16-alpine` and Redis 7. Those
are what SPFN tests against, not a floor you have to meet.

For the always-on path you also need Docker and Docker Compose, unless you run
`spfn build && spfn start` directly on a host.

## Docker Compose Setup

Superfunction provides a pre-configured `docker-compose.yml` for running PostgreSQL and Redis. Redis is optional and can be removed if you don't need caching or session storage:

```yaml
# docker-compose.yml
version: '3.8'

services:
  # PostgreSQL
  postgres:
    image: postgres:16-alpine
    container_name: spfn-postgres
    environment:
      POSTGRES_USER: spfn
      POSTGRES_PASSWORD: spfn
      POSTGRES_DB: spfn_dev
    ports:
      - '5432:5432'
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U spfn -d spfn_dev']
      interval: 5s
      timeout: 5s
      retries: 5

  # Redis
  redis:
    image: redis:7-alpine
    container_name: spfn-redis
    ports:
      - "6379:6379"
    command: redis-server --appendonly yes
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 2s
      timeout: 3s
      retries: 5

volumes:
  postgres_data:
  redis_data:

networks:
  default:
    name: spfn-network
```

### Starting Services

```bash
# Start PostgreSQL and Redis
docker-compose up -d

# Check service status
docker-compose ps

# View logs
docker-compose logs -f

# Stop services
docker-compose down
```

## Application Dockerfile

Superfunction provides a production-ready Dockerfile optimized for both Next.js and API server:

```dockerfile
# Production Dockerfile for Superfunction
FROM node:22-alpine

WORKDIR /app

# Install pnpm
RUN corepack enable pnpm

# Copy dependency files
COPY package.json pnpm-lock.yaml* ./

# Install dependencies
RUN pnpm install --frozen-lockfile --prod=false

# Copy source code
COPY . .

# Build application
RUN pnpm run spfn:build

# Remove dev dependencies (optional, reduces image size)
RUN pnpm prune --prod

# Environment
ENV NODE_ENV=production

# Expose ports (3790 for Next.js, 8790 for API)
EXPOSE 3790 8790

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8790/_core/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start application
CMD ["pnpm", "run", "spfn:start"]
```

> **Note:** Key Features
> - **Alpine-based**: Minimal image size (~150MB)
> - **Layer caching**: Dependencies cached separately from source code
> - **Production pruning**: Dev dependencies removed after build
> - **Health checks**: Built-in readiness probes
> - **Dual ports**: Exposes both Next.js (3790) and API (8790)

## Environment Configuration

Create separate environment files for different stages:

### Development (.env.local)

```bash
# Database
DATABASE_URL="postgresql://spfn:spfn@localhost:5432/spfn_dev"

# Redis (Optional - remove if not needed)
REDIS_URL="redis://localhost:6379"

# API
NEXT_PUBLIC_API_URL="http://localhost:8790"
APP_PORT=3790
API_PORT=8790

# Next.js
NODE_ENV=development
```

### Production (.env.production)

```bash
# Database (use production credentials)
DATABASE_URL="postgresql://user:password@postgres-host:5432/spfn_prod"

# Redis (Optional - remove if not needed)
REDIS_URL="redis://redis-host:6379"

# API
NEXT_PUBLIC_API_URL="https://api.yourdomain.com"
APP_PORT=3790
API_PORT=8790

# Next.js
NODE_ENV=production

# Proxy → backend trust (see "Client IP behind a proxy" below).
# Set the SAME value on the Next.js app and the API backend.
SPFN_PROXY_SECRET=your-shared-proxy-secret
# Number of trusted proxies in front (LB + nginx = 2). Default 1.
TRUSTED_PROXY_HOPS=1

# Optional: Monitoring
SENTRY_DSN=your-sentry-dsn
LOG_LEVEL=info
```

> **⚠️ Warning:** Security Warning
>
> Never commit `.env.production` to version control. Use environment variable injection in your CI/CD pipeline or secrets management system.

For a managed workflow, `spfn secret` stores deployed secrets in encrypted SOPS files
(`secrets/<env>.enc.json`, backend chosen by `.sops.yaml` — age / GCP KMS / AWS KMS)
that are safe to commit; your GitOps step decrypts them into env at deploy time. Local
secrets go to the OS keychain instead. See [CLI → spfn secret](/docs/packages/cli#spfn-secret).

### Assembling an instance's env file

When one environment runs several instances (`staging` as `blue` and `green`), each
instance's values come from three layers. The schema's `layer` field pins which layer a
variable must come from; unset, it may come from any layer — a per-instance session
secret can live in each instance's file while a shared key lives in the environment's:

| Layer | Holds | File |
|-------|-------|------|
| environment | Secrets every instance shares (third-party keys) | `secrets/<env>.enc.json` |
| instance secrets | Secrets of one instance | `secrets/<env>.<instance>.enc.json` (optional) |
| instance computed | Plain values the deploy script computes (port, URLs, database name) | a plaintext dotenv file passed with `--with` |

The deploy step writes the computed values, then exports the merged file:

```bash
printf 'PORT=4100\nDB_NAME=api_blue\nAPP_URL=https://blue.staging.example.com\n' > computed.env
spfn secret export --env staging --instance blue --with computed.env --out /run/api/blue.env
```

`export` decrypts with whatever `.sops.yaml` configures, writes only names in the
whole-app env list, and creates `--out` with mode 0600 through a temp file and a rename —
a failed export leaves the previous file in place. It fails without writing when a
required name is missing, a name is in two layers, a name is outside its declared layer, or a value
fails its validator; errors name the variable and never print its value. The terminal
shows only names and the layer each came from. Mode 0600 is not enforced on Windows.

## Building for Production

### Local Build

```bash
# Build Docker image
docker build -t spfn-app:latest \
  --build-arg CI_BOT_TOKEN=${CI_BOT_TOKEN} \
  --build-arg APP_PORT=3790 \
  .

# Run container
docker run -d \
  --name spfn-app \
  --network spfn-network \
  -p 3790:3790 \
  -e DATABASE_URL="postgresql://spfn:spfn@spfn-postgres:5432/spfn_dev" \
  -e REDIS_URL="redis://spfn-redis:6379" \
  spfn-app:latest

# Check logs
docker logs -f spfn-app
```

### With Docker Compose

Create a `docker-compose.production.yml` that includes your application:

```yaml
version: '3.8'

services:
  postgres:
    image: postgres:16-alpine
    container_name: spfn-postgres
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-spfn}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-spfn}
      POSTGRES_DB: ${POSTGRES_DB:-spfn_prod}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U ${POSTGRES_USER:-spfn}']
      interval: 5s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    container_name: spfn-redis
    command: redis-server --appendonly yes
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 2s
      timeout: 3s
      retries: 5

  app:
    build:
      context: .
      dockerfile: Dockerfile
      args:
        CI_BOT_TOKEN: ${CI_BOT_TOKEN}
        APP_PORT: 3790
    container_name: spfn-app
    ports:
      - "3790:3790"
    environment:
      DATABASE_URL: postgresql://${POSTGRES_USER:-spfn}:${POSTGRES_PASSWORD:-spfn}@postgres:5432/${POSTGRES_DB:-spfn_prod}
      REDIS_URL: redis://redis:6379
      NODE_ENV: production
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    restart: unless-stopped

volumes:
  postgres_data:
  redis_data:

networks:
  default:
    name: spfn-network
```

```bash
# Build and start all services
docker-compose -f docker-compose.production.yml up -d --build

# View logs
docker-compose -f docker-compose.production.yml logs -f app

# Stop all services
docker-compose -f docker-compose.production.yml down
```

## Database Migrations

Superfunction provides CLI commands for managing database migrations:

```bash
# Generate migration from schema changes
npx spfn db generate

# Apply migrations to database
npx spfn db migrate

# Development workflow
npx spfn db generate  # Create migration file
npx spfn db migrate   # Apply to local database

# Production: Run migrations inside container
docker exec spfn-app npx spfn db migrate

# Or run migrations as a separate container
docker run --rm \
  --network spfn-network \
  -e DATABASE_URL="postgresql://spfn:spfn@spfn-postgres:5432/spfn_prod" \
  spfn-app:latest \
  npx spfn db migrate
```

### Migrations gate the boot

A server whose database is behind the code it serves does not fail at startup — it fails
on the first request that touches a missing column, as an opaque 500. So it refuses to
start instead. `spfn start` (and `startServer()` directly) compares the migrations each
installed function package ships against what the database records as applied, prints the
ones still waiting, and exits.

A deploy that stops here is one that never served the errors. Put the migration step
before the container starts, not after it.

The escape hatch is an environment variable, because a container cannot be handed a CLI
flag:

```bash
SPFN_ALLOW_PENDING_MIGRATIONS=true    # start anyway; the pending list is logged as a warning
```

The check is skipped entirely when the app initializes no database or no package ships
migrations, and a database that cannot be reached is reported as "could not verify" —
never as drift.

## CI/CD Pipeline Example

Example GitHub Actions workflow for automated deployment:

```yaml
name: Deploy to Production

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Login to Container Registry
        uses: docker/login-action@v3
        with:
          registry: your-registry.com
          username: ${{ secrets.REGISTRY_USERNAME }}
          password: ${{ secrets.REGISTRY_PASSWORD }}

      - name: Build and push
        uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          tags: your-registry.com/spfn-app:latest
          build-args: |
            CI_BOT_TOKEN=${{ secrets.CI_BOT_TOKEN }}
          cache-from: type=registry,ref=your-registry.com/spfn-app:buildcache
          cache-to: type=registry,ref=your-registry.com/spfn-app:buildcache,mode=max

      - name: Deploy to server
        uses: appleboy/ssh-action@v1.0.0
        with:
          host: ${{ secrets.SERVER_HOST }}
          username: ${{ secrets.SERVER_USER }}
          key: ${{ secrets.SERVER_SSH_KEY }}
          script: |
            cd /opt/spfn-app
            docker-compose pull
            docker-compose up -d
            docker-compose exec -T app npx spfn db migrate
```

## Production Considerations

### 1. Resource Limits

Set appropriate resource limits in your docker-compose file:

```yaml
services:
  app:
    # ... other config
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 2G
        reservations:
          cpus: '1'
          memory: 1G
```

### 2. Health Checks

Add health checks to ensure services are ready:

```yaml
services:
  app:
    # ... other config
    healthcheck:
      test: ["CMD", "wget", "--quiet", "--tries=1", "--spider", "http://localhost:8790/_core/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s
```

Port 8790 is the SPFN server, not 3790. This example used to probe
`http://localhost:3790/api/health` — a Next.js path that no example or scaffold ever
creates, so the container would have stayed unhealthy forever. The frontend's readiness is
not what a probe wants to know either: the SPFN server is what holds the database and
cache connections that health reports on.

### Which health path a probe should use

Point new manifests at **`/_core/health`**. That path belongs to `@spfn/core`, is
registered before your app's routes, and cannot be claimed by a route you declare — so
what answers it never depends on what your app happens to define.

**`/health` is gone**, and this is a breaking change — a deployment probing it must move.
`@spfn/core` registers nothing there any more:

| Your app | `GET /health` answered by | `GET /_core/health` |
|---|---|---|
| declares no `GET /health` | **410**, naming `/_core/health` | the built-in endpoint |
| declares `GET /health` | your route, like any other | the built-in endpoint |
| set `healthCheck.path: '/health'` | the built-in endpoint | the built-in endpoint |
| set `healthCheck.enabled: false` | nothing (404) | nothing (404) |

Two ways to migrate, and the first is the one to prefer:

1. **Move the probe** to `/_core/health` — in the `readinessProbe.httpGet.path` of your
   manifest, the `HEALTHCHECK` of your Dockerfile, and your load balancer's target group.
   No path an app declares can take it, so it stays true through every later release.
2. **Restore the old address** with `.healthCheck({ path: '/health' })` when the probe path
   is frozen somewhere you cannot reach. The built-in then answers on both.

The 410 is a signpost for one release and is removed after that. It carries the new
address in its body and the server logs a warning the first time it is hit, because a
readiness probe failure surfaces neither to an operator — a Kubernetes event says the
probe failed and stops there.

`healthCheck.path` adds an address; it never moves `/_core/health`.

When detailed health is enabled, the SPFN server's health response also reports migration
state per function package, so a readiness probe can catch drift the local boot gate never
sees — a pod that came up before a migration ran, for instance:

```json
{
  "status": "ok",
  "migrations": {
    "status": "pending",
    "pending": 1,
    "targets": [{ "name": "@spfn/auth", "total": 13, "applied": 12, "pending": 1,
                  "pendingTags": ["20260805143152_client_identity"] }]
  }
}
```

Reporting drift does not change the overall `status` on its own — a probe that should
hold a drifted pod out of rotation asserts `migrations.pending === 0` itself.

### 3. Logging

Configure logging drivers for production:

```yaml
services:
  app:
    # ... other config
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
```

### 4. Reverse Proxy

Use Nginx or Caddy as a reverse proxy for SSL termination:

```yaml
services:
  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
      - ./ssl:/etc/nginx/ssl:ro
    depends_on:
      - app

  app:
    # ... other config
    # Don't expose port directly
    expose:
      - "3790"
```

### 5. Client IP behind a proxy

Requests reach the SPFN backend through the RPC proxy (`createRpcProxy`), not directly from the
browser. The proxy does **not** forward the raw `X-Forwarded-For` header; it resolves the real
client IP from the forwarded chain and re-emits it under a dedicated header,
`x-spfn-proxy-client-ip`. The backend (`getClientIp`, used by rate limiting) trusts that header
**only on requests it can verify came through the proxy** — otherwise a direct caller could
spoof any IP.

To make verified client IPs work in production, set two environment variables:

- **`SPFN_PROXY_SECRET`** — the same value on the Next.js app and the API backend. The proxy
  HMAC-signs each forwarded request; the backend's proxy-guard verifies the signature and then
  trusts `x-spfn-proxy-client-ip`. Without it, requests are unsigned, the backend won't trust
  the header, and the visitor IP falls back to the TCP peer address or `'unknown'`.
- **`TRUSTED_PROXY_HOPS`** — how many trusted proxies sit in front of the app (e.g. load
  balancer + nginx = `2`; default `1`). This tells the proxy how many rightmost
  `X-Forwarded-For` entries are your own infra so it picks the correct client entry.

> **Don't** work around a missing client IP by forwarding raw `X-Forwarded-For` from the proxy —
> that header is client-controllable and reintroduces IP spoofing. Set `SPFN_PROXY_SECRET`
> instead. Rotate with a grace window via `SPFN_PROXY_SECRET_PREVIOUS` on the backend.

For the full mechanism, see the `@spfn/core/nextjs` package README (*Header forwarding & client
IP*) and `@spfn/core/middleware` (proxy-guard + `getClientIp`).

## Monitoring and Debugging

### Container Logs

```bash
# View all container logs
docker-compose logs -f

# View specific service logs
docker-compose logs -f app

# View last 100 lines
docker-compose logs --tail=100 app

# View logs with timestamps
docker-compose logs -f -t app
```

### Container Shell Access

```bash
# Access container shell
docker exec -it spfn-app sh

# Run commands in container
docker exec spfn-app pnpm run db:migrate
docker exec spfn-app node --version

# Check container resource usage
docker stats spfn-app
```

### Database Connection

```bash
# Connect to PostgreSQL
docker exec -it spfn-postgres psql -U spfn -d spfn_prod

# Run SQL from host
docker exec -i spfn-postgres psql -U spfn -d spfn_prod < backup.sql

# Create database backup
docker exec spfn-postgres pg_dump -U spfn spfn_prod > backup.sql
```

## Troubleshooting

### Container Won't Start

```bash
# Check container status
docker-compose ps

# View detailed logs
docker-compose logs app

# Inspect container
docker inspect spfn-app

# Check if services are healthy
docker-compose ps --format json | jq '.[].Health'
```

### Database Connection Issues

```bash
# Check if PostgreSQL is ready
docker exec spfn-postgres pg_isready -U spfn

# Test connection from app container
docker exec spfn-app sh -c 'apt-get update && apt-get install -y postgresql-client && psql $DATABASE_URL -c "SELECT 1"'

# Check network connectivity
docker exec spfn-app ping spfn-postgres
```

### Build Cache Issues

```bash
# Clear Docker build cache
docker builder prune -af

# Rebuild without cache
docker-compose build --no-cache

# Remove all containers and volumes
docker-compose down -v
```

> **✅ Success:** Next Steps
>
> Your Superfunction application is now deployed! Consider adding:
> - Monitoring with Sentry or similar tools
> - Automated backups for PostgreSQL
> - Load balancing for horizontal scaling
> - CDN for static assets