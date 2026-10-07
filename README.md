# Tinker

Free AI agents for coding and problem solving, in your **browser** and your **terminal**.
Use it online at https://tinker-ai.onrender.com/app. It runs on every chat model available on Groq (loaded automatically), like Qwen and GPT-OSS.

## Install (terminal)

```bash
npm install -g github:shivalikathuria80-gif/tinker
tinker
```
No API key needed: it talks to the hosted Tinker server. Want to use your own Groq key instead? Put `GROQ_API_KEY=...` in `~/.tinker/.env`.
Inside Tinker you can use `/model`, `/clear` and `/exit`.

Requires Node 20.12+.

## Run from source

1. Copy `.env.example` to `.env` and add your `GROQ_API_KEY`.
2. No `npm install` is needed. Tinker uses only built-in Node features.

## Web

```bash
npm run dev
```
Open http://localhost:3000 for the landing page, or http://localhost:3000/app for the app.

## Terminal (from source)

```bash
npm link
tinker
```

## How it works

Browser → `server.js` (/api/chat) → Groq → streamed back to the browser.
The terminal app talks to the same hosted server (or to Groq directly if you set your own key).
API keys stay in `.env` and never reach the browser.

Models come from Groq automatically. Speech and safety-filter models are hidden because they cannot chat.

## Skills, connectors and plugins

- **Skills** change how Tinker behaves: Debugger, Code Reviewer, Test Writer, Explain Simply, Architect, or write your own (web app).
- **Connectors** let Tinker pull in outside info: Web pages, GitHub repos, Web search (GPT-OSS models), and any **MCP server** (Streamable HTTP) to automate your work.
- **Plugins** are one-click bundles of a skill + connectors: Researcher, Repo Explorer, Bug Hunter, Teacher.

Web: click **Customize** in the top bar. Terminal: `/skill` and `/connect`.
MCP servers in the terminal go in `~/.tinker/mcp.json`:

```json
[{ "name": "DeepWiki", "url": "https://mcp.deepwiki.com/mcp" }]
```
