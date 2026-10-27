# Connect AI Enhanced v3

Connect AI is a web-based Roblox Studio assistant with a Node.js backend,
Gemini API integration, and a Roblox Studio plugin.

## Requirements

- Node.js 20 or later
- A Gemini API key with access to a supported model
- A Render web service or another Node.js host
- Roblox Studio with plugin support and HTTP requests enabled

## Repository structure

- server.js
- package.json
- .env.example
- public/index.html
- ConnectAI.plugin.lua

## Environment variables

Configure these in your hosting provider:

- GEMINI_API_KEY: your private Gemini API key
- GEMINI_MODEL: a model available to your API key
- GEMINI_BASE_URL: Gemini API base URL
- CONNECT_AI_TOKEN: a long, random bridge secret
- AI_TIMEOUT_MS: AI request timeout in milliseconds
- AI_MAX_CONTEXT_CHARS: maximum context size

Do not commit actual API keys or bridge secrets to GitHub.

## Run locally

Install dependencies:

npm install

Check JavaScript syntax:

npm run check

Start the server:

npm start

The server uses PORT if the hosting environment provides it.
Otherwise it defaults to port 3000.

## Render deployment

1. Push the project to GitHub.
2. Create a Render Web Service connected to the repository.
3. Set the runtime to Node.
4. Set the build command to npm install.
5. Set the start command to npm start.
6. Configure the environment variables.
7. Deploy and check the logs.

## Roblox Studio plugin setup

1. Install ConnectAI.plugin.lua as a Studio plugin.
2. Replace API_URL with your deployed service URL.
3. Set API_TOKEN to the same value as CONNECT_AI_TOKEN.
4. Enable HTTP requests in the applicable Studio security settings.
5. Open the plugin and check the connection status.
6. Visit the website and try creating a simple Part.

## API routes

- GET /health
- GET /api/health
- POST /api/chat
- POST /api/studio/heartbeat
- GET /api/studio/next
- POST /api/studio/result
- GET /api/jobs/:id

## Safety notes

The plugin supports a limited set of Studio actions. Review changes before
publishing your game and keep backups of important scripts.

The plugin and backend are a starting point and should be tested together
before production use.
