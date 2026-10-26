# Connect AI — Web Workspace + Roblox Studio Plugin

This starter project provides a Gemini-powered web chat and a companion Roblox Studio plugin. The web workspace previews generated code and summarizes AI responses. The Studio plugin can include selected script source/selected object paths as context and apply reviewed code to a selected script.

## Files
- `server.js` — Express backend; Gemini API key stays server-side.
- `package.json` — Node dependencies and start command.
- `.env.example` — environment variable names only; no real secrets.
- `public/index.html` — responsive Connect AI web UI.
- `ConnectAI.plugin.lua` — Studio dock widget plugin.

## A. Create a Gemini API key
1. Open https://aistudio.google.com/app/apikey
2. Sign in and create an API key. Google may ask you to choose/create a Cloud project.
3. Copy the key privately. Never paste it into GitHub, the web page, or the Roblox plugin. Google instructions: https://ai.google.dev/gemini-api/docs/api-key

## B. Upload the project to GitHub
1. Download and extract `ConnectAI-v1.zip`.
2. Create a new GitHub repository, e.g. `connect-ai-roblox`.
3. Upload the contents of the `ConnectAI` folder, including the `public` folder. Keep `.env.example`, but do not add a real `.env` file or API keys.
4. Commit the files to the `main` branch.

## C. Deploy to Render
1. Open https://render.com and connect your GitHub account.
2. Choose **New + → Web Service**, then select the repository.
3. Runtime: Node. Build command: `npm install`. Start command: `npm start`.
4. Add these Environment Variables in Render:
   - `GEMINI_API_KEY` = your private key from AI Studio
   - `GEMINI_MODEL` = `gemini-2.5-flash` (if unavailable to your account, use a model name currently listed in AI Studio)
   - `CONNECT_AI_TOKEN` = a long random private token you create (keep it secret)
5. Deploy. Visit `https://YOUR-SERVICE.onrender.com/health`. It should show `{ "ok": true, ... }`.
6. Visit `https://YOUR-SERVICE.onrender.com/` to open the web UI.

Render guide: https://render.com/docs/web-services

## D. Configure the web UI
The web UI uses the same backend origin by default. If your service has `CONNECT_AI_TOKEN` set, open the site once with `?setup=1` at the end of its URL, e.g. `https://YOUR-SERVICE.onrender.com/?setup=1`. Enter the Render service URL and the matching `CONNECT_AI_TOKEN`. The token is saved only in this browser's localStorage. Do not use this setup on a shared computer. The Gemini API key is never entered in the web UI.

## E. Install/configure the Roblox Studio plugin (Windows)
1. Open Roblox Studio → **Plugins → Manage Plugins → Plugins Folder** (label may differ by Studio version).
2. Follow Studio's local plugin workflow. If using a source file, create `ConnectAI.plugin.lua` in the local plugins folder and paste the full contents from this project; if Studio doesn't load a plain `.lua` file, create/save it as a plugin through Studio's plugin development workflow.
3. In the plugin source, set:
   - `API_URL = "https://YOUR-SERVICE.onrender.com/api/chat"`
   - `API_TOKEN = "the exact same token as CONNECT_AI_TOKEN"`
4. Enable HTTP requests in Game Settings → Security if Studio asks for it. Restart Studio and open the Connect AI toolbar button.
5. Select a Script/LocalScript/ModuleScript and ask Connect AI to explain/fix it. Review its code before using Apply. Applying replaces the selected script's entire source; make a backup first and use Ctrl+Z if needed.

## F. Property/context workflow
- The plugin can include selected object paths and selected script source in AI context.
- For broader Explorer/property context, select the relevant instances and paste their names, paths, and property values into the web UI's optional Studio Context box. You can also ask Connect AI to generate a script that prints selected instance properties.
- This starter does **not** remotely inspect live players or read a Roblox account. Player/session details are only available when you deliberately capture them from a Studio test session or provide the data yourself. Avoid sending personal or sensitive player data.
- The web UI cannot independently mutate Studio. Studio edits happen through the plugin after you review and approve them. This version previews generated code and AI change summaries; it does not provide a full automatic project diff/rollback engine or arbitrary instance builder yet.

## Security and limitations
- Never commit `GEMINI_API_KEY` or `CONNECT_AI_TOKEN` to GitHub.
- The selected script source/context is sent to your backend and then to Google's Gemini API when you ask a question.
- `CONNECT_AI_TOKEN` is a shared bearer token in this starter, not a user login system. Do not expose the web UI to the public without adding authentication, rate limits, and stronger access control.
- Generated code may be wrong. Review it and test in a copy of your game before publishing.
- This is a Gemini-powered application, not a newly trained foundation model. API access, quota and billing depend on your Google account.
