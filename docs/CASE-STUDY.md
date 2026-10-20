# Case study: the Náutica AI website sales agent

How I built a production sales agent on n8n, what it costs, how I know it
works, and what I learned along the way.

## The goal

Náutica AI's website gets visitors who aren't ready to book a call yet. The
agent exists for that moment: answer their questions with the company's
real information, understand their business, and, when it makes sense, take
them to a discovery call.

Success comes down to one thing: **a lead with contact details reaches the
team**, or the visitor books the call on their own.

I set the constraints before writing any code:

- **Only the company's truth.** No invented prices, timelines or clients. The
  information comes from a knowledge base edited by non-developers.
- **Consultative selling, no pressure.** One question at a time, honesty
  when automation isn't worth it, no fake urgency or discounts.
- **European Portuguese**, always.
- **Predictable cost**, with a daily cap.
- **Built on the tool the agency sells (n8n)**, and good enough to serve as
  an example of the agency's work.

## The principle: the model writes, the code decides

A language model is great at conversation and unreliable at following rules.
So everything that has to be right every time is out of the model's hands:

| The model does | The code guarantees |
|---|---|
| Talks, explains, asks questions | Blocks prompt injection before the model sees the message |
| Decides when to propose the call (writes `[[MARCAR]]`) | Builds the Cal.com link with name and email and enforces the proposal limit |
| Decides when to register a lead | Validates and cleans the data; the conversation a lead belongs to comes from the system, never from the model |
| Writes links | Lets through only links to the website and the calendar |
| — | Rate limits, cost cap, fallback reply if the model fails |

The result is an agent with personality whose possible failures are
bounded: at worst it says something off-tone. It can't hand out a malicious
link, see another conversation's data, or spend without limit.

## Making n8n workflows testable

n8n is visual, and workflows drawn by hand are hard to review, version and
test. Here the workflows are **defined in JavaScript**:

```
src/*.js ──► scripts/workflows/*.js ──► build.js ──► workflows/*.json ──► n8n API
   │                                                        ▲
   └──► unit tests                 harness (mocks n8n) ─────┘
```

- The logic (guards, validation, post-processing) lives in `src/` as plain
  JavaScript, and the build copies it into the Code nodes. **The code running
  in production is the code the tests cover.**
- A harness runs the *exact* code of the generated workflows against a mock
  of `$json`, `$input` and `$('node')`. A renamed node or a missing field is
  caught before it ever reaches n8n.
- Postgres queries are tested on an in-memory Postgres 17 (PGlite) with the
  real migrations.
- Every deployment is validated with n8n-mcp and confirmed through the API.

The first production test showed why this pays off: n8n 2.29's sandboxed Code
nodes don't expose the global `URL` object. I rewrote the URL handling without it and made the harness run every Code
node without `URL` too, so that class of bug can't pass the tests again.

## Measuring instead of guessing: evals

Unit tests cover the code, but they can't tell you whether the agent holds a
good conversation. That's what **evals** are for: conversations written as
test cases (what the visitor says, what the reply must and must not contain,
which tools should be used), run against the live agent.

Every case runs **five times**, because a model answers differently each
time and a one-run improvement can be luck. There are 28 cases: FAQs, a full
lead qualification, out-of-scope prices, honesty about fit, drift into
Brazilian Portuguese, requests for a human, booking flows, and a battery of
12 attacks.

One rule saved a lot of time: **read the failures before touching the
agent.** Some early "failures" were correct paraphrases that a regex didn't
catch. Fix the check, re-score the recorded answers (`--reavaliar`), and only
then change the prompt.

## Choosing the model with data

The interim model (`gpt-4.1-mini`) kept getting one case wrong: asked "who
are your clients?", it volunteered that the company had none before talking
about how risk is reduced for the customer. Instead of tuning the prompt to
one model, I ran five inexpensive models through the same battery, through
the n8n agent exactly as it runs in production:

| Model | Passing runs | Notes |
|---|---|---|
| `claude-haiku-5.5` | 58/60 | Registered the lead in every conversation; the cheapest |
| `gemini-3.1-flash-lite` | 58/60 | Faster, but said "I've saved your email" without saving it |
| `gpt-4.1-mini` | 55/60 | The persistent "who are you" failure |
| `gpt-5.6-luna` | 41/60 | Errors inside the n8n agent |
| `mistral-small-2603` | 5/60 | Not compatible with the n8n agent |

