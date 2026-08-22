import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: {
    target: "es2022",
  },
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./src/server.ts",
      miniflare: {
        bindings: {
          ACCESS_APP_AUD: "workshop-test-audience",
          ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
        },
      },
      remoteBindings: false,
      wrangler: {
        configPath: "./wrangler.jsonc",
      },
    }),
  ],
  test: {
    include: ["__integration__/access-rpc.test.ts"],
    setupFiles: ["../../scripts/assert-workerd.ts"],
    testTimeout: 60_000,
    // Cap'n Web reports a rejected future capability independently from the directly awaited
    // invocation. The tests assert both expected password-boundary rejections themselves.
    onUnhandledError(error) {
      if (error.message === "This deployment requires Cloudflare Access authentication.") {
        return false;
      }
    },
  },
});
