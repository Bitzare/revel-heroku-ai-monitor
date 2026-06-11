# Revel Heroku AI Ops Monitor v4.0

A real-time AI-powered operations dashboard that monitors your Heroku application logs, automatically detects errors, and uses a local AI model to diagnose what went wrong — and suggest how to fix it.

---

## What Is This?

When you run a backend application on Heroku, errors happen constantly: failed API requests, database issues, crashes, security scans from bots, and more. Normally you'd have to dig through thousands of raw log lines to find and understand each problem.

**This tool does that for you, automatically:**

1. It connects to your Heroku app's live log stream.
2. It watches for any HTTP errors (4xx, 5xx), panics, and database failures, filtering out SQL noise and tracking transient errors.
3. It features an **Heuristic WAF (Web Application Firewall)** that instantly detects vulnerability scans (like bots looking for `.env` or `wp-admin` files) and isolates them without wasting AI resources.
4. It sends the relevant log context to a **local AI model** (DeepSeek Coder, running via Ollama on your machine) using **Semantic RAG** to read the exact Go functions related to the crash.
5. Every diagnosis is stored locally in an **SQLite database** (`ops_center.db`) for high-performance querying and historical preservation.
6. A **beautiful web dashboard** (running at `localhost:3333`) pushes new errors and a prioritized AI checklist directly to your browser in **real-time using WebSockets**, with zero page reloads.

No data leaves your machine. The AI runs 100% locally.

---

## Dashboard Preview

The dashboard provides:

- **Live error feed** — Every failed request appears as a card with status code, HTTP method, endpoint, AI diagnosis, and suggested fix. Updates are pushed instantly via `Socket.io`.
- **Error rate chart** — Visualises 4xx vs 5xx errors over time using Chart.js.
- **AI Task Checklist** — A right-side panel where the AI automatically generates a prioritised list of bugs to fix, computed directly from SQLite metrics.
- **Anomaly detection** — If an endpoint suddenly spikes beyond its historical baseline (calculated dynamically in rolling 60-second windows), it is flagged automatically with a red alert badge.
- **Filters** — Filter by status code (4xx / 5xx), HTTP method, or search by endpoint and error text.

---

## Tech Stack

| Component | Technology |
|---|---|
| Monitor engine | Node.js |
| Real-time events | [Socket.io](https://socket.io/) (WebSockets) |
| Local Database | [SQLite3](https://www.sqlite.org/) |
| AI inference | [Ollama](https://ollama.com) — local LLM runtime |
| AI model | `deepseek-coder:6.7b` |
| Log source | Heroku CLI (`heroku logs --tail`) |
| Source code RAG | Reads your Go backend `.go` files for context (Semantic Function matching) |
| Dashboard | Vanilla HTML + CSS + Chart.js |

---

## Prerequisites

Before running this tool you need the following installed on your machine:

### 1. Node.js
Download from [nodejs.org](https://nodejs.org). Version 18 or higher recommended.

\`\`\`bash
node --version   # should print v18 or higher
\`\`\`

### 2. Heroku CLI
Download from [devcenter.heroku.com/articles/heroku-cli](https://devcenter.heroku.com/articles/heroku-cli) and log in:

\`\`\`bash
heroku login
heroku whoami   # should print your email
\`\`\`

### 3. Ollama (local AI runtime)
Download from [ollama.com](https://ollama.com) and install the DeepSeek Coder model:

\`\`\`bash
ollama pull deepseek-coder:6.7b
ollama run deepseek-coder:6.7b   # test it works, then Ctrl+C to exit
\`\`\`

Ollama must be running in the background whenever you use the monitor.

---

## Setup

### 1. Clone the repository and install dependencies

Since v4.0, the monitor requires local dependencies for the database and websockets.

\`\`\`bash
git clone https://github.com/YOUR_USERNAME/revel-heroku-ai-monitor.git
cd revel-heroku-ai-monitor
npm install sqlite3 socket.io
\`\`\`

### 2. Configure the monitor

Open `monitor.js` and update these constants near the top of the file:

\`\`\`javascript
const APP_NAME = 'your-heroku-app-name';   // your Heroku app slug
const BACKEND_PATH = 'C:\\path\\to\\your\\go\\backend'; // absolute path to your Go source code
\`\`\`

- **`APP_NAME`** — the name of your Heroku app (the part in `your-app.herokuapp.com`).
- **`BACKEND_PATH`** — the folder where your Go backend lives. The monitor auto-discovers endpoints mapped to your `handlers/` subdirectories to provide the AI with code context. If you don't have a Go backend, set this to an empty folder.

---

## Running the Monitor

Make sure Ollama is running first:

\`\`\`bash
ollama serve   # keep this terminal open
\`\`\`

Then in a separate terminal, start the monitor:

\`\`\`bash
node monitor.js
\`\`\`

You will see output like:

\`\`\`text
🗺️  ROUTE_MAP auto-descubierto: 20 rutas
⏳ Conectando con Heroku Stream...
🌐 Servidor Ops Center (WebSocket + SQLite) activo en http://127.0.0.1:3333
\`\`\`

Open your browser at **http://localhost:3333** to see the dashboard.

The monitor will now stream live logs, process them in a concurrent analysis queue, save them to the local SQLite database, and instantly push the updates to your screen.

---

## Generated Files

The monitor manages data persistently using the following files:

| File | Description |
|---|---|
| `ops_center.db` | **(New)** SQLite database storing all historical error traces, AI insights, and checklists. |
| `revel_ai_errors.log` | Plain-text fallback log, featuring automatic rotation (capped at 2000 lines). |
| `revel_ai_checklist.json` | Internal JSON cache of prioritized tasks. |
| `revel_ai_baseline.json` | Historical error-rate data per endpoint per hour, used for tracking traffic anomalies. |

---

## How the Pipeline Works (v4.0 Architecture)

The system operates on an advanced Agentic Pipeline:

1. **Heuristic WAF & Throttling:** Incoming logs are parsed deterministically. If a bot scanning for vulnerabilities is detected (e.g., `/config/.env.local`), it is immediately logged with a `⚠️ THREAT SCAN / BOT` warning without engaging the AI. Transient network errors are also categorized instantly.
2. **Two-Phase Agentic Analysis:** For genuine backend bugs, the request enters a serial queue. 
    * **Phase 1 (Reflection):** DeepSeek reads the exact Go function context and thinks step-by-step to diagnose the raw error.
    * **Phase 2 (Extraction):** A secondary prompt enforces strict JSON formatting, assigning a confidence score (`HIGH/MEDIUM/LOW`) based on validation rules.
3. **Database Aggregation:** Errors are grouped and aggregated in SQLite (`SELECT ... GROUP BY url`). Every few seconds, the engine hashes the database state to check for changes and asks the AI to re-evaluate the top 15 most critical clusters into an actionable Team Checklist.

---

## Troubleshooting

**"Heroku stream cerrado"** — The Heroku CLI is not logged in or the app name is wrong. Run `heroku login` and verify `APP_NAME`.

**"Ollama no disponible"** — Ollama is not running. Start it with `ollama serve` in a separate terminal.

**No live updates on screen** — Ensure `socket.io` was installed properly (`npm install`). The top-right indicator on the dashboard should say "En vivo" in green.

**AI output marked LOW confidence** — The model returned a vague response (e.g. missing raw error). The entry is still saved and displayed, but with a warning.

---

## License

ISC