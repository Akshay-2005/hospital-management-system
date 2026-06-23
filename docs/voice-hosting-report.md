# Production Readiness & Hosting Cost Report
### Real-Time Voice Agent — Patient Portal

**Prepared for:** Engineering Management
**Date:** 23 June 2026
**Currency note:** Hosting/Groq costs in USD ($); Sarvam costs in INR (₹). Conversions use ≈ ₹86 = $1.

---

## TL;DR (For Management)

Our patient portal's voice agent needs an always-connected "phone line" (a WebSocket) that traditional Vercel hosting could not provide — which is why we're evaluating where to run it in production. We have two viable paths: **(Option 1)** move the app to an always-on host like **Railway (~$15–30/mo) or Render (~$14–50/mo)**, where our existing code runs unchanged, or **(Option 2)** stay on **Vercel using its new native WebSocket support (Public Beta, ~$20–40/mo)**, which is officially documented but requires a small code change and carries beta risk. Hosting is a minor fixed cost either way; our real variable cost is the **AI usage (~$55/mo at ~1,000 voice sessions), dominated almost entirely by Sarvam text-to-speech**. **Our recommendation: try Option 2 (Vercel) first** because it needs no migration, while keeping **Railway ready as a proven fallback** if the beta proves unstable.

---

## 1. Executive Context — What We've Built

Before comparing hosting paths, here is what our platform actually is, in plain terms, so the cost decisions make sense.

We run a **Next.js 16.1.6** patient portal with three core journeys:

| Feature | How it works today | Infrastructure it needs |
|---|---|---|
| **Patient Registration** | A server action creates the patient record, generates a UHID, sends a welcome email + WhatsApp message, and issues a password-setup link. | Standard request/response. Works anywhere. |
| **Appointment Booking** | A transactional API (`POST /api/appointments`) that atomically reserves a slot and creates the appointment, with idempotency protection against double-booking. | Standard request/response + database. Works anywhere. |
| **Voice Agent** ⭐ | The patient speaks; audio streams **live** to our server over a **WebSocket**, gets transcribed (Groq Whisper), interpreted, and spoken back (Sarvam Bulbul v3). | **A persistent, always-connected server.** This is the entire reason this report exists. |

**The crux of the problem:** Registration and booking are ordinary web requests — they start, finish, and the server forgets them. The **voice agent is different.** It holds an open, two-way "phone line" (`ws://.../api/ws/stt` and `ws://.../api/ws/tts`) for the whole conversation. Traditional Vercel hosting was built for short, stateless requests that die after responding — the opposite of what a live voice call needs. That mismatch is what we're solving.

**Technically, we use the `next-ws` library (v2.2.7)**, which exposes an `UPGRADE` handler in our route files. Our live STT socket lives at `app/api/ws/stt/route.ts` and our TTS socket at `app/api/ws/tts/route.ts`. Audio is captured in the browser by an AudioWorklet (`public/worklets/pcm-processor.js`), down-sampled to 16 kHz PCM, and streamed as binary frames. Our data lives in **PostgreSQL (currently Supabase)** via Prisma.

We are currently configured for **Vercel** (region `bom1` / Mumbai), build command `prisma generate && next build --webpack`, start command `next start`. We also already have a working **Dockerfile** (Node 20, Next.js standalone output) — which, as you'll see, makes Option 1 dramatically easier.

---

## 2. OPTION 1 — Migrate to an Always-On Host (Railway or Render)

The safe, proven path. WebSockets are a *solved problem* on any platform that keeps a normal Node.js server running 24/7. Our `next-ws` code already works this way locally, so on Railway or Render it should "just run" with no code rewrite.

### 2.1 Technical Breakdown — What We Actually Have To Do

This is genuinely a configuration exercise, not a re-architecture:

