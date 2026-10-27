```js
// Connect AI — Optimized Roblox Studio Backend
// Node.js 20+
// Required packages: express, cors

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

const GEMINI_TIMEOUT_MS = 90000;
const MAX_QUEUE = 30;
const MAX_JOBS = 200;
const MAX_CONTEXT_SCRIPTS = 8;
const MAX_SOURCE_CHARS = 6000;

let studio = {
    lastSeen: 0,
    context: {},
    scripts: [],
    selection: [],
};

const jobs = new Map();
const queue = [];

function studioIsOnline() {
    return Date.now() - studio.lastSeen < 15000;
}

function authorized(req) {
    if (!CONNECT_AI_TOKEN) {
        return true;
    }

    const supplied =
        req.headers["x-connect-token"] ||
        req.body?.token ||
        "";

    return supplied === CONNECT_AI_TOKEN;
}

function requireStudioAuth(req, res, next) {
    if (!authorized(req)) {
        return res.status(401).json({
            error: "Invalid Connect AI plugin token.",
        });
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

function getRelevantContext(message) {
    const messageLower = String(message || "").toLowerCase();

    const selectedPaths = new Set(
        (studio.selection || [])
            .map(item => String(item.path || ""))
    );

    const words = messageLower.match(/[a-z0-9_]+/g) || [];

    const rankedScripts = (studio.scripts || []).map(script => {
        const scriptPath = String(script.path || "");
        const pathLower = scriptPath.toLowerCase();
        const name = pathLower.split(".").pop();

        let score = 0;

        if (selectedPaths.has(scriptPath)) {
            score += 100;
        }

        if (name.includes("basemanager")) {
            score += 20;
        }

        if (name.includes("main")) {
            score += 5;
        }

        for (const word of words) {
            if (word.length < 4) {
                continue;
            }

            if (pathLower.includes(word)) {
                score += 8;
            }
        }

        // Favor likely Roblox gameplay scripts when the request
        // is about servers, clients, or player scripts.
        if (
            messageLower.includes("server") &&
            pathLower.includes("serverscriptservice")
        ) {
            score += 4;
        }

        if (
            (
                messageLower.includes("local script") ||
                messageLower.includes("client") ||
                messageLower.includes("starterplayerscripts")
            ) &&
            pathLower.includes("starterplayerscripts")
        ) {
            score += 4;
        }

        return {
            script,
            score,
        };
    });

    rankedScripts.sort((a, b) => b.score - a.score);

    const selectedScripts = rankedScripts
        .slice(0, MAX_CONTEXT_SCRIPTS)
        .map(({ script }) => ({
            path: script.path,
            className: script.className,
            source: String(script.source || "")
                .slice(0, MAX_SOURCE_CHARS),
        }));

    return {
        studioOnline: studioIsOnline(),
        explorer: studio.context,
        selection: studio.selection,
        scripts: selectedScripts,
    };
}

function cleanOldJobs() {
    if (jobs.size <= MAX_JOBS) {
        return;
    }

    for (const [id, job] of jobs) {
        if (
            job.status === "completed" ||
            job.status === "failed"
        ) {
            jobs.delete(id);
        }

        if (jobs.size <= MAX_JOBS * 0.75) {
            break;
        }
    }
}

const SYSTEM_PROMPT = `
You are Connect AI, a skilled Roblox Studio and Luau assistant.

Understand the user's request using the live Roblox Studio context.
Be concise, accurate, and focused on making the requested changes.

Return ONLY valid JSON in this exact format:
{
  "reply": "Brief explanation",
  "actions": []
}

Supported actions:

1. Edit an existing script:
{
  "type": "edit_script",
  "path": "ServerScriptService.BaseManager",
  "source": "Complete replacement Luau source code"
}

2. Create a part:
{
  "type": "create_part",
  "name": "ExamplePart",
  "parent": "Workspace",
  "properties": {
    "Anchored": true,
    "Size": [4, 1, 4],
    "Position": [0, 5, 0],
    "Color": [1, 0, 0]
  }
}

3. Change a property:
{
  "type": "set_property",
  "path": "Workspace.Part",
  "property": "Anchored",
  "value": true
}

4. Create an instance:
{
  "type": "create_instance",
  "className": "Folder",
  "name": "ExampleFolder",
  "parent": "ServerScriptService"
}

5. Delete an instance:
{
  "type": "delete_instance",
  "path": "Workspace.ExamplePart"
}

IMPORTANT RULES:

- For script edits, use an exact path supplied in the context.
- Return the COMPLETE replacement source, never a partial patch.
- Never invent script paths, RemoteEvents, modules, or objects.
- Preserve unrelated existing functionality.
- Follow Roblox Luau conventions and use valid Roblox APIs.
- Do not create duplicate systems unnecessarily.
- If the correct target script is not in context, ask the user to select it
  or refresh the Studio context. Do not guess a path.
- If essential information is missing, ask a concise question and return
  an empty actions array.
