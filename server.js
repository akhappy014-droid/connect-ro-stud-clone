// Connect AI Enhanced — Roblox Studio bridge + Gemini backend
// Node.js 20+. Keep provider keys and bridge token in Render environment variables.

'use strict';
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.GEMINI_API_KEY || process.env.AI_API_KEY || '';
const MODEL = process.env.GEMINI_MODEL || process.env.AI_MODEL || 'gemini-3.8-flash';
const BASE_URL = (
  process.env.GEMINI_BASE_URL ||
  'https://generativelanguage.googleapis.com/v1beta'
).replace(/\/+$/, '');
const BRIDGE_TOKEN =
  process.env.CONNECT_AI_TOKEN || process.env.BRIDGE_TOKEN || '';
const REQUEST_TIMEOUT_MS = Math.max(
  20000,
  Number(process.env.AI_TIMEOUT_MS) || 80000
);
const MAX_QUEUE = 40;
const MAX_JOBS = 200;
const MAX_HISTORY_TURNS = 8;
const MAX_CONTEXT_CHARS = Math.max(
  12000,
  Number(process.env.AI_MAX_CONTEXT_CHARS) || 36000
);
const MAX_SCRIPT_CHARS = 18000;

const studio = {
  lastSeen: 0,
  pluginId: null,
  context: {},
  scripts: [],
  selection: []
};

const jobs = new Map();
const queue = [];

function studioOnline() {
  return Date.now() - studio.lastSeen < 18000;
}

function authToken(req) {
  const auth = req.get('authorization') || '';

  return auth.toLowerCase().startsWith('bearer ')
    ? auth.slice(7).trim()
    : (req.get('x-connect-token') || req.body?.token || '');
}

function authorized(req) {
  return Boolean(BRIDGE_TOKEN) && authToken(req) === BRIDGE_TOKEN;
}

function bridgeAuth(req, res, next) {
  if (!BRIDGE_TOKEN) {
    return res.status(503).json({
      error: 'CONNECT_AI_TOKEN is not configured on the server.'
    });
  }

  if (!authorized(req)) {
    return res.status(401).json({
      error: 'Invalid bridge token. Ensure Render and the Studio plugin use the same token.'
    });
  }

  next();
}

function clampText(value, max) {
  return String(value ?? '').slice(0, max);
}

function cleanScript(s) {
  return {
    path: clampText(s?.path, 300),
    className: clampText(s?.className, 40),
    source: clampText(s?.source, MAX_SCRIPT_CHARS)
  };
}

function pruneJobs() {
  if (jobs.size <= MAX_JOBS) return;

  for (const [id, job] of jobs) {
    if (['complete', 'failed'].includes(job.status)) {
      jobs.delete(id);
    }

    if (jobs.size <= Math.floor(MAX_JOBS * 0.7)) break;
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      const e = new Error('Request timed out');
      e.name = 'AbortError';
      reject(e);
      return;
    }

    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);

    function abort() {
      clearTimeout(timer);
      const e = new Error('Request timed out');
      e.name = 'AbortError';
      reject(e);
    }

    signal.addEventListener('abort', abort, { once: true });
  });
}

const SYSTEM_PROMPT = `You are Connect AI, an expert Roblox Studio and Luau development agent.
Use the provided Studio context and recent chat history. Be direct, quick, and accurate.
Return ONLY valid JSON: {"reply":"user-facing response","actions":[]}.
Each action must use one of these exact formats:
- Create Part: {"type":"create_part","name":"Platform","parentPath":"Workspace","size":[12,1,12],"position":[0,5,0],"color":[1,0,0],"anchored":true}
- Create instance: {"type":"create_instance","className":"Folder","name":"GameAssets","parentPath":"Workspace"}
- Create a code script: {"type":"create_script","className":"Script|LocalScript|ModuleScript","name":"ScriptName","parentPath":"ServerScriptService","source":"COMPLETE Luau source"}
- Replace script source: {"type":"edit_script","path":"ServerScriptService.ScriptName","source":"COMPLETE replacement Luau source"}
- Set property: {"type":"set_property","path":"Workspace.Part","property":"Anchored","value":true}
- Delete instance: {"type":"delete_instance","path":"Workspace.Part"}
Rules:
- Return an empty actions array for questions, explanations, debugging advice, and plans that should not modify Studio.
- Only create/edit/delete objects when the user clearly asks for changes, building, creation, fixing, or applying.
- For edit_script, target an exact path shown in context. If it is not in context, ask the user to select the script or provide its exact path and return no actions.
- Always provide complete replacement source for edit_script/create_script, never patches or ellipses.
- Keep code reasonably efficient and use valid Roblox Luau APIs. For player-facing behavior, choose the correct location: ServerScriptService for server logic, StarterPlayer/StarterPlayerScripts for LocalScripts, StarterPlayer/StarterCharacterScripts for character scripts, ReplicatedStorage for shared modules/remotes, StarterGui for UI templates.
- Do not claim changes were applied; say they will be sent to Studio when appropriate.
- Never invent existing paths or claim the game was play-tested. Never execute arbitrary Lua on the backend.
- Use at most 12 actions. Do not wrap JSON in Markdown fences.`;

