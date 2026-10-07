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
- **Connectors** let Tinker pull in outside info: Web pages, GitHub repos, Web search and Run code (GPT-OSS models), and any **MCP server** (Streamable HTTP) to automate your work.
- **Local files + commands** (terminal only, on by default): Tinker can list, read and write files and run commands in the folder you started it in. It asks `(y/n)` before every write or command.
- **Plugins** are one-click bundles of a skill + connectors: Researcher, Repo Explorer, Bug Hunter, Teacher.

Web: click **Customize** in the top bar. Terminal: `/skill` and `/connect`.
MCP servers in the terminal go in `~/.tinker/mcp.json`:

```json
[{ "name": "DeepWiki", "url": "https://mcp.deepwiki.com/mcp" }]
```

## Web app extras

- **Attach files**: the paperclip adds text/code files (up to 30 KB each) to your message.
- **Voice input**: the mic records you; Groq Whisper turns it into text.
- **Download / share**: download a chat as Markdown, or copy a share link (the chat is packed into the link, no account needed).

## Tests

```bash
npm test
```
Checks that the local file tools stay inside the project folder and respect "no".
