import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

export interface RuntimeVersions {
  app: string;
  pi: string;
}

const PI_PACKAGE = "@earendil-works/pi-coding-agent/package.json";

/**
 * Versions as they exist on disk right now, not as they existed at build time.
 *
 * `NEXT_PUBLIC_*` values are inlined into the client bundle when it is compiled, so a
 * build that predates an upgrade keeps reporting the old version until someone rebuilds
 * — the badge and the update check disagreed with the installed packages.
 */
let cached: RuntimeVersions | undefined;

function readVersion(file: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

function piPackagePath(): string {
  try {
    // pi is an ordinary runtime dependency: resolve it the way Node would.
    return createRequire(import.meta.url).resolve(PI_PACKAGE);
  } catch {
    return join(process.cwd(), "node_modules", PI_PACKAGE);
  }
}

/** Test hook: forget the memoized read. */
export function clearRuntimeVersionsCache(): void {
  cached = undefined;
}

export function runtimeVersions(): RuntimeVersions {
  if (cached) return cached;
  // `bin/pi-web.js` starts `next` with the package directory as the working directory.
  const app = readVersion(join(process.cwd(), "package.json")) ?? process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0";
  const pi = readVersion(piPackagePath()) ?? process.env.NEXT_PUBLIC_PI_VERSION ?? "0.0.0";
  cached = { app, pi };
  return cached;
}
