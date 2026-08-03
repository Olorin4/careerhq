// Server-only subpath (@careerhq/core/gates). Kept out of the package's main barrel because
// fingerprint.ts/token.ts use node:crypto, which must never be pulled into a client bundle
// (apps/web client components import "@careerhq/core" directly for state/scoring/grounding).
export * from "./fingerprint.js";
export * from "./token.js";
export * from "./evaluate.js";
