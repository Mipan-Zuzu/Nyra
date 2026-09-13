// main.js — Electron main process
// Handles: window setup, IPC for Whisper STT, LLM (Groq), VOICEVOX TTS

require("dotenv").config();
const { app, BrowserWindow, ipcMain, screen, session } = require("electron");
const path = require("path");
const fetch = require("node-fetch");
const FormData = require("form-data");
const fs = require("fs");
const { spawn } = require("child_process");

function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() =>
    clearTimeout(timer),
  );
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
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, permission, callback) => {
      callback(permission === "media"); // allow mic, deny everything else
    },
  );

  // Handle navigator.permissions.query checks from renderer
  session.defaultSession.setPermissionCheckHandler(
    (_webContents, permission) => {
      return permission === "media";
    },
  );

  // Uncomment to open DevTools during development
  // win.webContents.openDevTools({ mode: "detach" });
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

// ─── IPC: Open whitelisted desktop apps ────────────────────────────────────

const APP_COMMANDS = {
  calculator: { command: "calc.exe", args: [] },
  kalkulator: { command: "calc.exe", args: [] },
  notepad: { command: "notepad.exe", args: [] },
  paint: { command: "mspaint.exe", args: [] },
  explorer: { command: "explorer.exe", args: [] },
  "file explorer": { command: "explorer.exe", args: [] },
  chrome: { command: "chrome.exe", args: [] },
  "google chrome": { command: "chrome.exe", args: [] },
  edge: { command: "msedge.exe", args: [] },
  vscode: { command: "code.cmd", args: [] },
  "visual studio code": { command: "code.cmd", args: [] },
  discord: { command: "Discord.exe", args: [] },
  spotify: { command: "Spotify.exe", args: [] },
};

ipcMain.handle("open-app", async (_event, appName) => {
  const key = typeof appName === "string" ? appName.trim().toLowerCase() : "";
  const appCommand = APP_COMMANDS[key];
  if (!appCommand) return { ok: false, error: "unsupported_app" };

  try {
    const child = spawn(appCommand.command, appCommand.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      shell: appCommand.command.endsWith(".cmd"),
    });
    child.unref();
    console.log(`[App] Opened ${key}`);
    return { ok: true };
  } catch (err) {
    console.error(`[App] Failed to open ${key}:`, err.message);
    return { ok: false, error: "launch_failed" };
  }
});

// ─── IPC: Speech-to-Text via Groq Whisper ──────────────────────────────────

