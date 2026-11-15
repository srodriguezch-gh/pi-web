import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const { runtimeVersions, clearRuntimeVersionsCache } = await createJiti(import.meta.url, { tsconfigPaths: true }).import("./runtime-versions.ts");

function withPackageDir(version) {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-versions-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "pi-web", version }));
  return dir;
}

test("reports the installed app version, not the one baked into the bundle", () => {
  const cwd = process.cwd();
  const dir = withPackageDir("9.8.7");
  try {
    process.chdir(dir);
    process.env.NEXT_PUBLIC_APP_VERSION = "1.5.0";
    clearRuntimeVersionsCache();
    assert.equal(runtimeVersions().app, "9.8.7");
  } finally {
    process.chdir(cwd);
    delete process.env.NEXT_PUBLIC_APP_VERSION;
    clearRuntimeVersionsCache();
  }
});

test("reads pi's version from its installed package", () => {
  const cwd = process.cwd();
  const dir = withPackageDir("0.0.1");
  try {
    process.chdir(dir);
    delete process.env.NEXT_PUBLIC_PI_VERSION;
    clearRuntimeVersionsCache();
    // `dir` has no node_modules, so resolution falls through to the package-relative path.
    const versions = runtimeVersions();
    assert.equal(versions.app, "0.0.1");
    assert.match(versions.pi, /^\d+\.\d+\.\d+/);
  } finally {
    process.chdir(cwd);
    delete process.env.NEXT_PUBLIC_PI_VERSION;
    clearRuntimeVersionsCache();
  }
});

test("falls back to the built-in version when the package file is missing", () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "pi-web-versions-empty-"));
  try {
    process.chdir(dir);
    process.env.NEXT_PUBLIC_APP_VERSION = "3.2.1";
    clearRuntimeVersionsCache();
    assert.equal(runtimeVersions().app, "3.2.1");
  } finally {
    process.chdir(cwd);
    delete process.env.NEXT_PUBLIC_APP_VERSION;
    clearRuntimeVersionsCache();
  }
});

test("memoizes the read", () => {
  const cwd = process.cwd();
  const dir = withPackageDir("1.0.0");
  try {
    process.chdir(dir);
    clearRuntimeVersionsCache();
    assert.equal(runtimeVersions().app, "1.0.0");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "2.0.0" }));
    assert.equal(runtimeVersions().app, "1.0.0", "a hot upgrade is picked up by the next server start");
    assert.equal(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version, "2.0.0");
  } finally {
    process.chdir(cwd);
    clearRuntimeVersionsCache();
  }
});
