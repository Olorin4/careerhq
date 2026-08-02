import type { NormalizedJob } from "@careerhq/contracts";
import type { fetchJson, fetchText } from "../net.js";

export interface FetchContext {
  fetchJson: typeof fetchJson;
  fetchText: typeof fetchText;
}
export interface JobFetcher {
  source: string;
  fetch(ctx: FetchContext): Promise<NormalizedJob[]>;
}