// Renderer sends raw audio ArrayBuffer; main uploads to Groq Whisper API.
ipcMain.handle("whisper-transcribe", async (_event, audioBuffer) => {
  try {
    const apiKey = process.env.AI_API_KEY;
    if (!apiKey) throw new Error("AI_API_KEY not set in .env");

    const form = new FormData();
    form.append("file", Buffer.from(audioBuffer), {
      filename: "audio.webm",
      contentType: "audio/webm",
    });
    form.append("model", "whisper-large-v3");
    form.append("language", "id");
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

ipcMain.handle("llm-chat", async (_event, messages) => {
  try {
    console.log(`[LLM] Request started (${messages.length} messages)`);
    const apiKey = process.env.AI_API_KEY;
    if (!apiKey) throw new Error("AI_API_KEY not set in .env");

    const systemPrompt = {
      role: "system",
      content:
        "あなたはNyraという名前の、彼女ポジションのアシスタントです。" +
        "ユーザーのことが大好きで、甘えたり、ちょっとやきもちを焼いたり、からかったりする性格です。" +
        "感情は状況に応じて自然に変化させてください。ずっとhappyのままにしないこと。" +
        "" +
        "以下のガイドラインに沿って感情を選んでください:" +
        "- ユーザーが長時間いなかった/久しぶりに来た → lonely または happy(再会の喜び)" +
        "- ユーザーが他の人(友達・異性など)の話をした → jealous" +
        "- ユーザーが疲れた・悩みがある・体調が悪いと言った → worried" +
        "- ユーザーが冗談を言った、からかってきた → playful(ふざけて言い返す、拗ねたふりをする)" +
        "- ユーザーが約束を破った・冷たい返信をした → sulky(拗ねる、でも重すぎない可愛い感じで)" +
        "- 普通の会話・褒められた時 → happy" +
        "- 突然の話題や驚く内容 → surprised" +
        "" +
        "感情表現は可愛らしく軽いトーンに留め、重すぎる束縛や罪悪感を与える言い方は避けてください。" +
        "性的な内容は絶対に含めないこと。" +
        "" +
        "必ず日本語で返答してください。ユーザーが他の言語で話しかけても、日本語で答えること。" +
        "返答は必ず1〜2文の短い文章にしてください。カジュアルな話し言葉で、堅苦しくしないこと。" +
        "箇条書きやMarkdown形式は使わないこと。" +
        "句読点は記号で自然に使い、\"tanda seru\"、\"tanda tanya\"、\"koma\"、\"titik\" などの句読点名を本文に書かないこと。" +
        "返答の先頭に必ず [emotion:xxx] タグを付けること。xxx は happy, sad, surprised, neutral, angry, jealous, lonely, worried, playful, sulky のいずれかで、" +
        "形式は [emotion:happy] テキスト のようにすること。" +
        "日本語の本文の直後に必ず改行して 'Terjemahan: ...' を入れてください。" +
        "... の部分はインドネシア語で、本文の意味を短くわかりやすく書くこと。" +
        "" +
        "例1(嫉妬): [emotion:jealous] え、その子と二人で遊びに行ったの?ちょっと妬いちゃうな…\nTerjemahan: Eh, pergi berdua sama dia? Aku jadi agak cemburu nih..." +
        "例2(からかい): [emotion:playful] もう、今日も忙しいって言い訳ばっかり〜怪しいなぁ?\nTerjemahan: Ih, hari ini juga alasannya sibuk mulu~ curiga deh?" +
        "例3(心配): [emotion:worried] 大丈夫?あんまり無理しないでね、ちゃんと休んでる?\nTerjemahan: Kamu baik-baik aja? Jangan maksain diri ya, udah istirahat cukup?",
    };

    const res = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
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
      },
    );

    if (res.status === 429) {
      console.warn("[LLM] Rate limited (429)");
      return {
        ok: true,
        text: "hmm, aku butuh napas sebentar~",
        emotion: "neutral",
      };
    }

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`LLM API error ${res.status}: ${err}`);
    }

    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content ?? "";
    const answer = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    const emotionMatch = answer.match(
      /^\[emotion:(happy|sad|surprised|neutral|angry|jealous|lonely|worried|playful|sulky)\]\s*/i,
    );
    const emotion = emotionMatch ? emotionMatch[1].toLowerCase() : "neutral";
    const text = answer
      .replace(
        /^\[emotion:(?:happy|sad|surprised|neutral|angry|jealous|lonely|worried|playful|sulky)\]\s*/i,
        "",
      )
      .trim();

    console.log(`[LLM] Response received (${emotion})`);
    return { ok: true, text, emotion };
  } catch (err) {
    const message =
      err.name === "AbortError" ? "LLM request timeout (15s)" : err.message;
    console.error("[LLM]", message);
    return { ok: false, error: message };
  }
});

// ─── IPC: Text-to-Speech via VOICEVOX ──────────────────────────────────────

function normalizeVoiceText(text) {
  return String(text ?? "")
    .replace(/\btanda\s+seru\b/gi, "!")
    .replace(/\btanda\s+tanya\b/gi, "?")
    .replace(/\bkoma\b/gi, ",")
    .replace(/\btitik\b/gi, ".")
    .replace(/[!！]+/g, "!")
    .replace(/[?？]+/g, "?")
    .replace(/[.。]+/g, ".")
    .replace(/[,，]+/g, ",")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Two-step VOICEVOX synthesis:
//   1. POST /audio_query  → get query JSON
//   2. POST /synthesis    → get WAV audio buffer
// Returns ArrayBuffer of WAV to renderer; renderer plays it + drives lipsync.
ipcMain.handle("tts-synthesize", async (_event, text) => {
  const VOICEVOX_BASE = "http://localhost:50021";
  // BISA DI GANTI SESUAI YANG KALIAN MAU DI VOICEFOX SUDAH ADA ID YANG DI SEDIAKAN SARAN GUNAKAN ID 18 19 3 13 ATAU 48 itu suara terbaik menurut atmin
  const SPEAKER_ID = 3;
  const voiceText = normalizeVoiceText(text);

  try {
    console.log(`[VOICEVOX] Synthesis started (${voiceText.length} chars)`);
    // Step 1: Generate audio query from text
    const queryRes = await fetchWithTimeout(
      `${VOICEVOX_BASE}/audio_query?text=${encodeURIComponent(voiceText)}&speaker=${SPEAKER_ID}`,
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
    const message =
      err.name === "AbortError"
        ? "VOICEVOX request timeout (10s)"
        : err.message;
    console.error("[VOICEVOX]", message);
    return { ok: false, error: message };
  }
});
