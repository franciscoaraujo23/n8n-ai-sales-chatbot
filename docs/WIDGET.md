# The website widget

The website chat is a custom widget: two files (`chat.js` and `chat.css`,
in the website repository) totaling about **15 KB gzipped**, with no
dependencies. Adding it to a page takes one line:

```html
<script src="chat.js" defer></script>
```

The script creates the launcher and the panel, loads its own CSS and talks to
the `chat-site` n8n workflow. It uses the website's design tokens (colors,
type, radii), with fallbacks so it still works on a page without them.

## Why a custom widget

n8n ships a generic chat widget. Building my own made possible what mattered
for conversion:

- opening the **Cal.com calendar on top of the chat**, pre-filled with what
  the agent knows, and confirming the booking inside the conversation;
- a branded character instead of a generic chat icon;
- full control over what gets rendered and how (security, accessibility,
  performance).

## Features

| | |
|---|---|
| **Character as the launcher** | On desktop, a full-body illustrated character (SVG, shaded with gradients and a rim light) waves every now and then and on hover. On mobile and in the chat header, a round bust. |
| **Per-page bubble** | A message tailored to the page ("Which of these fits you?" on services, "Liked what you saw?" on the lab page). No bubble where people are already booking or on legal pages. Once dismissed, it stays gone for the session. |
| **Book a call** | An always-visible button in the header, on top of the links the agent gives in the conversation. Both open the calendar on top of the chat, pre-filled. |
| **Booking confirmation** | When the booking goes through, the chat confirms it and the character celebrates. |
| **A character that feels alive** | The mouth moves while the agent is typing; the eyes blink. |
| **Unread replies** | Visitors who ask and close the chat before the reply see a counter on the launcher, across pages too. |
| **Continuous conversation** | The conversation carries over as the visitor moves between pages. |
| **Suggestions** | Three ready-made questions the first time the chat opens. |

## Security

- The agent's text is **escaped** before any formatting. Only then are links,
  bold text and lists recognized.
- A **link allowlist** on the client too (the website and Cal.com), as a
  second line of defense behind the server's.
- When the calendar can't load, Cal.com links open in a new tab with
  `rel="noopener"`.

## Privacy

- State (a random conversation id and the messages) lives in
  `sessionStorage`: that tab only, cleared when it closes. No cookies.
- The Cal.com script only loads when the visitor clicks to book.

## Accessibility

- Buttons have accessible names, including the number of unread replies.
- The panel is a `dialog`; messages live in a `role="log"` region with
  `aria-live`, so screen readers announce replies.
- Keyboard: Enter sends, Shift+Enter adds a line, Esc closes; focus moves to
  the text field on open and back to the launcher on close.
- `prefers-reduced-motion`: no animations.
- On mobile, the panel goes full screen and the text field uses 16 px, so
  iOS doesn't zoom in on focus.

## Performance

The website already had rich visual effects (animated background, blur, film
grain), so the widget was measured, not just designed:

- **~15 KB gzipped** in total, no libraries.
- The character's continuous animations only run for the first 20 seconds;
  after that, only the blink and the occasional wave remain, and everything
  comes back on hover. Measured with Chrome traces: less repainting under the
  site's grain overlay.
- The character lives on its own compositing layer (`will-change`), so
  repaints stay there.
- Elements marked `data-scroll-proprio` keep native scrolling, so the site's
  smooth-scroll script doesn't hijack the mouse wheel inside the message list.

## How it was tested

- **Headless Chrome driven over CDP**, with the webhook mocked: open, send,
  switch pages, close before the reply, desktop and mobile, with screenshots
  of each state.
- Automated assertions in the same run: request format, links that must
  never render (an `<img onerror>` and an external domain in a mocked
  reply), persistence across pages, JavaScript errors.
- **End-to-end test in production**: the live website talking to the live
  n8n, including the Cal.com calendar opening pre-filled.