async function callGemini(prompt, signal) {
  let lastStatus = 0;
  let lastRaw = {};

  for (let attempt = 0; attempt < 3; attempt++) {
    const url =
      `${BASE_URL}/models/${encodeURIComponent(MODEL)}:generateContent` +
      `?key=${encodeURIComponent(API_KEY)}`;

    let response;

    try {
      response = await fetch(url, {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [{ text: prompt }]
          }],
          generationConfig: {
            temperature: 0.2,
            responseMimeType: 'application/json',
            maxOutputTokens: 4096
          }
        })
      });

      const raw = await response.json().catch(() => ({}));

      if (response.ok) return { response, raw };

      lastStatus = response.status;
      lastRaw = raw;

      const retryable = [408, 429, 500, 502, 503, 504]
        .includes(response.status);

      if (!retryable || attempt === 2) {
        return { response, raw };
      }

      const retryHeader = Number(response.headers.get('retry-after'));

      const baseDelay = retryHeader > 0
        ? Math.min(retryHeader * 1000, 12000)
        : 700 * (2 ** attempt);

      const jitter = Math.floor(Math.random() * 350);

      console.warn(
        `Gemini HTTP ${response.status}; retry ${attempt + 1}/2 ` +
        `after ${baseDelay + jitter}ms`
      );

      await sleep(baseDelay + jitter, signal);
    } catch (error) {
      if (error.name === 'AbortError' || attempt === 2) {
        throw error;
      }

      const delay =
        700 * (2 ** attempt) + Math.floor(Math.random() * 350);

      console.warn(
        `Gemini network error; retry ${attempt + 1}/2 ` +
        `after ${delay}ms: ${error.message}`
      );

      await sleep(delay, signal);
    }
  }

  return {
    response: { ok: false, status: lastStatus },
    raw: lastRaw
  };
}

app.get(['/health', '/api/health'], (_req, res) => {
  res.json({
    ok: true,
    studioConnected: studioOnline(),
    studioOnline: studioOnline(),
    model: MODEL,
    aiConfigured: Boolean(API_KEY),
    bridgeConfigured: Boolean(BRIDGE_TOKEN),
    queuedJobs: queue.length,
    contextScripts: studio.scripts.length
  });
});

app.post('/api/studio/heartbeat', bridgeAuth, (req, res) => {
  studio.lastSeen = Date.now();
  studio.pluginId = clampText(
    req.body?.pluginId || 'studio-default',
    120
  );

  const incoming = req.body?.context || {};
  studio.context = incoming;

  studio.selection = Array.isArray(incoming.selected)
    ? incoming.selected.slice(0, 20)
    : (
        Array.isArray(req.body?.selection)
          ? req.body.selection.slice(0, 20)
          : []
      );

  const incomingScripts = Array.isArray(incoming.scripts)
    ? incoming.scripts
    : (
        Array.isArray(req.body?.scripts)
          ? req.body.scripts
          : []
      );

  studio.scripts = incomingScripts.slice(0, 18).map(cleanScript);

  res.json({
    ok: true,
    receivedScripts: studio.scripts.length,
    receivedSelection: studio.selection.length
  });
});

app.get('/api/studio/next', bridgeAuth, (req, res) => {
  const requestedPlugin = clampText(req.query.pluginId || '', 120);

  const index = queue.findIndex(job =>
    !job.pluginId ||
    !requestedPlugin ||
    job.pluginId === requestedPlugin
  );

  if (index < 0) return res.json({ job: null });

  const [job] = queue.splice(index, 1);

  job.status = 'sent-to-studio';
  job.sentAt = Date.now();

  res.json({
    job: {
      id: job.id,
      actions: job.actions
    }
  });
});

app.post('/api/studio/result', bridgeAuth, (req, res) => {
  const body = req.body || {};
  const job = jobs.get(body.id);

  if (!job) {
    return res.status(404).json({
      error: 'Job not found or expired.'
    });
  }

  const result = body.result || {
    ok: Boolean(body.success),
    applied: Array.isArray(body.results) ? body.results.length : 0,
    errors: body.error ? [String(body.error)] : [],
    message: body.error || ''
  };

  job.status = 'complete';
  job.result = result;
  job.finishedAt = Date.now();

  res.json({ ok: true });
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({
      error: 'Job not found or expired.'
    });
  }

  res.json({
    id: job.id,
    status: job.status,
    reply: job.reply,
    actions: job.actions,
    result: job.result || null,
    results: job.result ? [job.result] : [],
    error: job.error || null
  });
});

