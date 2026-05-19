# Telegram Automation App

Multi-tenant SaaS platform for Telegram bot, channel, and group automation. Built as a modular monolith with Node.js, Express, PostgreSQL, Redis, and BullMQ.

## Tech Stack

- **Runtime:** Node.js 20+
- **Framework:** Express 4 with EJS templates
- **Database:** PostgreSQL 16 (Knex.js query builder + migrations)
- **Cache/Queue:** Redis 7 + BullMQ 5
- **Object Storage:** S3-compatible (Sevalla Object Storage / R2 / MinIO)
- **Telegram:** Telegraf (Bot API) + GramJS (MTProto user connections)
- **AI:** Google Gemini (optional, for AI auto-reply)
- **Auth:** Session-based with bcrypt, CSRF protection
- **Encryption:** AES-256-GCM at-rest encryption for secrets

## Project Structure

```
src/
├── infra/          # Infrastructure layer (db, redis, queues, storage, crypto, logger)
├── modules/        # Domain modules (auth, connections, broadcasts, drip, etc.)
├── server/         # Express app, middleware, routes, entry points
├── shared/         # Cross-cutting utilities (env, errors, ids, time)
└── workers/        # BullMQ workers and cron scripts
views/              # EJS templates
migrations/         # Knex database migrations
scripts/            # Seed scripts and utilities
tests/              # Unit, property, and integration tests
```

## Local Development Setup

### Prerequisites

- Node.js 20+
- Docker & Docker Compose (for PostgreSQL, Redis, MinIO)

### 1. Start services

```bash
docker-compose -f docker-compose.dev.yml up -d
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment

```bash
cp .env.example .env
# Edit .env with your local values
# Generate keys:
#   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

### 4. Run migrations

```bash
npm run migrate
```

### 5. Seed super admin

```bash
npm run seed
```

### 6. Start development

```bash
# Web server
npm run start:web

# Worker process (separate terminal)
npm run start:worker
```

The app will be available at `http://localhost:8080`.

## Available Scripts

| Script | Description |
|--------|-------------|
| `npm run start:web` | Start the web server |
| `npm run start:worker` | Start all BullMQ workers |
| `npm run start:cron` | Run a one-shot cron task (requires task name arg) |
| `npm run migrate` | Run pending database migrations |
| `npm run migrate:rollback` | Rollback the last migration batch |
| `npm run seed` | Seed the super admin user |
| `npm run lint` | Run ESLint |
| `npm test` | Run all tests |
| `npm run test:property` | Run property-based tests only |
| `npm run test:integration` | Run integration tests only |

### Cron Tasks

Run one-shot cron tasks via:

```bash
node src/server/index.cron.js <task-name>
```

Available tasks:
- `analytics-rollup` — aggregate analytics events into daily summaries
- `member-cleanup` — enqueue member cleanup jobs for tenants with active rules
- `connection-sweeper` — restart unlocked active connections
- `subscription-expire` — expire subscriptions past their end date
- `audit-log-cleanup` — delete audit logs older than 365 days

## Deployment to Sevalla

### Architecture

The application runs as three process types on Sevalla:

| Process | Command | Scaling |
|---------|---------|---------|
| **Web** | `node src/server/index.web.js` | Horizontal (multiple instances) |
| **Worker** | `node src/server/index.worker.js` | Horizontal (multiple instances) |
| **Cron** | `node src/server/index.cron.js <task>` | Scheduled Jobs |

### Managed Services

1. **PostgreSQL** — Sevalla Managed Database (PostgreSQL 16)
2. **Redis** — Sevalla Managed Redis (Redis 7)
3. **Object Storage** — Sevalla Object Storage (S3-compatible)

### Deployment Steps

#### 1. Create Managed Services

- Create a PostgreSQL database. Note the connection string.
- Create a Redis instance. Note the connection URL.
- Create an Object Storage bucket. Note endpoint, region, keys, and bucket name.

#### 2. Create Web Application

- **Build command:** `npm install`
- **Start command:** `node src/server/index.web.js`
- **Release command:** `npm run migrate`
- Set all environment variables (see below).

#### 3. Create Worker Application

- **Build command:** `npm install`
- **Start command:** `node src/server/index.worker.js`
- Set the same environment variables as the web app.

