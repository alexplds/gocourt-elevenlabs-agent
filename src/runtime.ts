import type { Express } from "express";
import type { AppConfig } from "./config.js";
import { createHttpClient } from "./gocourt/httpClient.js";
import { createMockClient } from "./gocourt/mock.js";
import { createApp } from "./http/app.js";

export function assertConfig(config: AppConfig): void {
  if (!config.toolSharedSecret) {
    throw new Error("TOOL_SHARED_SECRET is required. Refusing to start without it.");
  }
  if (!config.mock && !config.gocourtApiBaseUrl) {
    throw new Error("GOCOURT_API_BASE_URL is required when GOCOURT_MOCK is not true.");
  }
  if (!config.mock && !config.ownerToken && (!config.ownerEmail || !config.ownerPassword)) {
    throw new Error("Set GOCOURT_OWNER_EMAIL and GOCOURT_OWNER_PASSWORD, or GOCOURT_OWNER_TOKEN.");
  }
}

/** One Express app and one GoCourt client. Call this once per process. */
export function createServerApp(config: AppConfig): Express {
  assertConfig(config);
  const client = config.mock
    ? createMockClient({ timeZone: config.timeZone })
    : createHttpClient(config);
  return createApp(config, client);
}
