import express from "express";
import { loadConfig } from "../src/config.js";
import { createServerApp } from "../src/runtime.js";

/**
 * Vercel runs this file as one serverless function. The Express app is created
 * once per instance, so a warm instance keeps the GoCourt JWT and a cold
 * instance signs in on the first tool call. `src/index.ts` is the local server
 * (`npm run dev`) and is not the Vercel entry.
 */
function build() {
  try {
    return createServerApp(loadConfig());
  } catch (error) {
    const message = error instanceof Error ? error.message : "Server is not configured";
    const app = express();
    app.disable("x-powered-by");
    app.use((_req, res) => {
      res.status(500).json({ ok: false, say: message });
    });
    return app;
  }
}

export default build();