#### 4. Configure Cron Jobs (Scheduled Jobs)

Create Sevalla Scheduled Jobs for each recurring task:

| Task | Command | Schedule |
|------|---------|----------|
| Analytics Rollup | `node src/server/index.cron.js analytics-rollup` | Every 5 minutes |
| Member Cleanup | `node src/server/index.cron.js member-cleanup` | Daily at 02:00 UTC |
| Connection Sweeper | `node src/server/index.cron.js connection-sweeper` | Every 1 minute |
| Subscription Expire | `node src/server/index.cron.js subscription-expire` | Daily at 03:00 UTC |
| Audit Log Cleanup | `node src/server/index.cron.js audit-log-cleanup` | Weekly (Sunday 04:00 UTC) |

#### 5. Seed Super Admin

After the first deploy and migration, run the seed script once:

```bash
# Via Sevalla console or one-off job
node scripts/seed.js
```

### Environment Variables

All variables are validated at boot via Zod (`src/shared/env.js`). The process exits with a clear error if any required variable is missing.

| Variable | Required | Description |
|----------|----------|-------------|
| `NODE_ENV` | Yes | `production` for deploy |
| `PORT` | No | Default: 8080 (Sevalla sets this) |
| `BASE_URL` | Yes | Public URL (e.g. `https://app.example.com`) |
| `TRUST_PROXY` | No | Default: `1` (behind Sevalla edge proxy) |
| `LOG_LEVEL` | No | Default: `info` |
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `DATABASE_POOL_MIN` | No | Default: 2 |
| `DATABASE_POOL_MAX` | No | Default: 20 |
| `REDIS_URL` | Yes | Redis connection URL |
| `SESSION_SECRET` | Yes | Random string ≥32 chars |
| `APP_MASTER_KEY` | Yes | Base64-encoded 32-byte AES key |
| `APP_MASTER_KEY_PREV` | No | Previous key for rotation |
| `APP_MASTER_KEY_ID` | No | Default: `v1` |
| `S3_ENDPOINT` | Yes | Object storage endpoint URL |
| `S3_REGION` | Yes | Storage region |
| `S3_ACCESS_KEY` | Yes | Storage access key |
| `S3_SECRET_KEY` | Yes | Storage secret key |
| `S3_BUCKET` | Yes | Storage bucket name |
| `SMTP_URL` | Yes | SMTP connection URL |
| `MAIL_FROM` | Yes | Sender email address |
| `GEMINI_API_KEY` | No | Google Gemini API key (for AI auto-reply) |
| `GEMINI_DEFAULT_MODEL` | No | Default: `gemini-1.5-flash` |
| `SUPER_ADMIN_EMAIL` | Yes | Super admin email (for seed) |
| `SUPER_ADMIN_PASSWORD` | Yes | Super admin password (for seed) |
| `WEB_CONCURRENCY` | No | Default: 1 |
| `WORKER_CONCURRENCY_DEFAULT` | No | Default: 5 |
| `RATE_LIMIT_LOGIN_MAX` | No | Default: 5 |
| `METRICS_ENABLED` | No | Set to `1` to enable `/metrics` endpoint |

### Procfile

The included `Procfile` defines the process types:

```
release: npm run migrate
web: node src/server/index.web.js
worker: node src/server/index.worker.js
```

### Health Check

The web process exposes `GET /health` which returns:
- `200 OK` when PostgreSQL and Redis are reachable
- `503 Service Unavailable` when any dependency is down

Configure Sevalla health checks to hit this endpoint.

### Observability

When `METRICS_ENABLED=1`, the web process exposes `GET /metrics` in Prometheus text format with:
- `messages_sent_total` — counter of messages sent
- `broadcasts_in_flight` — gauge of running broadcasts
- `queue_depth{queue}` — gauge per BullMQ queue
- `ai_calls_total` — counter of AI API calls
- `errors_total{type}` — counter of errors by type

### CI/CD

GitHub Actions workflow (`.github/workflows/ci.yml`) runs on every PR:
- Lint (ESLint)
- Unit tests
- Property-based tests
- Integration tests (with PostgreSQL and Redis services)

## License

UNLICENSED — Proprietary software.
