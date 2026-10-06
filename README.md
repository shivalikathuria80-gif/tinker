# Tinker

Free AI agents for coding and problem solving, in your **browser** and your **terminal**.
It runs on every chat model available on Groq (loaded automatically), like Qwen and GPT-OSS.

## Install (terminal)

```bash
npm install -g github:shivalikathuria80-gif/tinker
tinker
```
The first time you run it, `tinker` asks for a free Groq API key (https://console.groq.com/keys) and saves it to `~/.tinker/.env`.
Run `tinker setup` to change it. Inside Tinker you can use `/model`, `/clear` and `/exit`.

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
The terminal app calls the providers directly through `lib/providers.js`.
API keys stay in `.env` and never reach the browser.

Models come from Groq automatically. Speech and safety-filter models are hidden because they cannot chat.
