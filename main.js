// main.js — Electron main process
// Handles: window setup, IPC for Whisper STT, LLM (Groq), VOICEVOX TTS

require("dotenv").config();
const { app, BrowserWindow, ipcMain, screen, session } = require("electron");
const path = require("path");
const fetch = require("node-fetch");
const FormData = require("form-data");
const fs = require("fs");

function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

// ─── Window ────────────────────────────────────────────────────────────────

let win;

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  win = new BrowserWindow({
    width: 550,
    height: 650,
    // Place on bottom-right of screen by default
    x: width - 570,
    y: height - 670,
    transparent: true,
    frame: false, // no OS title bar / border
    alwaysOnTop: true, // float above other windows
    resizable: false,
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true, // security: isolate renderer context
      nodeIntegration: false, // security: no Node in renderer
    },
  });

  win.loadFile(path.join(__dirname, "renderer", "index.html"));

  // Grant microphone permission automatically — required for voice input in Electron
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media'); // allow mic, deny everything else
  });

  // Handle navigator.permissions.query checks from renderer
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    return permission === 'media';
  });

  // Uncomment to open DevTools during development
win.webContents.openDevTools({ mode: "detach" });
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// ─── IPC: Window drag (frameless window drag support) ──────────────────────

ipcMain.on("window-drag", (_event, { deltaX, deltaY }) => {
  const [x, y] = win.getPosition();
  win.setPosition(x + deltaX, y + deltaY);
});

ipcMain.on("window-close", () => win.close());
ipcMain.on("window-minimize", () => win.minimize());

// ─── IPC: Speech-to-Text via Groq Whisper ──────────────────────────────────

// Renderer sends raw audio ArrayBuffer; main uploads to Groq Whisper API.
ipcMain.handle("whisper-transcribe", async (_event, audioBuffer) => {
  try {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error("GROQ_API_KEY not set in .env");

    // Pass Buffer directly into FormData — no temp file → no disk I/O latency
    const form = new FormData();
    form.append("file", Buffer.from(audioBuffer), {
      filename: "audio.webm",
      contentType: "audio/webm",
    });
    form.append("model", "whisper-large-v3"); // higher accuracy, still fast on Groq
    form.append("language", "id"); // Indonesian
    form.append("response_format", "json");

    const res = await fetch(
      "https://api.groq.com/openai/v1/audio/transcriptions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          ...form.getHeaders(),
        },
        body: form,
      },
    );

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Whisper API error ${res.status}: ${err}`);
    }

    const data = await res.json();
    return { ok: true, text: data.text?.trim() || "" };
  } catch (err) {
    console.error("[Whisper]", err.message);
    return { ok: false, error: err.message };
  }
});

// ─── IPC: LLM chat via Groq (gpt-oss-120b) ────────────────────────────────

// Renderer sends the conversation history array; main calls the Groq chat API.
// API key stays in main process — never exposed to renderer.
ipcMain.handle("llm-chat", async (_event, messages) => {
  try {
    console.log(`[LLM] Request started (${messages.length} messages)`);
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error("GROQ_API_KEY not set in .env");

    const systemPrompt = {
      role: "system",
      content:
        "あなたはNyraという名前の、明るくフレンドリーなアシスタントです。" +
        "必ず日本語だけで返答してください。ユーザーが他の言語で話しかけても、日本語で答えること。" +
        "返答は必ず1〜2文の短い文章にしてください。カジュアルな話し言葉で、堅苦しくしないこと。" +
        "箇条書きやMarkdown形式は使わないこと。" +
        "返答の先頭に必ず [emotion:xxx] タグを付けること。xxx は happy, sad, surprised, neutral, angry のいずれかで、" +
        "形式は [emotion:happy] テキスト のようにすること。",
    };

    const res = await fetchWithTimeout("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "openai/gpt-oss-120b",
        messages: [systemPrompt, ...messages],
        reasoning_effort: "low", 
        max_tokens: 200,
      }),
    }, 15000);
    
    if (res.status === 429) {
      console.warn("[LLM] Rate limited (429)");
      return { ok: true, text: "hmm, aku butuh napas sebentar~", emotion: "neutral" };
    }

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`LLM API error ${res.status}: ${err}`);
    }

    const data = await res.json();

    // Extract only the final answer — skip any reasoning/analysis content
    const raw = data.choices?.[0]?.message?.content ?? "";
    // Some models wrap reasoning in <think>...</think> blocks; strip them
    const answer = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    const emotionMatch = answer.match(/^\[emotion:(happy|sad|surprised|neutral|angry)\]\s*/i);
    const emotion = emotionMatch ? emotionMatch[1].toLowerCase() : "neutral";
    const text = answer.replace(/^\[emotion:(?:happy|sad|surprised|neutral|angry)\]\s*/i, "").trim();

    console.log(`[LLM] Response received (${emotion})`);
    return { ok: true, text, emotion };
  } catch (err) {
    const message = err.name === "AbortError" ? "LLM request timeout (15s)" : err.message;
    console.error("[LLM]", message);
    return { ok: false, error: message };
  }
});

// ─── IPC: Text-to-Speech via VOICEVOX ──────────────────────────────────────

// Two-step VOICEVOX synthesis:
//   1. POST /audio_query  → get query JSON
//   2. POST /synthesis    → get WAV audio buffer
// Returns ArrayBuffer of WAV to renderer; renderer plays it + drives lipsync.
ipcMain.handle("tts-synthesize", async (_event, text) => {
  const VOICEVOX_BASE = "http://localhost:50021";
  const SPEAKER_ID = 1; // change to your preferred VOICEVOX speaker

  try {
    console.log(`[VOICEVOX] Synthesis started (${text.length} chars)`);
    // Step 1: Generate audio query from text
    const queryRes = await fetchWithTimeout(
      `${VOICEVOX_BASE}/audio_query?text=${encodeURIComponent(text)}&speaker=${SPEAKER_ID}`,
      { method: "POST" },
      10000,
    );

    if (!queryRes.ok) {
      throw new Error(`audio_query failed: ${queryRes.status}`);
    }
    const audioQuery = await queryRes.json();

    // Step 2: Synthesize WAV from audio query
    const synthRes = await fetchWithTimeout(
      `${VOICEVOX_BASE}/synthesis?speaker=${SPEAKER_ID}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(audioQuery),
      },
      10000,
    );

    if (!synthRes.ok) {
      throw new Error(`synthesis failed: ${synthRes.status}`);
    }

    const wavBuffer = await synthRes.arrayBuffer();
    console.log("[VOICEVOX] Synthesis completed");
    return { ok: true, audio: wavBuffer };
  } catch (err) {
    // If VOICEVOX isn't running (ECONNREFUSED), log clearly but don't crash
    if (err.code === "ECONNREFUSED" || err.message.includes("ECONNREFUSED")) {
      console.error(
        "[VOICEVOX] Connection refused — pastikan VOICEVOX Engine sudah running di localhost:50021",
      );
      return { ok: false, error: "voicevox_offline" };
    }
    const message = err.name === "AbortError" ? "VOICEVOX request timeout (10s)" : err.message;
    console.error("[VOICEVOX]", message);
    return { ok: false, error: message };
  }
});
