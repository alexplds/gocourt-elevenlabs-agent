import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PLACEHOLDER_CONFIG, SYSTEM_PROMPT } from "../src/elevenlabs/agentConfig.js";

type ToolDoc = {
  name: string;
  description: string;
  api_schema: {
    request_body_schema: {
      properties: Record<string, { description?: string }>;
    };
  };
};

function tools(): ToolDoc[] {
  const conversation = PLACEHOLDER_CONFIG.conversation_config as {
    agent: { prompt: { tools: ToolDoc[] } };
  };
  return conversation.agent.prompt.tools;
}

test("the prompt stays in one language and confirms a phone number only once", () => {
  assert.match(
    SYSTEM_PROMPT,
    /Language: the greeting is in Greek\. If the caller's reply is in English \(even just "Hello"\), call the language_detection tool with language en before you answer, then answer in English\. If they later clearly switch back to Greek, call language_detection with el\. Otherwise, answer in the language of the caller's first reply and use only that language\./,
  );
  assert.match(SYSTEM_PROMPT, /speak only English for the rest of the call, with no Greek words/);
  assert.match(SYSTEM_PROMPT, /speak only Greek, with no English words or mixed sentences/);
  assert.match(SYSTEM_PROMPT, /when speaking Greek, translate them fully into Greek/);
  assert.match(SYSTEM_PROMPT, /a single word or name does not count/);
  assert.doesNotMatch(SYSTEM_PROMPT, /You speak Greek by default/);

  const phoneRule =
    'Phone number: right after the caller says their mobile number, read it back once, quickly, in short digit groups, and ask if it is right (for example "six nine four, zero zero zero, zero zero zero zero, right?"). If they correct it, take the corrected number and read that back once the same way. After that, never say the phone number again: not in the booking confirmation, not after you book, not when cancelling, nowhere.';
  assert.equal(SYSTEM_PROMPT.split(phoneRule).length - 1, 1);
  assert.match(SYSTEM_PROMPT, /When they give the phone, read it back once to confirm, as above\./);
  assert.match(SYSTEM_PROMPT, /If they give a phone, read it back once to confirm, as above, then never repeat it\./);
});

test("built-in tools use the system shape ElevenLabs keeps", () => {
  const conversation = PLACEHOLDER_CONFIG.conversation_config as {
    agent: { prompt: { built_in_tools: Record<string, unknown> } };
  };
  assert.deepEqual(conversation.agent.prompt.built_in_tools, {
    language_detection: {
      type: "system",
      name: "language_detection",
      description:
        "Call this as soon as the caller speaks a different language from the one you are using (for example English after the Greek greeting). Switch to that language and stay in it.",
      params: { system_tool_type: "language_detection" },
    },
    end_call: {
      type: "system",
      name: "end_call",
      description: "",
      params: { system_tool_type: "end_call" },
    },
  });
});

test("tool descriptions confirm the phone once and keep later speech free of it", () => {
  const byName = Object.fromEntries(tools().map((tool) => [tool.name, tool]));
  const phone = (name: string) => byName[name]!.api_schema.request_body_schema.properties.customer_phone!.description!;

  assert.match(byName.create_booking!.description, /confirmed once, in grouped digits/);
  assert.match(byName.create_booking!.description, /never read again/);
  assert.match(phone("create_booking"), /Read it back once, in grouped digits, right after they say it/);
  assert.match(phone("create_booking"), /Never read it again/);
  assert.match(phone("find_booking"), /only if it has not been confirmed yet/);
  assert.match(phone("cancel_booking"), /only if it has not been confirmed yet/);
  assert.match(byName.cancel_booking!.description, /Do not read the phone number in the cancellation/);
});

test("published agent docs match the source prompt and config", () => {
  const json = JSON.parse(readFileSync("docs/agent-config.json", "utf8"));
  assert.deepEqual(json, PLACEHOLDER_CONFIG);

  const md = readFileSync("docs/elevenlabs-agent.md", "utf8");
  const fence = "```text\n";
  const start = md.indexOf(fence);
  const end = md.indexOf("\n```\n", start);
  assert.ok(start >= 0 && end > start);
  assert.equal(md.slice(start + fence.length, end), SYSTEM_PROMPT);
  assert.match(
    md,
    /The phone is read back once, in short digit groups, right after the caller says it, and once more if they correct it/,
  );
});
