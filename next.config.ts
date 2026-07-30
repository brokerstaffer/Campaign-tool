import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /*
   * Deployed on Railway, not Vercel: the nightly day-stats sync makes ~700
   * EmailBison calls and the backfill runs for minutes, so no serverless
   * function timeout is worth designing around.
   *
   * Deliberately NOT `output: "standalone"`. Standalone needs its own start
   * command plus manual copying of `public/` and `.next/static`, which is a
   * silent-404-on-assets trap. Nixpacks runs `npm run build && npm start`, and
   * plain `next start` just works. The image is bigger; nothing here cares.
   */
};

export default nextConfig;
