#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const scanHistory = process.argv.includes("--history");
const findings = [];
let dependencyPackagesScanned = 0;

const requiredCommunityFiles = [
  "LICENSE",
  "NOTICE",
  "README.md",
  "CHANGELOG.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "SUPPORT.md",
  ".github/workflows/ci.yml",
];

function runGit(args, options = {}) {
  const result = spawnSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    ...options,
  });

  if (result.status !== 0) {
    const message = (result.stderr || result.stdout || "unknown git error").trim();
    throw new Error(`git ${args.join(" ")} failed: ${message}`);
  }

  return result.stdout;
}

function addFinding(rule, location, remediation) {
  findings.push({ rule, location, remediation });
}

const forbiddenTrackedFiles = [
  {
    rule: "local environment file",
    test: (file) =>
      /(^|\/)\.env(?:\.|$)/.test(file) &&
      !file.endsWith(".env.example") &&
      !file.endsWith(".env.production.example"),
    remediation: "Remove the file from Git and rotate every credential it contained.",
  },
  {
    rule: "private key or local database",
    test: (file) => /\.(?:pem|key|p12|pfx|sqlite|sqlite3|db)$/i.test(file),
    remediation: "Remove the artifact from Git and keep only a documented placeholder.",
  },
  {
    rule: "generated or machine-local artifact",
    test: (file) =>
      file === ".DS_Store" ||
      file.includes("/.DS_Store") ||
      /(^|\/)(?:node_modules|\.next|coverage|__pycache__)(?:\/|$)/.test(file),
    remediation: "Remove the generated artifact from Git and add an ignore rule.",
  },
];

const secretPatterns = [
  {
    name: "private key block",
    regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  },
  {
    name: "GitHub token",
    regex: /\bgh[opusr]_[A-Za-z0-9]{20,}\b/,
  },
  {
    name: "OpenAI-compatible API key",
    regex: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/,
  },
  {
    name: "xAI API key",
    regex: /\bxai-[A-Za-z0-9_-]{20,}\b/,
  },
  {
    name: "Hugging Face token",
    regex: /\bhf_[A-Za-z0-9]{20,}\b/,
  },
  {
    name: "AWS access key",
    regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  },
  {
    name: "Google API key",
    regex: /\bAIza[0-9A-Za-z_-]{30,}\b/,
  },
  {
    name: "Slack token",
    regex: /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/,
  },
  {
    name: "Stripe live key",
    regex: /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}\b/,
  },
];

function isLikelyText(buffer) {
  if (buffer.length === 0) return true;
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  return !sample.includes(0);
}

function scanText(text, locationFactory) {
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    for (const pattern of secretPatterns) {
      pattern.regex.lastIndex = 0;
      if (pattern.regex.test(line)) {
        addFinding(
          pattern.name,
          locationFactory(index + 1),
          "Remove the value from Git history and rotate the credential before publication.",
        );
      }
    }
  }
}

const trackedFiles = runGit(["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
  .split("\0")
  .filter(Boolean);

for (const file of requiredCommunityFiles) {
  if (!existsSync(file)) {
    addFinding(
      "missing community file",
      file,
      "Add the required file before publishing the repository.",
    );
  }
}

for (const file of trackedFiles) {
  for (const rule of forbiddenTrackedFiles) {
    if (rule.test(file)) addFinding(rule.rule, file, rule.remediation);
  }

  let buffer;
  try {
    buffer = readFileSync(file);
  } catch {
    continue;
  }

  if (!isLikelyText(buffer)) continue;
  scanText(buffer.toString("utf8"), (line) => `${file}:${line}`);
}

for (const composeFile of ["docker-compose.yml", "docker-compose.prod.yml"]) {
  if (!existsSync(composeFile)) continue;
  const composeText = readFileSync(composeFile, "utf8");
  if (composeText.includes("we-mp-rss:with-chromium")) {
    addFinding(
      "local-only container image",
      composeFile,
      "Use a documented public image or build definition so a new contributor can start the stack.",
    );
  }
}

const dependencyRoot = join(process.cwd(), "node_modules", ".pnpm");
if (existsSync(dependencyRoot)) {
  const seenPackages = new Set();

  for (const storeEntry of readdirSync(dependencyRoot)) {
    const modulesRoot = join(dependencyRoot, storeEntry, "node_modules");
    if (!existsSync(modulesRoot)) continue;

    for (const moduleEntry of readdirSync(modulesRoot)) {
      if (moduleEntry.startsWith(".")) continue;
      const packageDirs = moduleEntry.startsWith("@")
        ? readdirSync(join(modulesRoot, moduleEntry)).map((name) => join(modulesRoot, moduleEntry, name))
        : [join(modulesRoot, moduleEntry)];

      for (const packageDir of packageDirs) {
        const manifestPath = join(packageDir, "package.json");
        if (!existsSync(manifestPath)) continue;
        try {
          const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
          const packageId = `${String(manifest.name ?? packageDir)}@${String(manifest.version ?? "unknown")}`;
          if (seenPackages.has(packageId)) continue;
          seenPackages.add(packageId);
          dependencyPackagesScanned += 1;

          const license =
            typeof manifest.license === "string"
              ? manifest.license
              : Array.isArray(manifest.licenses)
                ? manifest.licenses.map((item) => item?.type ?? item).join(" OR ")
                : "";

          if (!license || /^(?:unknown|unlicensed)$/i.test(license.trim())) {
            addFinding(
              "dependency without a declared license",
              packageId,
              "Verify the package license and replace or document the dependency before publication.",
            );
          }
        } catch {
          addFinding(
            "unreadable dependency manifest",
            manifestPath,
            "Repair the installation and rerun the audit before publication.",
          );
        }
      }
    }
  }
}

if (scanHistory) {
  const history = runGit([
    "log",
    "--all",
    "--full-history",
    "--no-ext-diff",
    "--text",
    "--format=@@JIANWEI_COMMIT:%H",
    "-p",
  ]);

  let commit = "unknown";
  let file = "unknown";
  const lines = history.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith("@@JIANWEI_COMMIT:")) {
      commit = line.slice("@@JIANWEI_COMMIT:".length, "@@JIANWEI_COMMIT:".length + 12);
      file = "unknown";
      continue;
    }
    if (line.startsWith("+++ b/")) {
      file = line.slice(6);
      continue;
    }
    if (!/^[+-]/.test(line) || line.startsWith("+++") || line.startsWith("---")) continue;

    for (const pattern of secretPatterns) {
      pattern.regex.lastIndex = 0;
      if (pattern.regex.test(line.slice(1))) {
        addFinding(
          pattern.name,
          `commit ${commit}, ${file}`,
          "Rewrite the affected Git history and rotate the credential before publication.",
        );
      }
    }
  }
}

if (findings.length > 0) {
  console.error(`Open-source audit FAILED with ${findings.length} finding(s).`);
  for (const finding of findings) {
    console.error(`- [${finding.rule}] ${finding.location}`);
    console.error(`  ${finding.remediation}`);
  }
  console.error("Secret values are intentionally redacted.");
  process.exit(1);
}

console.log(
  `Open-source audit PASS (${trackedFiles.length} candidate files; ${dependencyPackagesScanned} dependency packages; history scan: ${scanHistory ? "enabled" : "disabled"}).`,
);
