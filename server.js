// server.js
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json({ limit: "3mb" }));

app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const CONNECT_AI_TOKEN = process.env.CONNECT_AI_TOKEN || "";

let studio = {
  online: false,
  lastSeen: 0,
  context: {},
  scripts: [],
  selection: [],
};

const jobs = new Map();
const queue = [];
const MAX_QUEUE = 30;

function authorized(req) {
  if (!CONNECT_AI_TOKEN) return true;

  const supplied =
    req.headers["x-connect-token"] ||
    req.body?.token ||
    "";

  return supplied === CONNECT_AI_TOKEN;
}

function requireStudioAuth(req, res, next) {
  if (!authorized(req)) {
    return res.status(401).json({ error: "Invalid plugin token." });
  }
  next();
}

function cleanScript(script) {
  return {
    path: String(script.path || "").slice(0, 300),
    className: String(script.className || "").slice(0, 40),
    source: String(script.source || "").slice(0, 10000),
  };
}

app.get("/health", (_req, res) => {
  const online = Date.now() - studio.lastSeen < 15000;

  res.json({
    ok: true,
    studioOnline: online,
    model: GEMINI_MODEL,
    queuedJobs: queue.length,
  });
});

// The plugin sends its current Explorer/script context.
app.post("/api/studio/heartbeat", requireStudioAuth, (req, res) => {
  studio.online = true;
  studio.lastSeen = Date.now();
  studio.context = req.body.context || {};
  studio.selection = Array.isArray(req.body.selection)
    ? req.body.selection.slice(0, 30)
    : [];

  studio.scripts = Array.isArray(req.body.scripts)
    ? req.body.scripts.slice(0, 35).map(cleanScript)
    : [];

  res.json({
    ok: true,
    receivedScripts: studio.scripts.length,
    receivedSelection: studio.selection.length,
  });
});

// The plugin checks for work.
app.get("/api/studio/next", requireStudioAuth, (_req, res) => {
  const job = queue.shift();
  res.json({ job: job || null });
});

// The plugin reports the real result after executing an edit.
app.post("/api/studio/result", requireStudioAuth, (req, res) => {
  const { id, success, results, error } = req.body || {};
  const job = jobs.get(id);

  if (!job) {
    return res.status(404).json({ error: "Job not found." });
  }

  job.status = success ? "completed" : "failed";
  job.results = Array.isArray(results) ? results : [];
  job.error = error || null;
  job.finishedAt = Date.now();

  res.json({ ok: true });
});

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({ error: "Job not found." });
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

const SYSTEM_PROMPT = `
You are Connect AI, an expert Roblox Studio Luau coding assistant.

Use the provided live Studio context. Prefer editing an existing script when
the user asks to fix or update one. Do not create duplicate scripts unnecessarily.

Return ONLY valid JSON:
{
  "reply": "Short explanation of what you intend to do",
  "actions": [
    {
      "type": "edit_script",
      "path": "ServerScriptService.BaseManager",
      "source": "COMPLETE replacement Luau source"
    }
  ]
}

Supported actions:
1. edit_script: { "type":"edit_script", "path":"exact Explorer path",
                  "source":"complete replacement source" }
2. create_part: { "type":"create_part", "name":"PartName",
                  "parent":"Workspace", "properties": {
                    "Anchored":true, "Size":[4,1,4],
                    "Position":[0,5,0], "Color":[1,0,0]
                  }}
3. set_property: { "type":"set_property", "path":"Workspace.Part",
                   "property":"Anchored", "value":true }
4. create_instance: { "type":"create_instance",
                      "className":"Folder", "name":"FolderName",
                      "parent":"ServerScriptService" }
5. delete_instance: { "type":"delete_instance",
                      "path":"Workspace.Part" }

For edit_script:
- The path MUST match a script supplied in the live context.
- Return the FULL new source, not a partial patch or instructions.
- Preserve unrelated working code and existing conventions.
- Use valid Luau and Roblox APIs.
- Do not invent APIs, remote names, or objects absent from context.
- If required information is missing, ask a short question and return no actions.
- Never claim an edit was applied; the plugin will report the result.
- Make only changes requested by the user.
- Keep the reply concise and prioritize useful edits.
`;

app.post("/api/chat", async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      return res.status(500).json({
        error: "GEMINI_API_KEY is missing in Render environment variables.",
      });
    }

    const message = String(req.body.message || "").trim();
    if (!message) {
      return res.status(400).json({ error: "Message is required." });
    }

    const liveOnline = Date.now() - studio.lastSeen < 15000;

    // Keep context bounded to reduce latency and token usage.
    const context = {
      studioOnline: liveOnline,
      explorer: studio.context,
      selection: studio.selection,
      scripts: studio.scripts.map((s) => ({
        path: s.path,
        className: s.className,
        source: s.source,
      })),
    };

    const prompt = [
      SYSTEM_PROMPT,
      "\nLIVE ROBLOX STUDIO CONTEXT:\n",
      JSON.stringify(context),
      "\nUSER REQUEST:\n",
      message,
    ].join("\n");

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.2,
            responseMimeType: "application/json",
          },
        }),
        signal: AbortSignal.timeout(45000),
      }
    );

    const raw = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: raw.error?.message || "Gemini request failed.",
      });
    }

    const textOutput =
      raw.candidates?.[0]?.content?.parts
        ?.map((part) => part.text || "")
        .join("") || "";

    let parsed;
    try {
      parsed = JSON.parse(textOutput);
    } catch {
      return res.status(502).json({
        error: "AI returned invalid JSON. Try a more specific request.",
        raw: textOutput.slice(0, 1500),
      });
    }

    const actions = Array.isArray(parsed.actions)
      ? parsed.actions.slice(0, 15)
      : [];

    if (!liveOnline && actions.length) {
      return res.status(409).json({
        error: "Roblox Studio plugin is offline. Open the Connect AI plugin first.",
      });
    }

    if (!actions.length) {
      return res.json({
        reply: parsed.reply || "No Studio changes were needed.",
        actions: [],
        jobId: null,
      });
    }

    const id = crypto.randomUUID();

    const job = {
      id,
      status: "queued",
      reply: String(parsed.reply || "Applying your requested changes."),
      actions,
      results: [],
      createdAt: Date.now(),
    };

    jobs.set(id, job);
    queue.push(job);

    // Keep the in-memory job store bounded.
    if (jobs.size > 200) {
      for (const [key, value] of jobs) {
        if (value.status === "completed" || value.status === "failed") {
          jobs.delete(key);
          if (jobs.size <= 150) break;
        }
      }
    }

    res.json({
      reply: job.reply,
      actions: actions.map((a) => ({
        type: a.type,
        path: a.path || null,
        name: a.name || null,
      })),
      jobId: id,
    });
  } catch (error) {
    console.error("Chat error:", error);
    res.status(500).json({
      error: error.name === "TimeoutError"
        ? "AI request timed out. Please try again."
        : "Server error. Check the Render logs.",
    });
  }
});

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Connect AI running on port ${PORT}`);
});