1. **Connect the GitHub repository.** On Railway or Render, we click "New Project → Deploy from GitHub," authorize our repo, and pick the `main` branch. Every push then auto-deploys.
2. **Set the build & start commands** (so the server stays awake permanently instead of spinning down):
   - **Build:** `npm ci && npx prisma generate && npm run build`
   - **Start:** `npm start` (which runs `next start`)
   - Because we keep a long-lived `npm start` process running, the WebSocket "phone line" stays open — exactly what the voice agent needs.
3. **Copy our environment variables** into the host's dashboard. We'd transfer the full set we already use: `DATABASE_URL`, `DIRECT_URL`, `JWT_SECRET`, `SARVAM_API_KEY`, `GROQ_API_KEY`, `RAZORPAY_KEY_ID/SECRET`, the `SMTP_*` block, `AISENSY_API_KEY`, the `AWS_*` S3 keys, and `NEXT_PUBLIC_APP_URL`.
4. **Point the database.** We can **keep Supabase as-is** (just reuse the existing `DATABASE_URL`) — *or* migrate to the host's managed Postgres. Recommendation: keep Supabase initially to reduce migration risk; we can move the DB later if we want everything under one bill.
5. **Health check & domain.** Wire our existing `GET /api/health` endpoint as the platform health check, then point our DNS at the new host.
6. **(Optional) Use our existing Dockerfile.** Both platforms can deploy our `Dockerfile` directly, giving us identical local-and-production behavior. This is a strong fallback if the native Node build has any quirks.

**Bottom line: no application code changes.** Our `UPGRADE` handlers run untouched. Risk is low; the work is roughly a half-day of setup and testing.

### 2.2 Infrastructure Cost (2026)

