/**
 * Outputs SAM parameter overrides from constants.ts.
 * Run from repo root: npx tsx infra/emit-params.ts
 */
import constants from "./constants";

const overrides = Object.entries(constants)
  .map(([key, value]) => `${key}=${JSON.stringify(String(value))}`)
  .join(" ");

console.log(overrides);
