import crypto from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig } from "../config.js";
import type { GoCourtClient } from "../gocourt/types.js";
import { cancelBooking, checkAvailability, createBooking, findBooking, type ToolBody } from "../tools/handlers.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function demoPagePath(): string {
  const candidates = [
    path.join(here, "../../templates/index.html"),
    path.join(process.cwd(), "templates/index.html"),
  ];
  return candidates.find((file) => fs.existsSync(file)) ?? candidates[0]!;
}

export function createApp(config: AppConfig, client: GoCourtClient): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "100kb" }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", mock: config.mock });
  });

  app.get("/", (_req, res) => {
    const html = fs.readFileSync(demoPagePath(), "utf8").replaceAll("__ELEVENLABS_AGENT_ID__", config.elevenLabsAgentId);
    res.type("html").send(html);
  });

  const guard = (req: Request, res: Response, next: NextFunction) => {
    if (!config.toolSharedSecret || !secretsMatch(config.toolSharedSecret, headerValue(req, config.toolSecretHeader))) {
      res.status(401).json({ ok: false, say: "This booking line is not authorised." });
      return;
    }
    next();
  };

  const context = () => ({ now: new Date(), timeZone: config.timeZone, clubId: config.clubId });

  app.post("/tools/check_availability", guard, async (req, res) => {
    res.json(await checkAvailability(client, unwrap(req.body), context()));
  });
  app.post("/tools/create_booking", guard, async (req, res) => {
    res.json(await createBooking(client, unwrap(req.body), context()));
  });
  app.post("/tools/find_booking", guard, async (req, res) => {
    res.json(await findBooking(client, unwrap(req.body), context()));
  });
  app.post("/tools/cancel_booking", guard, async (req, res) => {
    res.json(await cancelBooking(client, unwrap(req.body), context()));
  });

  app.use("/tools", (_req, res) => {
    res.status(404).json({ ok: false, say: "That tool does not exist." });
  });

  return app;
}

export function unwrap(body: unknown): ToolBody {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  const record = body as ToolBody;
  const nested = record.parameters;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) return nested as ToolBody;
  return record;
}

function headerValue(req: Request, name: string): string {
  const value = req.header(name);
  return typeof value === "string" ? value : "";
}

function secretsMatch(expected: string, got: string): boolean {
  if (!expected || !got) return false;
  const a = crypto.createHash("sha256").update(expected).digest();
  const b = crypto.createHash("sha256").update(got).digest();
  return crypto.timingSafeEqual(a, b);
}
