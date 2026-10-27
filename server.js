
// Connect AI — Roblox Studio Backend
// Node.js 20+ | npm dependencies: express, cors

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '3mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = Number(process.env.PORT) || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const CONNECT_AI_TOKEN = process.env.CONNECT_AI_TOKEN || '';
const GEMINI_TIMEOUT_MS = 90000;
const MAX_QUEUE = 30;
const MAX_JOBS = 200;
const MAX_CONTEXT_SCRIPTS = 8;
const MAX_SOURCE_CHARS = 6000;

const studio = { lastSeen: 0, context: {}, scripts: [], selection: [] };
const jobs = new Map();
const queue = [];

function studioIsOnline() {
  return Date.now() - studio.lastSeen < 15000;
}

function authorized(req) {
  if (!CONNECT_AI_TOKEN) return true;
  const supplied = req.get('x-connect-token') || req.body?.token || '';
  return supplied === CONNECT_AI_TOKEN;
}

function requireStudioAuth(req, res, next) {
  if (!authorized(req)) {
    return res.status(401).json({ error: 'Invalid Connect AI plugin token.' });
  }
  next();
}

function cleanScript(script) {
  return {
    path: String(script?.path || '').slice(0, 300),
    className: String(script?.className || '').slice(0, 40),
    source: String(script?.source || '').slice(0, 10000),
  };
}

function getRelevantContext(message) {
  const lower = String(message || '').toLowerCase();
  const selectedPaths = new Set(
    (studio.selection || []).map(x => String(x.path || ''))
  );
  const words = lower.match(/[a-z0-9_]+/g) || [];

  const ranked = studio.scripts.map(script => {
    const scriptPath = String(script.path || '');
    const pathLower = scriptPath.toLowerCase();
    const name = pathLower.split('.').pop();
    let score = selectedPaths.has(scriptPath) ? 100 : 0;

    if (name.includes('basemanager')) score += 20;
    if (name.includes('main')) score += 5;

    for (const word of words) {
      if (word.length >= 4 && pathLower.includes(word)) score += 8;
    }

    if (
      lower.includes('server') &&
      pathLower.includes('serverscriptservice')
    ) {
      score += 4;
    }

    if (
      (
        lower.includes('local script') ||
        lower.includes('client') ||
        lower.includes('starterplayerscripts')
      ) &&
      pathLower.includes('starterplayerscripts')
    ) {
      score += 4;
    }

    return { script, score };
  });

  ranked.sort((a, b) => b.score - a.score);

  return {
    studioOnline: studioIsOnline(),
    explorer: studio.context,
    selection: studio.selection,
    scripts: ranked.slice(0, MAX_CONTEXT_SCRIPTS).map(({ script }) => ({
      path: script.path,
      className: script.className,
      source: String(script.source || '').slice(0, MAX_SOURCE_CHARS),
    })),
  };
}

function pruneJobs() {
  if (jobs.size <= MAX_JOBS) return;

  for (const [id, job] of jobs) {
    if (job.status === 'completed' || job.status === 'failed') {
      jobs.delete(id);
    }

    if (jobs.size <= Math.floor(MAX_JOBS * 0.75)) break;
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      const error = new Error('Request timed out.');
      error.name = 'AbortError';
      reject(error);
      return;
    }

    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timer);

      const error = new Error('Request timed out.');
      error.name = 'AbortError';
      reject(error);
    }

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// Retry temporary Gemini errors up to two additional times.
async function requestGemini(prompt, signal) {
  let response;
  let raw = {};

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [
              {
                role: 'user',
                parts: [{ text: prompt }],
              },
            ],
            generationConfig: {
              temperature: 0.2,
              responseMimeType: 'application/json',
            },
          }),
          signal,
        }
      );

      raw = await response.json().catch(() => ({}));

      const retryable = [408, 429, 500, 502, 503, 504]
        .includes(response.status);

      if (response.ok || !retryable || attempt === 2) {
        return { response, raw };
      }

      const delay = 1500 * (2 ** attempt);

      console.warn(
        `Gemini returned ${response.status}. Retry ${attempt + 1}/2 in ${delay}ms.`
      );

      await sleep(delay, signal);
    } catch (error) {
      if (error.name === 'AbortError' || attempt === 2) {
        throw error;
      }

      const delay = 1500 * (2 ** attempt);

      console.warn(
        `Gemini request failed. Retry ${attempt + 1}/2 in ${delay}ms: ${error.message}`
      );

      await sleep(delay, signal);
    }
  }

  return { response, raw };
}

const SYSTEM_PROMPT = `You are Connect AI, an expert Roblox Studio and Luau coding assistant.
Use the supplied live Studio context. Be accurate and concise.
Return ONLY valid JSON with this shape:
{"reply":"Brief explanation","actions":[]}

Supported actions:
1. Edit script: {"type":"edit_script","path":"ServerScriptService.BaseManager","source":"COMPLETE replacement Luau source"}
2. Create part: {"type":"create_part","name":"PartName","parent":"Workspace","properties":{"Anchored":true,"Size":[4,1,4],"Position":[0,5,0],"Color":[1,0,0]}}
3. Set property: {"type":"set_property","path":"Workspace.Part","property":"Anchored","value":true}
4. Create instance: {"type":"create_instance","className":"Folder","name":"FolderName","parent":"ServerScriptService"}
5. Delete instance: {"type":"delete_instance","path":"Workspace.Part"}

Rules:
- For script edits, use an exact script path present in context.
- Return full replacement source, never partial code or patch instructions.
- Preserve unrelated functionality and use valid Roblox Luau APIs.
- Never invent RemoteEvents, modules, paths, or objects.
- Do not create duplicate systems unnecessarily.
- If the target script is missing, ask the user to select it or refresh context and return no actions.
- Only make requested changes. Do not claim the plugin applied changes; it reports actual results.
- Do not wrap the JSON response in Markdown fences.`;

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    studioOnline: studioIsOnline(),
    model: GEMINI_MODEL,
    queuedJobs: queue.length,
  });
});

