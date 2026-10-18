import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const html = fs.readFileSync(new URL("../templates/index.html", import.meta.url), "utf8");
const source = html.match(/\/\* notice-api \*\/([\s\S]*?)\/\* notice-api-end \*\//)?.[1];
assert.ok(source, "the demo page should include the notice helpers");

const sandbox: {
  CREDITS_NOTICE: string;
  UNAVAILABLE_NOTICE: string;
  noticeFor: (detail: unknown, started: boolean) => string;
} = {
  CREDITS_NOTICE: "",
  UNAVAILABLE_NOTICE: "",
  noticeFor: () => "",
};
vm.runInNewContext(source, sandbox);

const credits = "This booking assistant has run out of credits and can't take bookings right now. Please try again later.";
const unavailable = "The assistant is unavailable right now, please try again later.";

test("quota, credits, limit, 402, and 429 use the credits notice", () => {
  assert.equal(sandbox.CREDITS_NOTICE, credits);
  for (const detail of [
    "quota exceeded",
    { message: "You are out of credits" },
    { reason: "credit limit reached" },
    "HTTP 402 https://api.elevenlabs.io/v1/convai/agents/agent/widget",
    "429 Too Many Requests",
    { code: 1008, reason: "session_time_limit_exceeded" },
    "[ConversationalAI] Disconnected due to an error: quota_exceeded",
  ]) {
    assert.equal(sandbox.noticeFor(detail, false), credits, JSON.stringify(detail));
    assert.equal(sandbox.noticeFor(detail, true), credits, JSON.stringify(detail));
  }
});

test("other failures while starting use the unavailable notice", () => {
  assert.equal(sandbox.UNAVAILABLE_NOTICE, unavailable);
  for (const detail of [
    "[ConversationalAI] Cannot fetch config for agent agent_test: Failed to fetch",
    "Could not start a conversation.",
    "An error occurred. Connection closed",
    "[ConversationalAI] Disconnected due to an error: network",
    "HTTP 500 https://api.elevenlabs.io/v1/convai/conversation",
    "1006 ",
  ]) {
    assert.equal(sandbox.noticeFor(detail, false), unavailable, JSON.stringify(detail));
    assert.equal(sandbox.noticeFor(detail, true), "", JSON.stringify(detail));
  }
});

test("ordinary widget logs and a normal hangup stay quiet", () => {
  assert.equal(sandbox.noticeFor("[ConversationalAI] FingerprintJS failed, falling back", false), "");
  assert.equal(sandbox.noticeFor("1000 user", true), "");
  assert.equal(sandbox.noticeFor("1001 going away", false), "");
  assert.equal(sandbox.noticeFor("Voice call is open.", false), "");
});