**Railway** ([pricing](https://railway.com/pricing) · [docs](https://docs.railway.com/pricing/plans)) — usage-based, billed on actual CPU/RAM consumed:

| Item | Spec | Est. Monthly | Est. Yearly |
|---|---|---|---|
| Hobby plan base | $5 minimum (includes $5 usage credit) | $5 | $60 |
| App compute (always-on) | ~0.5 vCPU + 0.5–1 GB RAM, 24/7 | ~$10–15 | ~$120–180 |
| Postgres (if hosted on Railway) | small instance | ~$6–12 | ~$72–144 |
| **Railway total** | app + DB | **~$15–30/mo** | **~$180–360/yr** |

*(If we keep Supabase, drop the Postgres line → ~$10–20/mo.)*

**Render** ([pricing](https://render.com/pricing) · [2026 analysis](https://kuberns.com/blogs/render-pricing/)) — fixed tiers:

| Item | Spec | Est. Monthly | Est. Yearly |
|---|---|---|---|
| Starter Web Service | always-on, shared CPU, 512 MB | $7 | $84 |
| Starter Managed Postgres | 256 MB RAM / 1 GB storage | $7 | $84 |
| **Render Starter total** | as advertised | **$14/mo** | **$168/yr** |
| ⚠️ *Realistic production* | Standard web + Standard DB (the 256 MB starter DB is too small for production, and point-in-time backup needs a higher tier) | **~$25–50/mo** | **~$300–600/yr** |

> **Honest caveat:** Render's headline $14/mo is real but its Starter database (256 MB RAM, 1 GB storage, no point-in-time recovery) is **development-grade**. For a real hospital workload we should budget the Standard tier. Railway's metered model tends to be cheaper at our small-but-always-on scale.

---

## 3. OPTION 2 — Use Vercel's Native WebSocket Support (Public Beta)

**Good news that changes the calculus:** Vercel shipped **native WebSocket support in Public Beta on 22 June 2026** ([changelog](https://vercel.com/changelog/websocket-support-is-now-in-public-beta)), and the `experimental_upgradeWebSocket` API **is real and officially documented** ([Vercel WebSockets docs](https://vercel.com/docs/functions/websockets)). This means we may be able to stay on Vercel with no host migration at all.

### 3.1 Phase 1 — Test Our Existing `next-ws` Setup As-Is

**What we'll do:** Deploy the current branch to a Vercel preview, ensure **Fluid Compute is enabled** (default for new projects since April 2025), and try a live voice session against the deployed URL.

**Honest prediction: this will likely fail**, and it's important the team knows *why* before we spend time on it. Our `next-ws` library works by **patching a long-running Node.js HTTP server** — but Vercel does not give us a persistent custom server; it runs our routes as managed Functions. Vercel's own docs state plainly: *"Next.js does not expose an API for handling WebSocket upgrades."* So the `UPGRADE` export that `next-ws` relies on is unlikely to be invoked on Vercel's platform.

**Why test anyway?** It's a 30-minute experiment that costs almost nothing and definitively confirms whether we can avoid any code change. If it works, we're done. If it doesn't (expected), we move to Phase 2.

### 3.2 Phase 2 — Adapt to Vercel's Native `experimental_upgradeWebSocket`

If Phase 1 fails, we swap our `next-ws` `UPGRADE` handler for Vercel's native pattern. The official shape from Vercel's docs is:

```ts
// Vercel's documented minimal pattern (echo server)
import {
  experimental_upgradeWebSocket,
  type WebSocketData,
} from '@vercel/functions';

export async function GET() {
  return experimental_upgradeWebSocket((ws) => {
    ws.on('message', (data: WebSocketData) => {
      ws.send(data);
    });
  });
}
```

Here is how that maps onto **our actual STT socket** at `app/api/ws/stt/route.ts`. The encouraging part: our internal logic (`buildWav`, `transcribeWithGroq`, `translateHindiToEnglish`, the probe/final state machine) **stays exactly the same** — only the connection wrapper changes:

```ts
// app/api/ws/stt/route.ts — adapted to Vercel native WebSockets (Phase 2)
import {
  experimental_upgradeWebSocket,
  type WebSocketData,
} from '@vercel/functions';

// Our existing, unchanged helpers:
//   buildWav(), transcribeWithGroq(), translateHindiToEnglish()
//   and constants PROBE_BYTES, MAX_BYTES, etc.

export async function GET() {
  return experimental_upgradeWebSocket((ws) => {
    // ── Per-connection session state (identical to our current UPGRADE body) ──
    let langCode = 'en-IN';
    const pcmChunks: Buffer[] = [];
    let totalBytes = 0;
    let probeDispatched = false;
    let finalDispatched = false;
    let aborted = false;

    const send = (payload: Record<string, unknown>) =>
      ws.send(JSON.stringify(payload));

    const appendAudio = (data: Buffer) => {
      if (totalBytes >= MAX_BYTES) return;
      const remaining = MAX_BYTES - totalBytes;
      const chunk = data.length <= remaining ? data : data.subarray(0, remaining);
      pcmChunks.push(chunk);
      totalBytes += chunk.length;
    };

    const dispatchFinal = async () => {
      if (finalDispatched || aborted) return;
      finalDispatched = true;
      const rawText = await transcribeWithGroq(pcmChunks, langCode);
      let finalText = rawText;
      if (langCode === 'hi-IN' && rawText) {
        const translated = await translateHindiToEnglish(rawText);
        if (translated) finalText = translated;
      }
      send({ type: 'final', text: finalText, lang: langCode });
      ws.close();
    };

    // ── Message handling: Vercel gives us ONE handler; we branch on type ──
    ws.on('message', (data: WebSocketData) => {
      if (aborted) return;

      // Binary frame = PCM audio; text frame = JSON control message
      if (Buffer.isBuffer(data) || data instanceof ArrayBuffer) {
        appendAudio(Buffer.from(data as ArrayBuffer));
        if (!probeDispatched && totalBytes >= PROBE_BYTES) {
          probeDispatched = true;
          transcribeWithGroq(pcmChunks.map(b => Buffer.from(b)), langCode)
            .then(text => { if (text && !finalDispatched) send({ type: 'transcript', text }); });
        }
        return;
      }

      const msg = JSON.parse(data.toString());
      if (msg.type === 'init')           { langCode = msg.lang ?? 'en-IN'; send({ type: 'ready' }); }
      else if (msg.type === 'end_of_speech') dispatchFinal();
      else if (msg.type === 'abort')     { aborted = true; ws.close(); }
    });

    ws.on('close', () => { aborted = true; });
    ws.on('error', (err) => console.error('[WS-STT] error:', err));
  });
}
```

**Three changes we'd make, and one risk to flag:**

1. **Handler wrapper:** `export function UPGRADE(client, server, request, context)` → `export async function GET()` returning `experimental_upgradeWebSocket((ws) => {...})`. The `ws` object Vercel hands us behaves like the `client` we already use (`.on('message')`, `.send()`, `.close()`).
2. **Binary detection:** `next-ws` gives us an `isBinary` flag; Vercel's `WebSocketData` does not, so we check `Buffer.isBuffer(data)` instead.
3. **We'd apply the identical change to** `app/api/ws/tts/route.ts`.
4. ⚠️ **State-pinning risk (important for voice):** Vercel pins a connection to one Function instance *for the connection's lifetime*, **but the connection closes when the Function hits its max duration**, and reconnects may land on a different instance. Our voice sessions are short (15 s STT failsafe), so this is mostly fine — but we must keep our client-side reconnect logic robust, and never store conversation state in server memory across reconnects (we already pass `organisationId`/`patientId` per request, so we're well-positioned).

#### The TTS socket follows the exact same pattern

Our TTS socket at `app/api/ws/tts/route.ts` is simpler — the client only ever sends one JSON `speak` message, and the server streams back binary audio chunks. Again, our entire "parallel fetch, ordered dispatch" engine (`splitSentences`, `fetchSentenceAudio`, the Sarvam → Google fallback) is **untouched**; only the connection wrapper changes:

```ts
// app/api/ws/tts/route.ts — adapted to Vercel native WebSockets (Phase 2)
import {
  experimental_upgradeWebSocket,
  type WebSocketData,
} from '@vercel/functions';

// Our existing, unchanged helpers:
//   sanitizeForTTS(), splitSentences(), fetchSentenceAudio()
//   (Sarvam Bulbul v3 primary → Google Translate TTS fallback)

export async function GET() {
  return experimental_upgradeWebSocket((ws) => {
    let closed = false;

    const sendJson   = (p: Record<string, unknown>) => { if (!closed) ws.send(JSON.stringify(p)); };
    const sendBinary = (buf: Buffer)                 => { if (!closed) ws.send(buf); };

    ws.on('message', (data: WebSocketData) => {
      if (closed) return;

      // The client only sends a JSON "speak" frame — ignore any binary.
      if (Buffer.isBuffer(data) || data instanceof ArrayBuffer) return;

      let msg: { type: string; text?: string; language?: string };
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type !== 'speak') return;

      const text     = (msg.text ?? '').trim();
      const language = msg.language ?? 'en';
      if (!text) { sendJson({ type: 'done' }); return; }

      const sentences = splitSentences(text);

      // ── Parallel fetch, ordered dispatch (identical to our current logic) ──
      // Fire every sentence's TTS call at once; send buffers in sentence order
      // so the browser plays chunk 0 while 1…N are still downloading.
      const promises = sentences.map((s) => fetchSentenceAudio(s, language));

      (async () => {
        for (let i = 0; i < promises.length; i++) {
          if (closed) break;
          const buf = await promises[i];
          if (buf && buf.length > 0) sendBinary(buf);
        }
        sendJson({ type: 'done' });
      })().catch((err) => sendJson({ type: 'error', message: String(err?.message ?? err) }));
    });

    ws.on('close', () => { closed = true; });
    ws.on('error', (err) => console.error('[WS-TTS] error:', err));
  });
}
```

The migration for both sockets is therefore the **same three-line conceptual change** — replace the `UPGRADE(client, server, request, context)` signature with `GET()` + `experimental_upgradeWebSocket((ws) => …)`, swap the `isBinary` flag for a `Buffer.isBuffer()` check, and leave all business logic exactly as it is.

### 3.3 Cost Impact of Staying on Vercel

Vercel WebSockets run on **Fluid Compute** and bill under **Active CPU pricing** — we pay for the time the function spends *processing* messages, **not** for idle connection time ([changelog](https://vercel.com/changelog/websocket-support-is-now-in-public-beta)). For a voice agent this is favorable: there's a lot of "dead air" (the patient thinking/speaking) where no CPU is billed.

- **Plan:** Production commercial use requires the **Pro plan (~$20/user/month)** as a baseline, plus metered Function/CPU/data-transfer usage on top.
- **Realistic estimate:** ~$20–40/mo at our scale, *plus* whatever we pay for the database (we'd keep Supabase).
- **Versus moving hosts:** Roughly **in the same ballpark** as Railway (~$15–30/mo). The real saving with Option 2 is **zero migration effort and zero DNS/ops disruption** — *if* the beta proves stable. The cost is **beta risk**: APIs can change, and `experimental_` is an explicit "not-yet-stable" label.

---

## 4. Third-Party AI API Costs (2026)

These are our **variable** costs — they scale with patient usage regardless of which host we pick.

### 4.1 Sarvam AI (billed in ₹) — used for our TTS, translation, and optional STT fallback

Source: [Sarvam API Pricing](https://www.sarvam.ai/api-pricing) · [Sarvam Docs](https://docs.sarvam.ai/api-reference-docs/pricing)

| Service | Model | Rate (INR) |
|---|---|---|
| **Speech-to-Text** | Saaras | **₹30 / hour** of audio (₹45/hr for the tier that adds translation + speaker ID) |
| **Text-to-Speech** ⭐ | **Bulbul v3** | **₹30 per 10,000 characters** (≈ ₹0.003/char, beta pricing) |
| **LLM (flagship)** | per 1M tokens | Input **₹4** · Cached **₹2.5** · Output **₹16** |
| **LLM (lighter)** | per 1M tokens | Input **₹2.5** · Cached **₹1.5** · Output **₹10** |

> Note: Sarvam offered **free unlimited Bulbul v3 until 28 Feb 2026** — that promo has now ended, so we should budget the ₹30/10K rate going forward. TTS is our single largest AI cost driver.

### 4.2 Groq (billed in $) — used for our primary STT (Whisper) and LLM/NLU

Source: [Groq Pricing](https://groq.com/pricing) · [CloudZero 2026 breakdown](https://www.cloudzero.com/blog/groq-pricing/)

| Model | Input (per 1M tokens) | Output (per 1M tokens) |
|---|---|---|
| **Llama 3.1 8B Instant** | **$0.05** | **$0.08** |
| **Llama 3.3 70B Versatile** | **$0.59** | **$0.79** |
| **Whisper Large v3 Turbo** ⭐ | **$0.04 / hour of audio** (billed per hour, not per token) | — |

> Whisper v3 Turbo at **$0.04/hr** is remarkably cheap — ~400 hours of patient speech costs ~$16. Our STT bill is effectively a rounding error.

---

## 5. Final Executive Summary

### 5.1 Hosting Overhead Comparison

| | **Option 1: Railway** | **Option 1: Render** | **Option 2: Vercel (Beta)** |
|---|---|---|---|
| **Monthly hosting** | ~$15–30 | ~$14 (starter) → ~$25–50 (prod-grade) | ~$20–40 + Supabase |
| **Yearly hosting** | ~$180–360 | ~$168 → ~$300–600 | ~$240–480 + Supabase |
| **Code changes** | **None** ✅ | **None** ✅ | Likely a small wrapper rewrite (Phase 2) |
| **Migration effort** | ~½ day | ~½ day | Near-zero *if* beta works as-is |
| **WebSocket maturity** | Proven, stable | Proven, stable | **Beta** — may change |

### 5.2 Estimated API Scaling Cost — *Moderate Base (≈1,000 voice sessions/month)*

*Assumptions: ~2 min patient speech/session, ~1,500 chars of agent speech/session, light LLM/NLU usage. Shown for illustration — actuals depend on conversation length.*

| AI Service | Usage | Cost |
|---|---|---|
| Groq Whisper STT | ~33 hrs audio | ~$1.30/mo |
| Groq Llama NLU (8B) | ~9M tokens | ~$0.50/mo |
| Sarvam Bulbul v3 TTS ⭐ | ~1.5M characters | ~**₹4,500/mo (~$52)** |
| Sarvam translate (Hindi subset) | small | ~₹300/mo (~$3.50) |
| **Total AI (moderate)** | | **≈ $55–60/mo (≈ ₹4,800–5,200)** |

**Key insight:** AI costs are dominated almost entirely by **Sarvam TTS**, and they **scale with usage, not with host choice.** Hosting is a small, fixed overhead; the voice minutes are where the real money is. Whichever host we pick, the ~$55/mo AI bill is identical.

### 5.3 Pros vs. Cons & Recommendation

| | **Pros** | **Cons** |
|---|---|---|
| **Option 1 (Railway/Render)** | Proven WebSocket support; our code runs unchanged; predictable; full server control; can use our existing Dockerfile | Adds a 2nd vendor/bill; we manage scaling; a small migration |
| **Option 2 (Vercel Beta)** | No host migration; stays in our current pipeline; idle connections aren't billed (great for voice); `experimental_upgradeWebSocket` is officially documented | **Beta** — API may change; `next-ws` almost certainly needs replacing; state-pinning/reconnect nuances; commercial Pro plan required |

### Recommendation: **Try Option 2 first, with Option 1 as the safety net.**

1. **Run the Phase 1 test this week.** It's ~30 minutes and a deployed preview. Best case, our existing code works on Vercel natively and we're done with zero effort.
2. **If Phase 1 fails (likely), do the Phase 2 wrapper swap on a branch.** It's a contained change to two files; our Groq/Sarvam logic and our whole booking/registration stack are untouched. We test the adapted voice agent on a Vercel preview before committing.
3. **Keep Railway as our documented fallback.** If the Vercel beta proves flaky or its API shifts under us, we already have a Dockerfile and a half-day migration path to a rock-solid always-on host. Railway edges out Render on cost at our scale.

This sequence lets us pursue the lowest-effort, lowest-disruption outcome **without betting the production voice agent on an unproven beta** — we always have a proven escape hatch ready.

---

## Sources

- Railway: [pricing](https://railway.com/pricing), [plans docs](https://docs.railway.com/pricing/plans)
- Render: [pricing](https://render.com/pricing), [2026 pricing analysis](https://kuberns.com/blogs/render-pricing/), [Postgres limits](https://kuberns.com/blogs/render-postgres-pricing-setup-limits/)
- Vercel WebSockets: [Public Beta changelog](https://vercel.com/changelog/websocket-support-is-now-in-public-beta), [official docs + `experimental_upgradeWebSocket`](https://vercel.com/docs/functions/websockets)
- Sarvam AI: [API pricing](https://www.sarvam.ai/api-pricing), [pricing docs](https://docs.sarvam.ai/api-reference-docs/pricing)
- Groq: [pricing](https://groq.com/pricing), [CloudZero 2026 breakdown](https://www.cloudzero.com/blog/groq-pricing/)

---

> **Caveats for the room:** The AI estimates in §5.2 hinge on per-session character/audio assumptions — if the average conversation is longer, TTS scales linearly, so measure real sessions before locking a budget. All five vendors' figures are 2026 beta/subject-to-change (especially Vercel's WebSocket beta and Sarvam's post-promo TTS rate); reconfirm on their pricing pages right before any commitment.
