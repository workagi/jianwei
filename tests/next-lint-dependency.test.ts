import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Linter } from "eslint";

const require = createRequire(import.meta.url);
const nextRequire = createRequire(require.resolve("eslint-config-next"));
const pluginRequire = createRequire(nextRequire.resolve("@next/eslint-plugin-next"));
const { getRootDirs } = pluginRequire("./utils/get-root-dirs.js");
const fixture = mkdtempSync(join(tmpdir(), "jianwei-next-lint-"));
for (const dir of ["one/pages", "one/nested/pages", "two/pages", ".hidden/pages"]) {
  mkdirSync(join(fixture, dir), { recursive: true });
}
writeFileSync(join(fixture, "one/pages/about.js"), "export default function About() {}\n");
afterAll(() => rmSync(fixture, { recursive: true, force: true }));

function roots(rootDir?: string | string[]) {
  return getRootDirs({ cwd: fixture, settings: { next: { rootDir } } })
    .map((dir: string) => resolve(dir)).sort();
}

describe("Next lint directory lookup after removing braces", () => {
  it("keeps the default, literal, glob and array root directories", () => {
    const one = join(fixture, "one");
    const two = join(fixture, "two");
    expect(roots()).toEqual([fixture]);
    expect(roots(one)).toEqual([one]);
    expect(roots(`${one}/`)).toEqual([one]);
    expect(roots(join(fixture, "*"))).toEqual([one, two]);
    expect(roots(join(fixture, "{one,two}"))).toEqual([one, two]);
    expect(roots([one, two])).toEqual([one, two]);
    expect(roots(join(fixture, "**/pages"))).toEqual([
      join(one, "nested/pages"), join(one, "pages"), join(two, "pages"),
    ].sort());
    expect(roots(join(fixture, "missing"))).toEqual([]);
  });

  it("still reports an internal HTML link through the actual Next rule", () => {
    const messages = new Linter().verify('const page = <a href="/about">About</a>;', [{
      languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
      plugins: { next: nextRequire("@next/eslint-plugin-next") },
      settings: { next: { rootDir: join(fixture, "*") } },
      rules: { "next/no-html-link-for-pages": "error" },
    }]);
    expect(messages.map((message) => message.ruleId)).toEqual(["next/no-html-link-for-pages"]);
  });

  it("removes braces from the plugin's installed dependency resolution", () => {
    expect(() => pluginRequire.resolve("braces")).toThrow();
  });
});
