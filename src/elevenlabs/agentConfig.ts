/**
 * ElevenLabs agent document. Placeholders:
 *   YOUR_PUBLIC_HOST — host of this voice service, no scheme
 *   REPLACE_WITH_ELEVENLABS_SECRET_ID — workspace secret whose value is TOOL_SHARED_SECRET
 *
 * The webhook body is the tool parameters themselves (not wrapped).
 * This service also accepts `{ "parameters": { ... } }` in case a client wraps them.
 */
export const SYSTEM_PROMPT = `You are the phone receptionist for a padel club that uses GoCourt. Replies are one or two short spoken sentences. No lists, no markdown, no URLs.

Language: the greeting is in Greek. If the caller's reply is in English (even just "Hello"), call the language_detection tool with language en before you answer, then answer in English. If they later clearly switch back to Greek, call language_detection with el. Otherwise, answer in the language of the caller's first reply and use only that language. If they reply in English, speak only English for the rest of the call, with no Greek words, Greek names for times or days, or mixed sentences. If they reply in Greek, speak only Greek, with no English words or mixed sentences. Tool "say" fields may be in English; when speaking Greek, translate them fully into Greek. Switch language only if the caller clearly switches and keeps speaking the other language (a single word or name does not count); then switch completely and stay in the new language.

You book and cancel courts for the club, the way the front desk does. You never invent a free time, a price, or a booking number. Always use the tools. Then say the tool's "say" field, once, in the caller's language. Do not add anything from the other JSON fields.

customer_phone, court, courts, court_name, and price_euros are for the tools. Phone number: right after the caller says their mobile number, read it back once, quickly, in short digit groups, and ask if it is right (for example "six nine four, zero zero zero, zero zero zero zero, right?"). If they correct it, take the corrected number and read that back once the same way. After that, never say the phone number again: not in the booking confirmation, not after you book, not when cancelling, nowhere. Ask for a missing name or phone once. If you already have it, do not ask again.

Courts at the same time are the same for the caller. If more than one is free, one is booked for them. Do not ask which court, and do not mention a court number or a court type. Pass court as "any" unless the caller named a court or a type. Mention a court number or a type only when they just asked ("which court?", "indoor or outdoor?") or when they named one themselves. If they ask which court, use court_name from the tool result.

The club's clock is Europe/Athens. Say times the way a person would ("seven in the evening"), not as "nineteen hundred".

Before any tool call about a time:
- "Today", "tomorrow", and a weekday are specific enough. Pass them in date.
- "Tomorrow evening", "in the afternoon", "πρωί", "απόγευμα", or "βράδυ" without a clock hour is not specific. Ask which hour. Do not guess.
- A bare hour from 1 to 11 ("at 7", "στις 7") is not specific. Ask whether they mean the morning or the evening. After they answer, pass time_of_day as morning or evening and time as the hour they said.
- When the hour is clear, pass time as 24-hour HH:MM (7 in the evening is 19:00).

Booking:
1. Get the day, the start time, and the length. If they don't say a length, use 60 minutes.
2. Call check_availability. Say its "say" field and stop. Do not list courts.
3. If needs_clarification is true, ask what "say" asks and wait. Do not book.
4. If available is false, offer only the times in "say". Do not book.
5. If the name or the phone is still missing, ask for the missing one, once. When they give the phone, read it back once to confirm, as above.
6. Call create_booking without confirmed. Say its "say" field and wait. That sentence is the confirmation. Do not repeat the phone number, the price, or a court.
7. Call create_booking with confirmed true only after a clear yes. Without that, the tool will not book.
8. After success, say the "say" field. It already has the booking number and the time. Do not add the phone number, the price, or a court.

Cancellation:
1. Ask once for a booking number, or the name and phone on the booking. The day helps if they know it. If they give a phone, read it back once to confirm, as above, then never repeat it.
2. Call find_booking or cancel_booking. If several matches come back, say the "say" field and ask which booking number.
3. Say the "say" field and ask only if it asks. Do not add a court number.
4. Call cancel_booking with confirmed true only after a clear yes.

Never ask for a password, card number, or email. If ok is false, apologise in one sentence using "say". If the club is closed or the time has passed, say so and offer another time.`;

export type AgentPlaceholders = {
  /** Origin of this service, e.g. https://voice.example.com — no trailing slash. */
  publicBaseUrl: string;
  /** ElevenLabs workspace secret id, not the secret value. */
  toolSecretId: string;
};

type Json = Record<string, unknown>;

function tool(name: string, description: string, properties: Json, baseUrl: string, secretId: string): Json {
  return {
    type: "webhook",
    name,
    description,
    response_timeout_secs: 60,
    pre_tool_speech: "force",
    api_schema: {
      url: `${baseUrl}/tools/${name}`,
      method: "POST",
      content_type: "application/json",
      request_headers: {
        "x-tool-secret": { secret_id: secretId },
      },
      request_body_schema: {
        type: "object",
        description: "Arguments collected from the caller. Omit a field rather than guessing.",
        properties,
        required: [],
      },
    },
  };
}

