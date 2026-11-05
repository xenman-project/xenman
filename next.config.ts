import type { NextConfig } from "next";
import { execSync } from "child_process";

let gitCommit = process.env.NEXT_PUBLIC_GIT_COMMIT || "dev";
if (gitCommit === "dev") {
  try {
    gitCommit = execSync("git rev-parse --short HEAD").toString().trim();
  } catch {}
}

const nextConfig: NextConfig = {
  output: "standalone",
  env: {
    NEXT_PUBLIC_GIT_COMMIT: gitCommit,
  },
  serverExternalPackages: ["ssh2"],
  // No "X-Powered-By: Next.js" on every answer, the login page's included:
  // it tells a scanner what to try before anyone has logged in.
  poweredByHeader: false,
};

export default nextConfig;