app.post('/api/studio/heartbeat', requireStudioAuth, (req, res) => {
  studio.lastSeen = Date.now();
  studio.context = req.body?.context || {};

  studio.selection = Array.isArray(req.body?.selection)
    ? req.body.selection.slice(0, 30)
    : [];

  studio.scripts = Array.isArray(req.body?.scripts)
    ? req.body.scripts.slice(0, 35).map(cleanScript)
    : [];

  res.json({
    ok: true,
    receivedScripts: studio.scripts.length,
    receivedSelection: studio.selection.length,
  });
});

app.get('/api/studio/next', requireStudioAuth, (_req, res) => {
  const job = queue.shift() || null;

  res.json({
    job: job ? { id: job.id, actions: job.actions } : null,
  });
});

app.post('/api/studio/result', requireStudioAuth, (req, res) => {
  const { id, success, results, error } = req.body || {};
  const job = jobs.get(id);

  if (!job) {
    return res.status(404).json({ error: 'Job not found.' });
  }

  job.status = success ? 'completed' : 'failed';
  job.results = Array.isArray(results) ? results : [];
  job.error = error || null;
  job.finishedAt = Date.now();

  res.json({ ok: true });
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({ error: 'Job not found.' });
  }

  res.json({
    id: job.id,
    status: job.status,
    reply: job.reply,
    actions: job.actions,
    results: job.results || [],
    error: job.error || null,
  });
});

app.post('/api/chat', async (req, res) => {
  if (!GEMINI_API_KEY) {
    return res.status(500).json({
      error: 'GEMINI_API_KEY is missing in Render environment variables.',
    });
  }

  const message = String(req.body?.message || '').trim();

  if (!message) {
    return res.status(400).json({
      error: 'Message is required.',
    });
  }

  if (message.length > 12000) {
    return res.status(400).json({
      error: 'Message is too long. Please shorten your request.',
    });
  }

  const online = studioIsOnline();
  const context = getRelevantContext(message);

  const prompt = [
    SYSTEM_PROMPT,
    '\nLIVE ROBLOX STUDIO CONTEXT:',
    JSON.stringify(context),
    '\nUSER REQUEST:',
    message,
  ].join('\n');

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    GEMINI_TIMEOUT_MS
  );

  try {
    const { response, raw } = await requestGemini(
      prompt,
      controller.signal
    );

    if (!response.ok) {
      const detail =
        raw.error?.message || 'Unknown Gemini API error.';

      console.error(
        'Gemini API error:',
        response.status,
        detail
      );

      return res.status(502).json({
        error: `Gemini API error (${response.status}): ${detail}`,
      });
    }

    const outputText = (
      raw.candidates?.[0]?.content?.parts || []
    )
      .map(part => part.text || '')
      .join('')
      .trim();

    if (!outputText) {
      return res.status(502).json({
        error: 'Gemini returned an empty response. Check model access and API quota.',
      });
    }

    let parsed;

    try {
      parsed = JSON.parse(outputText);
    } catch {
      console.error(
        'Gemini returned invalid JSON:',
        outputText.slice(0, 500)
      );

      return res.status(502).json({
        error: 'Gemini returned invalid JSON. Try again or use a model that supports JSON output.',
      });
    }

    const reply = String(parsed.reply || 'Request processed.');
    const actions = Array.isArray(parsed.actions)
      ? parsed.actions.slice(0, 15)
      : [];

    if (actions.length && !online) {
      return res.status(409).json({
        error: 'Roblox Studio plugin is offline. Open Connect AI in Studio and try again.',
      });
    }

    if (!actions.length) {
      return res.json({
        reply,
        actions: [],
        jobId: null,
      });
    }

    if (queue.length >= MAX_QUEUE) {
      return res.status(429).json({
        error: 'The Studio edit queue is full. Wait for pending changes to finish.',
      });
    }

    const id = crypto.randomUUID();

    const job = {
      id,
      status: 'queued',
      reply,
      actions,
      results: [],
      error: null,
      createdAt: Date.now(),
    };

    jobs.set(id, job);
    queue.push(job);
    pruneJobs();

    return res.json({
      reply,
      actions: actions.map(action => ({
        type: action.type,
        path: action.path || null,
        name: action.name || null,
      })),
      jobId: id,
    });
  } catch (error) {
    console.error('Connect AI request failed:', error);

    if (error.name === 'AbortError') {
      return res.status(504).json({
        error: 'Gemini timed out after 90 seconds. Check model availability, API quota, and Render logs.',
      });
    }

    return res.status(500).json({
      error: 'Connect AI server error. Check Render logs for details.',
    });
  } finally {
    clearTimeout(timeout);
  }
});

// Serve the frontend without Express wildcard-route issues.
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next();

  res.sendFile(
    path.join(__dirname, 'public', 'index.html'),
    error => {
      if (error) next(error);
    }
  );
});

app.use((err, _req, res, _next) => {
  console.error('Express error:', err.message);
  res.status(500).json({ error: 'Internal server error.' });
});

app.listen(PORT, () => {
  console.log(`Connect AI listening on port ${PORT}`);
  console.log(`Configured Gemini model: ${GEMINI_MODEL}`);
});
