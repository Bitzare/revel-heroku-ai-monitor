# Revel Heroku AI Ops Monitor v4.5 (Enterprise SRE)

A real-time AI-powered operations dashboard that monitors your Heroku application logs, automatically detects errors, and uses a local AI model to diagnose what went wrong — and suggest how to fix it.

---

## What Is This?

When you run a backend application on Heroku, errors happen constantly: failed API requests, database issues, crashes, security scans from bots, and more. Normally you'd have to dig through thousands of raw log lines to find and understand each problem.

**This tool does that for you, automatically, acting as an AI Site Reliability Engineer:**

1. **100% Reliable Ingestion (Syslog Drain):** Operates as a highly-available Webhook (`POST /api/ingest`) receiving binary Logplex payloads directly from Heroku.
2. **Universal Semantic RAG:** Automatically indexes your entire Go project at startup. When an error occurs, it uses semantic search to find the exact function that crashed, regardless of which folder it's in.
3. **Git Blame Integration:** Automatically cross-references failing code with your local Git repository to tell you exactly *who* wrote the failing line and *when*.
4. **Cascading Failure Correlation:** Tracks recent 5xx crashes (e.g., database down) and intelligently correlates subsequent 4xx errors, warning the AI not to hallucinate fake bugs during an infrastructure outage.
5. **Local AI Engine:** Powered by `qwen2.5-coder:7b` running locally via Ollama with an expanded **8192-token memory window**, ensuring zero JSON parsing errors and deep code comprehension.
6. **Real-Time UI (WebSockets & SQLite):** A beautiful dashboard (`localhost:3333`) featuring an Apdex Health Indicator, Time-Travel filtering, and an intelligent Stacktrace Beautifier.

No data leaves your machine. The AI runs 100% locally.

---

## Dashboard Preview

The dashboard provides:

- **Apdex Health Indicator** — A real-time traffic light (🟢 Healthy, 🟡 Warning, 🔴 Critical) evaluating the last 5 minutes of server health.
- **Time-Travel Chart** — Click on any bar in the error rate chart to instantly filter the dashboard to only show cards from that specific minute.
- **Live Error Feed** — Every failed request appears as a card with Git Blame badges, Cascading Failure warnings, AI insights, and beautified stacktraces.
- **AI Task Checklist** — A right-side panel where the AI automatically generates a prioritised list of bugs to fix, computed dynamically from SQLite metrics.
- **Heuristic WAF** — Instantly detects and flags vulnerability scans (bots looking for `.env` or `wp-admin`) without wasting AI processing time.

---

## Tech Stack

| Component | Technology |
|---|---|
| Monitor engine | Node.js (Syslog HTTPS Drain) |
| Real-time events | [Socket.io](https://socket.io/) (WebSockets) |
| Local Database | [SQLite3](https://www.sqlite.org/) (`ops_center.db`) |
| AI inference | [Ollama](https://ollama.com) (8K Context Window) |
| AI model | `qwen2.5-coder:7b` |
| Source code RAG | In-Memory Semantic Indexing & Git Blame extraction |
| Dashboard | Vanilla HTML + CSS + Chart.js |

---

## Prerequisites

Before running this tool you need the following installed on your machine:

### 1. Node.js
Download from [nodejs.org](https://nodejs.org). Version 18 or higher recommended.

```bash
node --version   # should print v18 or higher