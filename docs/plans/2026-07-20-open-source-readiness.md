# Open Source Readiness Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prepare 见微 for a safe public GitHub release while keeping the repository private until the owner gives final approval.

**Architecture:** Treat open-source readiness as a repeatable release gate rather than a one-time documentation pass. Add repository governance files, a redacted secret/history audit, CI checks, third-party boundary documentation, and a final manual checklist; keep runtime behavior unchanged.

**Tech Stack:** Git, Node.js, pnpm, GitHub Actions, Markdown, Docker Compose

---

### Task 1: Audit the repository before changing its legal status

**Files:**
- Inspect: `.gitignore`
- Inspect: `.env.example`
- Inspect: `.env.production.example`
- Inspect: `docker-compose.yml`
- Inspect: `docker-compose.prod.yml`
- Inspect: `THIRD_PARTY_NOTICES.md`
- Inspect: `pnpm-lock.yaml`

**Step 1: Confirm local secrets and build artifacts are not tracked**

Run:

```bash
git ls-files .env .env.production .DS_Store .next node_modules '*.pem' '*.key' '*.p12' '*.sqlite' '*.db'
```

Expected: no output.

**Step 2: Scan all tracked files and historical patches for credential patterns**

Run:

```bash
pnpm audit:open-source -- --history
```

Expected: PASS without printing secret values.

**Step 3: Export and review dependency licenses**

Run:

```bash
pnpm licenses list --prod
pnpm licenses list --dev
```

Expected: no package with an unknown license or a license incompatible with Apache-2.0 distribution.

**Step 4: Record findings**

Create `docs/open-source-readiness.md` with audit scope, findings, remaining manual checks, and the final publication gate.

### Task 2: Add the project license and third-party attribution

**Files:**
- Create: `LICENSE`
- Modify: `THIRD_PARTY_NOTICES.md`
- Modify: `docs/architecture-trendradar.md`

**Step 1: Add the Apache License 2.0**

Use the unmodified Apache License 2.0 text and identify the project copyright holder.

**Step 2: Complete third-party notices**

Document Hermes Agent, TrendRadar, WeRSS, and wechat-download-api as external or adapted dependencies. State whether each component is copied into this repository, linked as a sidecar, or only accessed through a compatibility interface.

**Step 3: Recheck the process boundary**

Confirm GPL components remain separate processes/containers and that no GPL source has been copied into the Apache-2.0 application tree.

### Task 3: Add public repository governance

**Files:**
- Create: `CONTRIBUTING.md`
- Create: `CODE_OF_CONDUCT.md`
- Create: `SECURITY.md`
- Create: `SUPPORT.md`
- Create: `CHANGELOG.md`
- Create: `.github/PULL_REQUEST_TEMPLATE.md`
- Create: `.github/ISSUE_TEMPLATE/bug_report.yml`
- Create: `.github/ISSUE_TEMPLATE/feature_request.yml`
- Create: `.github/ISSUE_TEMPLATE/config.yml`

**Step 1: Define contribution scope**

Explain local setup, branch and commit expectations, required checks, security-sensitive areas, and the rule against submitting credentials or private content.

**Step 2: Define security reporting**

Tell users not to open public issues for credential leakage, authentication bypasses, unsafe scraping behavior, or private-data exposure. Use GitHub private vulnerability reporting as the preferred channel.

**Step 3: Define support boundaries**

Separate reproducible project defects from third-party login, quota, account-risk, and platform-policy changes.

**Step 4: Add structured issue and pull-request templates**

Require version, deployment method, expected/actual behavior, redacted logs, and completed checks.

### Task 4: Make the release gate executable

**Files:**
- Create: `scripts/open-source-audit.mjs`
- Modify: `package.json`
- Create: `.github/workflows/ci.yml`

**Step 1: Add a redacted audit script**

The script must:

- reject tracked local environment files, databases, private keys, build outputs, and editor/system artifacts;
- scan tracked text files for common credential formats;
- optionally scan Git history without printing matched values;
- report only rule name, file or commit context, and remediation.

**Step 2: Add a package command**

Add:

```json
"audit:open-source": "node scripts/open-source-audit.mjs"
```

**Step 3: Add continuous integration**

On pushes and pull requests, run:

```bash
pnpm install --frozen-lockfile
pnpm audit:open-source
pnpm lint
pnpm test
pnpm build
docker compose config
```

Expected: all checks pass without requiring real platform credentials.

### Task 5: Rewrite documentation for a public reader

**Files:**
- Modify: `README.md`
- Modify: `docs/project-handbook.md`
- Create: `ROADMAP.md`

**Step 1: Remove private-only wording**

Replace “no license / private only” language with the chosen license, public contribution links, honest stability limits, and a clear pre-release status.

**Step 2: Add trust and compliance boundaries**

State that users must comply with platform terms and only process information they are authorized to access. Do not promise permanent stability for unofficial collection paths.

**Step 3: Add a small roadmap**

List near-term reliability, onboarding, observability, provider modularity, and multi-user work without turning the roadmap into a feature promise.

### Task 6: Verify and hand off the public-release decision

**Files:**
- Modify if needed: `docs/open-source-readiness.md`

**Step 1: Run repository checks**

Run:

```bash
pnpm audit:open-source -- --history
pnpm lint
pnpm test
pnpm build
docker compose config
git diff --check
```

Expected: all commands pass.

**Step 2: Verify the working tree**

Run:

```bash
git status --short
git diff --stat
```

Expected: only intentional open-source preparation files are changed.

**Step 3: Commit and push while keeping the repository private**

Run:

```bash
git add .
git commit -m "chore: prepare repository for open source"
git push origin main
```

**Step 4: Stop before publication**

Do not change GitHub visibility. Report the remaining human decisions: final owner identity, GitHub private-vulnerability reporting, public screenshots/demo data, and explicit approval to switch the repository to Public.
