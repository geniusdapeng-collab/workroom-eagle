<div align="center">

# eagle · AI Consulting Management System

**The all-in-one AI work system for independent management consultants — one enterprise, one living archive; a professional digital consulting team that never sleeps**

Traditional consulting sells a report. eagle operates a **continuously deepening cognitive asset for each client enterprise**.

**[简体中文](README.md)** · English

[![License](https://img.shields.io/badge/license-Apache--2.0-9A7B2D)](LICENSE)
[![Base](https://img.shields.io/badge/built%20on-WorkLoom%20Enterprise%20Agent%20IM-1B2A4E)](https://github.com/geniusdapeng-collab/workloom-im)

</div>

---

## The one question: what is the biggest change AI brings to management consulting, and what is the single core point?

> **The biggest change: consulting value shifts from "one-shot delivery of judgment" to "continuous accumulation of cognition".**

Traditional consulting is pulsed: engagement starts (cognition ramps up) → delivery (cognition packaged into slides) → exit (cognition evaporates with the team). AI has permanently rewritten the cost structure of research, analysis and drafting — and with it, the excuse of billing by the day. The service form shifts from "project pulse" to "cognitive stream": agents are present 24/7, and every business event keeps flowing into the client archive. Cognition no longer evaporates — it compounds.

> **The core point: the moat shifts from "the consultant's brain" to "the client-side, ever-thickening, attributable and auditable machine-readable cognitive asset" — the enterprise archive.**

Foundation models can already generate a plausible strategy memo for any company — but they don't know why that product line failed three years ago, the owner's decision preferences, or where the last change initiative got stuck. The real moat was never the frameworks (they're public) — it's **deep context about the client**. The dividing line of the AI era: whether that context can be made machine-readable, continuously accumulated, and attributable.

The trust formula of AI-era consulting — and the design constitution of eagle:

**Trust = Judgment × Context Depth × Attributability**

## What it is

**eagle** is the AI all-in-one work system for independent management consultants and boutique consulting firms: **one consultant + a professional digital consulting team of 12 digital employees working 24/7**, covering the full chain — lead generation, diagnosis, proposal, delivery, year-round retainer companionship, knowledge compounding, and firm operations — more professional than a professional human team, and never off duty.

Built on the [WorkLoom Enterprise Agent IM](https://github.com/geniusdapeng-collab/workloom-im) foundation: all nine capability domains (five-element event store / fence engine / review console / IM channels / night shift / inspection / skill marketplace / multi-tenancy / model router + self-evolution flywheel + digital CEO) are inherited unchanged; every consulting-specific difference is injected via the industry bundle (`bundles/consulting/`).

- **Human-machine rule**: the spotlight moments stay human — first meetings, interviews, diagnosis calls, presentations and renewal negotiations are hard-blocked from AI substitution (fence C-R4). AI flattens everything else.

## Highlights

- **One enterprise, one archive** — seven-zone living client archive (profile / metrics / cognition / people / actions / files / value ledger). The cognitive asset belongs to the client (exportable, local-first data sovereignty).
- **12 digital employees** — chief-of-staff, lead concierge, intel researcher, interview secretary, diagnosis analyst, proposal architect, report composer, quality officer, companion keeper, resource broker, night watch, finance keeper; 10 of them work the night shift on off-peak compute.
- **Trust engineering** — baseline fences C-R1~C-R9 (default_level=review, patches can only tighten): semantic fences route any conclusion/personnel/compliance content to mandatory human review; every rejection becomes a calibration sample (self-evolution flywheel + scorecard).
- **Retainer as first-class citizen** — five cadences (daily monitoring / weekly digest / monthly observation report / quarterly review / annual value report with drill-down evidence chains).
- **Multimodal service front** — clients send screenshots, voice notes and files; the system parses, cross-checks against historical baselines, flags anomalies and files them into the enterprise archive. Before the client even asks in the morning, the consultant already knows.

## Quick start (fully simulated runtime)

```bash
pnpm setup && pnpm preview:all
```

| Surface | URL | What you see |
|---|---|---|
| PC workbench | http://localhost:3000 | Eagle Consulting ops theater: chief-of-staff morning brief, 12-employee satellite group, pending decisions, live digital office |
| Mobile B | http://localhost:3001 | Hi-fi demo pages |
| Mobile C (client front) | http://localhost:3002 | Consulting service front: monthly-report Q&A, screenshot parsing, urgent escalation |

The demo seed is a full consulting-firm runtime: 3 client archives (Hengchang Machinery · retainer / Chuanyu Taste · diagnosis / Xinglan Tech · audit), 100 five-element events with every C-R fence exercised, night-shift decision package, approval cards and multimodal conversations.

## Provenance

eagle is a deep customization of **[WorkLoom · Enterprise Agent IM powered by DeepSeek Harness](https://github.com/geniusdapeng-collab/workloom-im)**. The hotel demo bundle (`bundles/hotel/`) is kept as the base reference implementation. Runtime foundation: DeepSeek Harness (MIT). Engineering base: Hono / tRPC / React / Vite / PostgreSQL 17 + pgvector.

## License

[Apache-2.0](LICENSE) © eagle AI Consulting Management System. vendor/dsh and vendor/dsh-im follow their own MIT licenses.