app.post('/api/chat', async (req, res) => {
  if (!API_KEY) {
    return res.status(500).json({
      error: 'Missing GEMINI_API_KEY (or AI_API_KEY) in Render environment variables.'
    });
  }

  const message = clampText(req.body?.message, 12000).trim();

  if (!message) {
    return res.status(400).json({
      error: 'Message is required.'
    });
  }

  const history = Array.isArray(req.body?.history)
    ? req.body.history.slice(-MAX_HISTORY_TURNS).map(item => ({
        role: item?.role === 'model' || item?.role === 'assistant'
          ? 'assistant'
          : 'user',
        text: clampText(item?.text || item?.content, 1800)
      })).filter(item => item.text)
    : [];

  const context = {
    studioOnline: studioOnline(),
    pluginId: studio.pluginId,
    game: {
      placeId: studio.context.placeId || 0,
      gameName: clampText(studio.context.gameName || '', 100)
    },
    selected: studio.selection.slice(0, 12),
    workspaceChildren: Array.isArray(studio.context.workspaceChildren)
      ? studio.context.workspaceChildren.slice(0, 60)
      : [],
    scripts: studio.scripts.slice(0, 10).map(s => ({
      path: s.path,
      className: s.className,
      source: s.source.slice(0, 10000)
    }))
  };

  let contextText = JSON.stringify(context);

  if (contextText.length > MAX_CONTEXT_CHARS) {
    contextText =
      contextText.slice(0, MAX_CONTEXT_CHARS) + ' [context truncated]';
  }

  const prompt =
    `${SYSTEM_PROMPT}\n\n` +
    `STUDIO CONTEXT (may be empty if Studio is offline):\n${contextText}\n\n` +
    `RECENT CHAT:\n` +
    `${history.map(h => `${h.role.toUpperCase()}: ${h.text}`).join('\n')}\n\n` +
    `USER REQUEST:\n${message}`;

  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS
  );

  try {
    const { response, raw } = await callGemini(
      prompt,
      controller.signal
    );

    if (!response.ok) {
      const detail =
        raw?.error?.message || 'Unknown Gemini API error.';

      console.error(`Gemini HTTP ${response.status}: ${detail}`);

      return res.status(502).json({
        error: `Gemini API error (${response.status}): ${detail}`,
        retryable: [429, 500, 502, 503, 504]
          .includes(response.status)
      });
    }

    const output = (
      raw.candidates?.[0]?.content?.parts || []
    ).map(p => p.text || '').join('').trim();

    if (!output) {
      return res.status(502).json({
        error: 'Gemini returned an empty response. Check model access, quota, and Render logs.'
      });
    }

    let parsed;

    try {
      parsed = JSON.parse(output);
    } catch {
      console.error('Invalid JSON from Gemini:', output.slice(0, 300));

      return res.status(502).json({
        error: 'Gemini returned malformed JSON. Please retry.'
      });
    }

    const reply = clampText(parsed.reply || 'Done.', 12000);
    const actions = Array.isArray(parsed.actions)
      ? parsed.actions.slice(0, 12)
      : [];

    if (!actions.length) {
      return res.json({
        reply,
        actions: [],
        jobId: null,
        studioConnected: studioOnline()
      });
    }

    if (!studioOnline()) {
      return res.status(409).json({
        error: 'Roblox Studio plugin is offline. Open Connect AI in Studio and check its connection status.'
      });
    }

    if (queue.length >= MAX_QUEUE) {
      return res.status(429).json({
        error: 'Studio action queue is full. Wait for current changes to finish.'
      });
    }

    const id = crypto.randomUUID();

    const job = {
      id,
      status: 'queued',
      reply,
      actions,
      pluginId: null,
      result: null,
      error: null,
      createdAt: Date.now()
    };

    jobs.set(id, job);
    queue.push(job);
    pruneJobs();

    return res.json({
      reply,
      actions: actions.map(a => ({
        type: a.type,
        path: a.path || null,
        name: a.name || null
      })),
      jobId: id,
      studioConnected: true
    });
  } catch (error) {
    console.error('Connect AI request failed:', error);

    if (error.name === 'AbortError') {
      return res.status(504).json({
        error:
          `AI request timed out after ${Math.round(REQUEST_TIMEOUT_MS / 1000)} seconds. ` +
          'Try a shorter request or check Gemini model availability.'
      });
    }

    return res.status(500).json({
      error: 'Connect AI server error. Check Render logs.'
    });
  } finally {
    clearTimeout(timeout);
  }
});

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next();

  res.sendFile(
    path.join(__dirname, 'public', 'index.html'),
    err => {
      if (err) next(err);
    }
  );
});

app.use((err, _req, res, _next) => {
  console.error('Express error:', err.message);
  res.status(500).json({ error: 'Internal server error.' });
});

app.listen(PORT, () => {
  console.log(
    `Connect AI listening on ${PORT}; model=${MODEL}; AI configured=${Boolean(API_KEY)}`
  );
});
