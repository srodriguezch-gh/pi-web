"use client";

import { useEffect, useState } from "react";
import type { RuntimeVersions } from "@/lib/runtime-versions";

/** What the bundle was built with: correct until the packages are upgraded in place. */
const BUILT_WITH: RuntimeVersions = {
  app: process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0",
  pi: process.env.NEXT_PUBLIC_PI_VERSION ?? "0.0.0",
};

let inFlight: Promise<RuntimeVersions | undefined> | undefined;

/** One request per page load, shared by every badge on it. */
function fetchVersions(): Promise<RuntimeVersions | undefined> {
  inFlight ??= fetch("/api/version", { cache: "no-store" })
    .then((response) => (response.ok ? (response.json() as Promise<RuntimeVersions>) : undefined))
    .then((body) => (body && typeof body.app === "string" && typeof body.pi === "string" ? body : undefined))
    .catch(() => undefined);
  return inFlight;
}

export function useRuntimeVersions(): RuntimeVersions {
  const [versions, setVersions] = useState<RuntimeVersions>(BUILT_WITH);
  useEffect(() => {
    let cancelled = false;
    void fetchVersions().then((live) => {
      if (!cancelled && live) setVersions(live);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return versions;
}
