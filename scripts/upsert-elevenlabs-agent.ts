/**
 * Create or update the GoCourt ElevenLabs agent.
 *
 * Requires ELEVENLABS_API_KEY, TOOL_PUBLIC_BASE_URL, and ELEVENLABS_TOOL_SECRET_ID.
 * When ELEVENLABS_AGENT_ID is set, that agent is updated. Otherwise a new one is created
 * and its id is printed — store it as ELEVENLABS_AGENT_ID. The API key is never printed.
 */
import { buildAgentConfig } from "../src/elevenlabs/agentConfig.js";

const apiKey = process.env.ELEVENLABS_API_KEY?.trim() ?? "";
const publicBaseUrl = (process.env.TOOL_PUBLIC_BASE_URL ?? "").trim().replace(/\/+$/, "");
const secretId = process.env.ELEVENLABS_TOOL_SECRET_ID?.trim() ?? "";
const agentId = process.env.ELEVENLABS_AGENT_ID?.trim() ?? "";

if (!apiKey || !publicBaseUrl || !secretId) {
  console.error("Set ELEVENLABS_API_KEY, TOOL_PUBLIC_BASE_URL, and ELEVENLABS_TOOL_SECRET_ID.");
  process.exit(1);
}
if (publicBaseUrl.includes("YOUR_PUBLIC_HOST") || secretId.includes("REPLACE_")) {
  console.error("TOOL_PUBLIC_BASE_URL and ELEVENLABS_TOOL_SECRET_ID still look like placeholders.");
  process.exit(1);
}

const body = buildAgentConfig({ publicBaseUrl, toolSecretId: secretId });
const url = agentId
  ? `https://api.elevenlabs.io/v1/convai/agents/${encodeURIComponent(agentId)}`
  : "https://api.elevenlabs.io/v1/convai/agents/create";

const response = await fetch(url, {
  method: agentId ? "PATCH" : "POST",
  headers: {
    "xi-api-key": apiKey,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(body),
});

const text = await response.text();
if (!response.ok) {
  console.error(`ElevenLabs returned ${response.status}.`);
  console.error(text.slice(0, 500));
  process.exit(1);
}

let parsed: { agent_id?: string } = {};
try {
  parsed = JSON.parse(text) as { agent_id?: string };
} catch {
  console.error("ElevenLabs returned a response that was not JSON.");
  process.exit(1);
}

const id = parsed.agent_id || agentId;
console.log(agentId ? `Updated agent ${id}` : `Created agent ${id}`);
console.log("Put that id in ELEVENLABS_AGENT_ID. Nothing was deployed.");
