const http = require("http");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 10000);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const GEMINI_API_BASE =
  "https://generativelanguage.googleapis.com/v1beta";

const MAX_BODY_BYTES = 5 * 1024 * 1024;

function sendJson(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);

  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    ...extraHeaders,
  });

  res.end(body);
}

function sendError(res, status, message, source = "backend") {
  return sendJson(res, status, {
    error: {
      message,
      source,
    },
  });
}

function corsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    ...extra,
  };
}

function normalizeModel(model) {
  if (typeof model !== "string") return "";
  return model.trim().replace(/^models\//, "");
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;

    req.on("data", (chunk) => {
      size += chunk.length;

      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body is too large."));
        req.destroy();
        return;
      }

      data += chunk;
    });

    req.on("end", () => {
      if (!data) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("Invalid JSON request body."));
      }
    });

    req.on("error", reject);
  });
}

function buildGeminiRequest(body) {
  const model = normalizeModel(body.model);

  if (!model) {
    throw new Error("Missing Gemini model.");
  }

  if (!Array.isArray(body.contents)) {
    throw new Error("Missing or invalid Gemini contents.");
  }

  const request = {
    contents: body.contents,
  };

  /*
   * The frontend uses "system" in its backend contract.
   * Gemini's REST API expects this as "systemInstruction".
   */
  if (body.system) {
    if (typeof body.system === "string") {
      request.systemInstruction = {
        parts: [{ text: body.system }],
      };
    } else if (typeof body.system === "object") {
      request.systemInstruction = body.system;
    }
  }

  if (body.generationConfig && typeof body.generationConfig === "object") {
    request.generationConfig = body.generationConfig;
  }

  /*
   * Preserve additional Gemini-compatible fields if the frontend
   * ever sends them in the future.
   */
  const allowedExtraFields = [
    "safetySettings",
    "tools",
    "toolConfig",
    "cachedContent",
  ];

  for (const field of allowedExtraFields) {
    if (body[field] !== undefined) {
      request[field] = body[field];
    }
  }

  return {
    model,
    request,
  };
}

async function callGemini(model, request) {
  const url =
    `${GEMINI_API_BASE}/models/${encodeURIComponent(model)}` +
    `:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
  });

  const text = await response.text();

  let data;

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {
      error: {
        message: text || `Gemini returned HTTP ${response.status}`,
      },
    };
  }

  return {
    response,
    data,
  };
}

async function streamGemini(model, request, res) {
  const url =
    `${GEMINI_API_BASE}/models/${encodeURIComponent(model)}` +
    `:streamGenerateContent?alt=sse&key=${encodeURIComponent(GEMINI_API_KEY)}`;

  let upstream;

  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(request),
    });
  } catch (error) {
    return sendError(
      res,
      502,
      `Could not reach Gemini: ${error.message}`,
      "gemini"
    );
  }

  /*
   * If Gemini rejects the request, return the normal backend error
   * structure expected by index.html.
   */
  if (!upstream.ok) {
    const text = await upstream.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }

    const message =
      data?.error?.message ||
      text ||
      `Gemini returned HTTP ${upstream.status}`;

    return sendError(res, upstream.status, message, "gemini");
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    ...corsHeaders(),
  });

  /*
   * Pass Gemini's SSE stream directly through to the browser.
   * The index.html already knows how to consume this format.
   */
  try {
    for await (const chunk of upstream.body) {
      if (!res.destroyed) {
        res.write(Buffer.from(chunk));
      }
    }
  } catch (error) {
    if (!res.destroyed) {
      res.write(
        `data: ${JSON.stringify({
          error: {
            message: error.message,
            source: "gemini",
          },
        })}\n\n`
      );
    }
  }

  if (!res.destroyed) {
    res.end();
  }
}

async function handleRequest(req, res) {
  const parsedUrl = new URL(
    req.url,
    `http://${req.headers.host || "localhost"}`
  );

  const path = parsedUrl.pathname;

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  // Health check
  if (req.method === "GET" && path === "/health") {
    return sendJson(res, 200, {
      ok: true,
      service: "meridian-gemini-backend",
    });
  }

  // Gemini model discovery
  if (req.method === "GET" && path === "/models") {
    if (!GEMINI_API_KEY) {
      return sendError(
        res,
        401,
        "GEMINI_API_KEY is not configured on the Render server.",
        "backend"
      );
    }

    try {
      const response = await fetch(
        `${GEMINI_API_BASE}/models?key=${encodeURIComponent(
          GEMINI_API_KEY
        )}`
      );

      const text = await response.text();

      let data;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = {
          error: {
            message: text || `Gemini returned HTTP ${response.status}`,
          },
        };
      }

      if (!response.ok) {
        return sendError(
          res,
          response.status,
          data?.error?.message ||
            `Gemini model discovery failed with HTTP ${response.status}`,
          "gemini"
        );
      }

      return sendJson(res, 200, data);
    } catch (error) {
      return sendError(
        res,
        502,
        `Could not reach Gemini: ${error.message}`,
        "gemini"
      );
    }
  }

  // Normal Gemini generation
  if (req.method === "POST" && path === "/gemini") {
    if (!GEMINI_API_KEY) {
      return sendError(
        res,
        401,
        "GEMINI_API_KEY is not configured on the Render server.",
        "backend"
      );
    }

    let body;

    try {
      body = await readJsonBody(req);
    } catch (error) {
      return sendError(res, 400, error.message, "backend");
    }

    let built;

    try {
      built = buildGeminiRequest(body);
    } catch (error) {
      return sendError(res, 400, error.message, "backend");
    }

    try {
      const result = await callGemini(
        built.model,
        built.request
      );

      if (!result.response.ok) {
        return sendError(
          res,
          result.response.status,
          result.data?.error?.message ||
            `Gemini returned HTTP ${result.response.status}`,
          "gemini"
        );
      }

      return sendJson(res, 200, result.data);
    } catch (error) {
      return sendError(
        res,
        502,
        `Could not reach Gemini: ${error.message}`,
        "gemini"
      );
    }
  }

  // Streaming Gemini generation
  if (req.method === "POST" && path === "/gemini/stream") {
    if (!GEMINI_API_KEY) {
      return sendError(
        res,
        401,
        "GEMINI_API_KEY is not configured on the Render server.",
        "backend"
      );
    }

    let body;

    try {
      body = await readJsonBody(req);
    } catch (error) {
      return sendError(res, 400, error.message, "backend");
    }

    let built;

    try {
      built = buildGeminiRequest(body);
    } catch (error) {
      return sendError(res, 400, error.message, "backend");
    }

    return streamGemini(
      built.model,
      built.request,
      res
    );
  }

  return sendError(
    res,
    404,
    `Unknown endpoint: ${req.method} ${path}`,
    "backend"
  );
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    console.error("Unhandled server error:", error);

    if (!res.headersSent) {
      sendError(
        res,
        500,
        "Internal server error.",
        "backend"
      );
    } else if (!res.destroyed) {
      res.end();
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Meridian Gemini backend listening on port ${PORT}`);
  console.log(
    `Gemini API key configured: ${GEMINI_API_KEY ? "YES" : "NO"}`
  );
});
