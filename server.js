
'use strict';

const express = require('express');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const CONNECT_AI_TOKEN = process.env.CONNECT_AI_TOKEN;

const sessions = new Map();
const jobs = new Map();
const MAX_JOBS = 200;

function pluginAuth(req, res, next) {
  if (!CONNECT_AI_TOKEN) {
    return res.status(503).json({
      error: 'Server missing CONNECT_AI_TOKEN environment variable.'
    });
  }

  const supplied = (req.headers.authorization || '')
    .replace(/^Bearer\s+/i, '');

  const a = Buffer.from(supplied);
  const b = Buffer.from(CONNECT_AI_TOKEN);

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({
      error: 'Unauthorized plugin. Check CONNECT_AI_TOKEN.'
    });
  }

  next();
}

function clampText(value, max = 20000) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function cleanActions(actions) {
  if (!Array.isArray(actions)) return [];

  const allowed = new Set([
    'create_part',
    'set_property',
    'create_instance',
    'delete_instance'
  ]);

  return actions.slice(0, 30)
    .filter(action => action && allowed.has(action.type))
    .map(action => ({
      type: action.type,
      name: clampText(action.name, 100),
      className: clampText(action.className, 80),
      path: clampText(action.path, 500),
      parentPath: clampText(action.parentPath, 500),
      property: clampText(action.property, 80),
      value: action.value,
      size: action.size,
      position: action.position,
      color: action.color,
      anchored: action.anchored
    }));
}

app.get('/health', (_req, res) => {
  const studioConnected = [...sessions.values()].some(
    session => Date.now() - session.lastSeen < 15000
  );

  res.json({
    ok: true,
    service: 'Connect AI',
    studioConnected
  });
});

// Receives a heartbeat and current context from the Studio plugin.
app.post('/api/studio/heartbeat', pluginAuth, (req, res) => {
  const id = clampText(req.body && req.body.pluginId, 100)
    || 'default-plugin';

  sessions.set(id, {
    lastSeen: Date.now(),
    context: req.body.context || {},
    result: null
  });

  res.json({
    ok: true,
    serverTime: Date.now()
  });
});

// The plugin polls this endpoint for pending edit jobs.
app.get('/api/studio/next', pluginAuth, (req, res) => {
  const id = clampText(req.query.pluginId, 100)
    || 'default-plugin';

  const job = [...jobs.values()].find(
    item => item.status === 'queued'
  );

  if (!job) {
    return res.json({ job: null });
  }

  job.status = 'sent-to-studio';
  job.pluginId = id;

  res.json({
    job: {
      id: job.id,
      actions: job.actions,
      request: job.request
    }
  });
});

// Receives the actual result from the plugin.
app.post('/api/studio/result', pluginAuth, (req, res) => {
  const id = clampText(req.body && req.body.id, 100);
  const job = jobs.get(id);

  if (!job) {
    return res.status(404).json({ error: 'Unknown job.' });
  }

  job.status = 'complete';
  job.result = req.body.result || {
    ok: false,
    message: 'No result returned.'
  };
  job.finishedAt = Date.now();

  res.json({ ok: true });
});

// The website polls this endpoint for job status.
app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({ error: 'Job not found.' });
  }

  res.json({
    id: job.id,
    status: job.status,
    result: job.result || null
  });
});

app.post('/api/chat', async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      return res.status(503).json({
        error: 'Backend is missing GEMINI_API_KEY. Add it in Render Environment.'
      });
    }

    const message = clampText(
      req.body && req.body.message,
      12000
    ).trim();

    if (!message) {
      return res.status(400).json({
        error: 'Please enter a message.'
      });
    }

    const recentSession = [...sessions.values()]
      .filter(session => Date.now() - session.lastSeen < 30000)
      .sort((a, b) => b.lastSeen - a.lastSeen)[0];

    const studioContext = recentSession
      ? recentSession.context
      : {
          connected: false,
          note: 'No active Roblox Studio plugin heartbeat received.'
        };

    const history = Array.isArray(req.body.history)
      ? req.body.history.slice(-12).map(item => ({
          role: item.role === 'model' ? 'model' : 'user',
          parts: [{
            text: clampText(item.text, 4000)
          }]
        }))
      : [];

    const system = `You are Connect AI, a practical Roblox Studio assistant.

Return ONLY valid JSON in this shape:
{"reply":"short natural language response","actions":[]}

Supported actions:

1. Create a part:
{"type":"create_part","name":"PartName","parentPath":"Workspace","size":[4,1,4],"position":[0,5,0],"color":[0.8,0.1,0.1],"anchored":true}

2. Set a property:
{"type":"set_property","path":"Workspace.PartName","property":"Anchored","value":true}

3. Create an instance:
{"type":"create_instance","className":"Folder","name":"FolderName","parentPath":"Workspace"}

4. Delete an instance:
{"type":"delete_instance","path":"Workspace.PartName"}

Use paths shown in the supplied Studio context.
Only use common supported properties such as Name, Anchored,
CanCollide, Transparency, Material, Color, Size, Position,
WalkSpeed, JumpPower, MaxHealth, Health, Text, TextColor3,
BackgroundColor3, Visible, Enabled and Value.

Vector values must be arrays.
Never emit Lua code for execution.
Never claim an edit already happened. Say it was requested and
report success only after the plugin sends a result.
If Studio is disconnected or context is absent, explain that
the plugin must be open and connected.
Ask for clarification before destructive or ambiguous changes.
Do not delete or overwrite scripts unless explicitly requested.

Studio context:
${JSON.stringify(studioContext).slice(0, 24000)}`;

    const contents = [
      ...history,
      {
        role: 'user',
        parts: [{
          text: system + '\n\nUser request: ' + message
        }]
      }
    ];

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          contents,
          generationConfig: {
            temperature: 0.25,
            responseMimeType: 'application/json'
          }
        })
      }
    );

    const payload = await response.json();

    if (!response.ok) {
      return res.status(502).json({
        error: payload.error && payload.error.message
          || `Gemini request failed (${response.status}).`
      });
    }

    const raw = payload.candidates
      && payload.candidates[0]
      && payload.candidates[0].content
      && payload.candidates[0].content.parts
      && payload.candidates[0].content.parts
        .map(part => part.text || '')
        .join('');

    let parsed;

    try {
      parsed = JSON.parse(raw || '{}');
    } catch {
      parsed = {
        reply: raw || 'I could not parse the model response.',
        actions: []
      };
    }

    const actions = cleanActions(parsed.actions);
    let jobId = null;

    if (actions.length) {
      jobId = crypto.randomUUID();

      jobs.set(jobId, {
        id: jobId,
        status: 'queued',
        actions,
        request: message,
        createdAt: Date.now(),
        result: null
      });

      while (jobs.size > MAX_JOBS) {
        jobs.delete(jobs.keys().next().value);
      }
    }

    res.json({
      reply: clampText(parsed.reply, 12000) || 'Done thinking.',
      actions,
      jobId,
      studioConnected: !!recentSession
    });
  } catch (error) {
    console.error('chat error', error);

    res.status(500).json({
      error: 'Unexpected backend error. Check Render logs.'
    });
  }
});

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();

  res.sendFile(
    path.join(__dirname, 'public', 'index.html')
  );
});

app.listen(PORT, () => {
  console.log(`Connect AI listening on ${PORT}`);
});
