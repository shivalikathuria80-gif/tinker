# Tinker

Free AI agents for coding and problem solving, in your **browser** and your **terminal**.
It runs on OmniRoute combos only: your own combos plus the built-in auto/* ones (loaded automatically).

## Install (terminal)

```bash
npm install -g tinker-ai
tinker
```
The first time you run it, `tinker` asks for your OmniRoute URL and API key and saves them to `~/.tinker/.env`.
Run `tinker setup` to change them. Inside Tinker you can use `/model`, `/clear` and `/exit`.

Requires Node 20.12+ and a running OmniRoute gateway.

## Run from source

1. Copy `.env.example` to `.env` and add `OMNIROUTE_BASE_URL` + `OMNIROUTE_API_KEY`.
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

Browser → `server.js` (/api/chat) → OmniRoute → streamed back to the browser.
The terminal app calls the providers directly through `lib/providers.js`.
API keys stay in `.env` and never reach the browser.

Models are your OmniRoute combos; restart the server after adding or changing a combo.
