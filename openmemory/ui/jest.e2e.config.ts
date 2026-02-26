import type { JestConfigWithTsJest as Config } from "ts-jest";

const config: Config = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["<rootDir>/tests/e2e/**/*.test.ts"],
  // No moduleNameMapper — we want the real neo4j-driver and real HTTP
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        tsconfig: "<rootDir>/tsconfig.json",
        diagnostics: false,
      },
    ],
  },
  testTimeout: 120_000, // entity extraction + cluster rebuild can take 20-60 s
  maxWorkers: 1, // must run serially (--runInBand equivalent)
  verbose: true,
  forceExit: true,
  // Global setup / teardown can be added here if needed
  globals: {},
};

export default config;
