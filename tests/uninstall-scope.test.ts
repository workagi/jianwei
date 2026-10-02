import { chmod, copyFile, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("uninstall resource scope", () => {
  it("deletes only resources returned by the exact Compose project label", async () => {
    const root = await mkdtemp(join(tmpdir(), "jianwei-uninstall-"));
    const bin = join(root, "bin");
    const project = join(root, "project");
    const log = join(root, "docker.log");
    await mkdir(bin);
    await mkdir(project);
    await copyFile(join(process.cwd(), "uninstall.sh"), join(project, "uninstall.sh"));
    await chmod(join(project, "uninstall.sh"), 0o755);
    await writeFile(join(bin, "docker"), `#!/bin/sh
printf '%s\\n' "$*" >> "$DOCKER_LOG"
case "$*" in
  "container ls -aq --filter label=com.docker.compose.project=test-project") echo project-container ;;
  "volume ls -q --filter label=com.docker.compose.project=test-project") echo project-volume ;;
  "network ls -q --filter label=com.docker.compose.project=test-project") echo project-network ;;
  "image ls -q --filter label=com.docker.compose.project=test-project") echo project-image ;;
  "container inspect --format {{.Image}} project-container") echo project-image ;;
esac
`, { mode: 0o755 });

    await execFileAsync("bash", [join(project, "uninstall.sh"), "--clean", "--yes"], {
      cwd: project,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        DOCKER_LOG: log,
        COMPOSE_PROJECT_NAME: "test-project",
      },
    });

    const calls = await readFile(log, "utf8");
    expect(calls).toContain("label=com.docker.compose.project=test-project");
    expect(calls).toContain("container rm -f project-container");
    expect(calls).toContain("network rm project-network");
    expect(calls).toContain("volume rm project-volume");
    expect(calls).not.toContain("builder prune");
    expect(calls).not.toContain("image rm");
    expect(calls).not.toMatch(/grep|monitor-postgres|trendradar-output/);
  });
});
