import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Traces the minimal set of files/deps the web server actually needs into
  // .next/standalone -- what the Dockerfile's runner stage ships for the
  // Cloud Run web service.
  output: "standalone",
};

export default nextConfig;