The tie was broken by **the kind of failure**. An agent that tells a visitor
it saved their details without saving them loses the lead and misleads the
person, the worst possible failure for this product. Haiku costs about two
extra seconds per reply, which is fine in a chat with a typing indicator.

## Problems that only show up in production

### Replies cut off mid-word

With the new model, about 8% of replies were truncated and a few came back
empty. The eval metrics showed it wasn't random: Haiku **reasons before it
answers**, and that reasoning counted against the 700-token output limit,
leaving a variable amount of room for the visible text. With the limit
raised to 2,000 tokens (visible length is still capped in post-processing),
truncation and empty replies dropped to zero across 110 replies.

### Two tools in the same step

When a visitor asked for a human and left their email in the same message,
the team got a "no contact yet" alert, and test leads reached Discord.

I measured instead of guessing: across every run, the handoff was written
**0.4 s before** the lead. n8n runs the tools of a single agent step
**sequentially**, so the handoff, Discord message included, finished before
the lead existed. That ruled out an approach based on waiting inside the
tool, which assumed parallel execution.

The fix took the notification off the tool's path. The handoff is recorded
and the tool replies to the agent immediately; the workflow then calls
itself without waiting, pauses for 10 seconds, re-reads the handoff and the
lead, and only then sends. It works regardless of tool order, and the
visitor's reply got faster.

### A proposal limit that got in the visitor's way

The agent proposes the call at most twice per conversation, so it doesn't
nag. In a real test, the visitor asked for help booking and gave their
email after both proposals had been used: the code stripped the link and
left a dangling sentence.

The limit is meant for the agent's own proposals, not for visitor requests.
I added a narrow exception: when the message asks for the booking or the
link, or the visitor has just shared their email, the link always goes
through. Post-processing and the eval checks use the same function, and an
eval case replays that exact real conversation.

### Evals competing with visitors for budget

The cost kill switch has a daily cap. On the day I compared models, the eval
batteries would have used it up and closed the website chat until midnight.
Each channel now has its own budget (website €1, evals €0.60) and only
counts its own spend. The core still makes no decisions based on the
channel: the budget is configuration data, and a channel without one is
closed by default.

## Testing without polluting production

Each eval battery creates dozens of leads. To keep them out of Notion and the
team's channel, a lead whose email uses a test domain (`exemplo.pt`, …) stays
in Postgres only, flagged as a test. Handoffs from those conversations are
flagged too and never reach Discord. The rule looks at the data, not the
channel, so it also covers real visitors who type an example address.

## A knowledge base that can't break the agent

The knowledge base is a Markdown file in Google Drive, read by a service
account with read access to that single file. Every new version is checked
against a contract (the required sections) and identified by a hash of the
normalized text. An invalid version is never activated: the previous one
keeps working and the team gets an alert. Without an active knowledge base,
the agent isn't called at all, because without one it would make things up.

## The widget

The website widget is custom (`chat.js` + `chat.css`, ~15 KB gzipped, no
dependencies) instead of n8n's generic one. That made it possible to:

- open the Cal.com calendar **on top of the chat**, pre-filled with what the
  agent knows, and confirm the booking in the conversation;
- use an animated character as the launcher, with a different message per
  page and an always-visible "Book a call" button;
- keep the conversation going as the visitor moves between pages;
- get accessibility right (keyboard, screen readers, reduced motion) and add
  defense in depth (escaped HTML, a client-side link allowlist).

Details in [WIDGET.md](WIDGET.md).

## Results

| | |
|---|---|
| Live | since October 2026 |
| Workflows | 9 (2 adapters, core, 2 tools, traffic guard, knowledge base sync, maintenance, error handler) |
| Tests | 100 unit + 28 SQL |
| Evals | 28 cases × 5 runs; latest full battery at 96–99% |
| Attacks | 60/60 |
| Latency | ~3 s per reply (median) |
| Cost | ~€0.0007 per reply |

## What's next

- **WhatsApp as a second channel.** The core is already channel-agnostic; it
  takes one adapter.
- **An LLM judge in the evals**, to score the quality of the selling on top
  of the deterministic checks.
- **Conversion metrics** from the turns table: how many conversations become
  leads and bookings.