- Only make changes the user requested.
- Never claim that Studio applied an edit. The plugin reports the actual result.
- Do not put Markdown fences around the JSON response.
`;

app.get("/health", (_req, res) => {
    res.json({
        ok: true,
        studioOnline: studioIsOnline(),
        model: GEMINI_MODEL,
        queuedJobs: queue.length,
    });
});

// Receive the live Studio context from the plugin.
app.post(
    "/api/studio/heartbeat",
    requireStudioAuth,
    (req, res) => {
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
    }
);

// The plugin polls this endpoint for pending jobs.
app.get(
    "/api/studio/next",
    requireStudioAuth,
    (_req, res) => {
        const job = queue.shift() || null;

        res.json({
            job: job
                ? {
                    id: job.id,
                    actions: job.actions,
                }
                : null,
        });
    }
);

// Receive the real execution results from Studio.
app.post(
    "/api/studio/result",
    requireStudioAuth,
    (req, res) => {
        const { id, success, results, error } = req.body || {};
        const job = jobs.get(id);

        if (!job) {
            return res.status(404).json({
                error: "Job not found.",
            });
        }

        job.status = success ? "completed" : "failed";
        job.results = Array.isArray(results)
            ? results
            : [];
        job.error = error || null;
        job.finishedAt = Date.now();

        res.json({ ok: true });
    }
);

// The website polls this endpoint for job status.
app.get("/api/jobs/:id", (req, res) => {
    const job = jobs.get(req.params.id);

    if (!job) {
        return res.status(404).json({
            error: "Job not found.",
        });
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

app.post("/api/chat", async (req, res) => {
    try {
        if (!GEMINI_API_KEY) {
            return res.status(500).json({
                error:
                    "GEMINI_API_KEY is missing in Render environment variables.",
            });
        }

        const message = String(req.body?.message || "").trim();

        if (!message) {
            return res.status(400).json({
                error: "Message is required.",
            });
        }

        if (message.length > 12000) {
            return res.status(400).json({
                error: "Message is too long. Please shorten your request.",
            });
        }

        const online = studioIsOnline();
        const context = getRelevantContext(message);

        const prompt = [
            SYSTEM_PROMPT,
            "",
            "LIVE ROBLOX STUDIO CONTEXT:",
            JSON.stringify(context),
            "",
            "USER REQUEST:",
            message,
        ].join("\n");

        const controller = new AbortController();

        const timeout = setTimeout(() => {
            controller.abort();
        }, GEMINI_TIMEOUT_MS);

        let geminiResponse;

        try {
            geminiResponse = await fetch(
                "https://generativelanguage.googleapis.com/v1beta/models/" +
                    encodeURIComponent(GEMINI_MODEL) +
                    ":generateContent?key=" +
                    encodeURIComponent(GEMINI_API_KEY),
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                        contents: [
                            {
                                role: "user",
                                parts: [{ text: prompt }],
                            },
                        ],
                        generationConfig: {
                            temperature: 0.2,
                            responseMimeType: "application/json",
                        },
                    }),
                    signal: controller.signal,
                }
            );
        } finally {
            clearTimeout(timeout);
        }

        const raw = await geminiResponse.json().catch(() => ({}));

        if (!geminiResponse.ok) {
            console.error(
                "Gemini API error:",
                geminiResponse.status,
                raw.error?.message || "Unknown API error"
            );

            return res.status(502).json({
                error:
                    "Gemini API error (" +
                    geminiResponse.status +
                    "): " +
                    (
                        raw.error?.message ||
                        "Check the model name and API key."
                    ),
            });
        }

        const outputText = (
            raw.candidates?.[0]?.content?.parts || []
        )
            .map(part => part.text || "")
            .join("")
            .trim();

        if (!outputText) {
            return res.status(502).json({
                error:
                    "Gemini returned an empty response. Please try again.",
            });
        }

        let parsed;

        try {
            parsed = JSON.parse(outputText);
        } catch (error) {
            console.error("Invalid Gemini JSON:", outputText.slice(0, 500));

            return res.status(502).json({
                error:
                    "Gemini returned an invalid response. Try a more specific request.",
            });
        }

        const reply = String(
            parsed.reply || "Request processed."
        );

        const actions = Array.isArray(parsed.actions)
            ? parsed.actions.slice(0, 15)
            : [];

        if (actions.length > 0 && !online) {
            return res.status(409).json({
                error:
                    "Roblox Studio plugin is offline. Open Connect AI in Studio and try again.",
            });
        }

        if (actions.length === 0) {
            return res.json({
                reply,
                actions: [],
                jobId: null,
            });
        }

        if (queue.length >= MAX_QUEUE) {
            return res.status(429).json({
                error:
                    "The Studio edit queue is full. Wait for pending changes to finish.",
            });
        }

        const id = crypto.randomUUID();

        const job = {
            id,
            status: "queued",
            reply,
            actions,
            results: [],
            error: null,
            createdAt: Date.now(),
        };

        jobs.set(id, job);
        queue.push(job);

        cleanOldJobs();

        res.json({
            reply,
            actions: actions.map(action => ({
                type: action.type,
                path: action.path || null,
                name: action.name || null,
            })),
            jobId: id,
        });
    } catch (error) {
        console.error("Connect AI request failed:", error);

        if (error.name === "AbortError") {
            return res.status(504).json({
                error:
                    "Gemini timed out after 90 seconds. Check your model availability, API quota, and Render logs.",
            });
        }

        res.status(500).json({
            error:
                "Connect AI server error. Check the Render logs for details.",
        });
    }
});

// Serve the website without Express 5 wildcard-route issues.
app.use((req, res, next) => {
    if (req.path.startsWith("/api/")) {
        return next();
    }

    res.sendFile(
        path.join(__dirname, "public", "index.html"),
        error => {
            if (error) next(error);
        }
    );
});

app.use((err, _req, res, _next) => {
    console.error("Express error:", err.message);

    res.status(500).json({
        error: "Internal server error.",
    });
});

app.listen(PORT, () => {
    console.log("Connect AI listening on port " + PORT);
    console.log("Configured Gemini model: " + GEMINI_MODEL);
});
```
