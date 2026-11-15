"use client";

import { useRuntimeVersions } from "@/hooks/useRuntimeVersions";

/** Renders the installed version of `app` or `pi`, read from the running install. */
export function RuntimeVersion({ of }: { of: "app" | "pi" }) {
  const versions = useRuntimeVersions();
  return <>{versions[of]}</>;
}
