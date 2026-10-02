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

1. Follow `docs/release-process.md`: version + changelog + release notes, PR checks, then merge.
2. Wait for the merged main commit's push CI to pass; create an annotated version tag.
3. Push the tag; `release.yml` verifies it and publishes the GitHub Release.
4. Deploy separately using the release's backup, source-build and migration instructions.
5. Monitor `/api/health`, worker heartbeat and a real monitor result after deployment.