const dateField = {
  type: "string",
  description:
    "Day of the booking. Use today, tomorrow, a weekday, or YYYY-MM-DD. If they only said a part of the day (evening, απόγευμα), put that word here too, or pass time_of_day, and do not invent an hour.",
};
const timeField = {
  type: "string",
  description:
    "Start time. Use 24-hour HH:MM when the hour is unambiguous (19:00). If they said a bare hour such as 7, pass 7 and also pass time_of_day only after they say morning or evening.",
};
const periodField = {
  type: "string",
  description: "morning, afternoon, evening, or night. Leave empty until the caller has said which part of the day.",
};
const durationField = {
  type: "integer",
  description: "Length in minutes. Use 60 when the caller does not choose. 90 is an hour and a half.",
};
const courtField = {
  type: "string",
  description:
    "Only when the caller named a court or a type, such as court 2 or indoor. Otherwise any. Do not ask which court.",
};

export function buildAgentConfig(placeholders: AgentPlaceholders): Json {
  const base = placeholders.publicBaseUrl.replace(/\/+$/, "");
  const secretId = placeholders.toolSecretId;
  const tools = [
    tool(
      "check_availability",
      "Check whether the requested time is free. Several courts at one time count as free; one is chosen. Say only the say field. Do not list courts or ask which court. If needs_clarification is true, ask and call again. If available is false, offer the times in say and do not book.",
      { date: dateField, time: timeField, time_of_day: periodField, duration_minutes: durationField, court: courtField },
      base,
      secretId,
    ),
    tool(
      "create_booking",
      "Create a front-desk booking. Call with confirmed true only after the caller has agreed to the day, time, and name in the say field. The phone is confirmed once, in grouped digits, right after they say it, and is never read again. If confirmed is not true, the tool asks once and does not book.",
      {
        date: dateField,
        time: timeField,
        time_of_day: periodField,
        duration_minutes: durationField,
        court: courtField,
        court_id: {
          type: "integer",
          description: "Court id from a previous tool result when the caller named a court. Omit it when they did not.",
        },
        customer_name: { type: "string", description: "Name of the player the booking is for." },
        customer_phone: {
          type: "string",
          description:
            "Phone number of the player, as they said it. Store it. Read it back once, in grouped digits, right after they say it. Never read it again.",
        },
        confirmed: { type: "boolean", description: "True only after the caller clearly agrees to this exact booking." },
      },
      base,
      secretId,
    ),
    tool(
      "find_booking",
      "Find an existing booking by booking number, or by the name and phone on it. Use this before cancelling when you are not sure which booking they mean.",
      {
        booking_id: { type: "string", description: "Booking number if the caller knows it." },
        customer_name: { type: "string", description: "Name on the booking." },
        customer_phone: {
          type: "string",
          description:
            "Phone number on the booking. Store it. Read it back once, in grouped digits, only if it has not been confirmed yet. Never read it again after that.",
        },
        date: dateField,
      },
      base,
      secretId,
    ),
    tool(
      "cancel_booking",
      "Cancel one booking. If several match, the tool lists them and cancels nothing. Call with confirmed true only after the caller agrees to cancel that exact booking. Do not read the phone number in the cancellation.",
      {
        booking_id: { type: "string", description: "Booking number if known." },
        customer_name: { type: "string", description: "Name on the booking." },
        customer_phone: {
          type: "string",
          description:
            "Phone number on the booking. Store it. Read it back once, in grouped digits, only if it has not been confirmed yet. Never read it again after that.",
        },
        date: dateField,
        confirmed: { type: "boolean", description: "True only after the caller clearly agrees to cancel this booking." },
      },
      base,
      secretId,
    ),
  ];

  return {
    name: "GoCourt booking",
    conversation_config: {
      agent: {
        language: "el",
        first_message:
          "Καλησπέρα, είμαι η βοηθός κρατήσεων του γηπέδου. Θέλετε να κλείσετε γήπεδο ή να ακυρώσετε μια κράτηση;",
        prompt: {
          prompt: SYSTEM_PROMPT,
          llm: "gemini-2.5-flash",
          temperature: 0.2,
          timezone: "Europe/Athens",
          tools,
          built_in_tools: {
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
          },
        },
      },
      language_presets: {
        en: {
          overrides: {
            agent: {
              first_message:
                "Hello, this is the court booking line. Would you like to book a court, or cancel a booking?",
            },
          },
        },
      },
      tts: {
        model_id: "eleven_flash_v2_5",
        voice_id: "JBFqnCBsd6RMkjVDRZzb",
        stability: 0.5,
        similarity_boost: 0.75,
      },
      turn: {
        turn_timeout: 8,
        turn_eagerness: "normal",
      },
      conversation: {
        max_duration_seconds: 600,
      },
    },
  };
}

export const PLACEHOLDER_CONFIG = buildAgentConfig({
  publicBaseUrl: "https://YOUR_PUBLIC_HOST",
  toolSecretId: "REPLACE_WITH_ELEVENLABS_SECRET_ID",
});
