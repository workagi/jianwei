# Contributing to 见微 (Jianwei)

## Branch Protection (Required for maintainers)

The `main` branch must be protected with these settings in GitHub repo Settings → Branches:

- [x] Require a pull request before merging
- [x] Require status checks to pass before merging
  - **Required checks**: `Audit, test and build` (the CI `validate` job)
- [x] Require branches to be up to date before merging
- [x] Do not allow bypassing the above settings (including administrators)

## Pre-merge Checklist

Before merging any PR:

1. CI must be green (lint, Vitest, Next build, DB integration tests, content evaluation)
2. Database migration must include both up and rollback instructions
3. If schema changes: `pnpm db:generate` must produce no drift
4. Manual smoke test: `docker compose -f docker-compose.prod.yml up -d` → health → login → create monitor
5. Backup the production database before deploying schema migrations

## Release Process

1. Tag the green main commit: `git tag v0.x.y`
2. Deploy with: `docker compose -f docker-compose.prod.yml pull && docker compose -f docker-compose.prod.yml up -d`
3. Monitor `/api/health` for 5 minutes
4. Verify worker heartbeat appears
