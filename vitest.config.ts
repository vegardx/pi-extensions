import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    testTimeout: 30000,
    // A single forked worker keeps the process tree shallow. With the default
    // forks pool vitest spawns one worker per CPU core (~9 on a 10-core
    // machine). If the host process is killed abruptly (e.g. a pi crash)
    // those workers are orphaned. singleFork: true means there is only one
    // child to orphan, and the suite still completes in ~4 s.
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
