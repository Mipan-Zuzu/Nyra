// main.js — Electron main process
// Handles: window setup, IPC for Whisper STT, LLM (Groq), VOICEVOX TTS

require("dotenv").config();
const {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  session,
  desktopCapturer,
} = require("electron");
const path = require("path");
const fetch = require("node-fetch");
const FormData = require("form-data");
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
  //win.webContents.openDevTools({ mode: "detach" });
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

// Kalimat "buka X" di renderer diekstrak lalu dicocokkan ke peta ini.
// command: dieksekusi langsung dari PATH; .cmd butuh shell.
// fallbackCommand (opsional): dicoba kalau command utama tidak ada (ENOENT),
//   mis. Windows Terminal belum terpasang → buka cmd.exe biasa.
// Nilai ber-protocol (mis. "roblox-player:") memang selalu gagal spawn langsung,
//   tapi otomatis dibuka lewat `start` (ShellExecute) — lihat launchApp().
const APP_COMMANDS = {
  // ── Browser
  chrome: { command: "chrome.exe" },
  "google chrome": { command: "chrome.exe" },
  edge: { command: "msedge.exe" },
  firefox: { command: "firefox.exe" },

  // ── Komunikasi
  discord: { command: "Discord.exe" },
  whatsapp: { command: "WhatsApp.exe" },
  telegram: { command: "Telegram.exe" },

  // ── Media & hiburan
  spotify: { command: "Spotify.exe" },
  roblox: { command: "roblox-player:" }, // protocol URI → dibuka via start
  steam: { command: "steam.exe" },

  // ── Developer
  vscode: { command: "code.cmd" },
  "vs code": { command: "code.cmd" },
  "visual studio code": { command: "code.cmd" },
  terminal: { command: "wt.exe", fallbackCommand: "cmd.exe" },
  "windows terminal": { command: "wt.exe", fallbackCommand: "cmd.exe" },
  cmd: { command: "cmd.exe" },
  "command prompt": { command: "cmd.exe" },
  powershell: { command: "powershell.exe" },

  // ── Produktivitas & sistem
  notepad: { command: "notepad.exe" },
  calculator: { command: "calc.exe" },
  kalkulator: { command: "calc.exe" },
  paint: { command: "mspaint.exe" },
  explorer: { command: "explorer.exe" },
  "file explorer": { command: "explorer.exe" },
  word: { command: "winword.exe" },
  excel: { command: "excel.exe" },
  powerpoint: { command: "powerpnt.exe" },
  "task manager": { command: "taskmgr.exe" },
  "manajer tugas": { command: "taskmgr.exe" },
  settings: { command: "ms-settings:" }, // protocol URI → dibuka via start
  pengaturan: { command: "ms-settings:" },
};

// Launch one command detached. Rejects with the spawn error (mis. ENOENT)
// so the caller can fall back — spawn errors are async, bukan sync throw.
function spawnDetached(command, args, useShell) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      shell: useShell,
    });
    child.on("error", reject);
    child.unref();
    resolve();
  });
}

// Launch attempt 1: langsung dari PATH (ShellExecute-like behaviour gratis
// untuk .cmd via shell:true).
// Launch attempt 2 (ENOENT): `start` (ShellExecute) — resolve PATH + Windows
// App Paths registry + protocol URI, jadi Discord/Firefox/Roblox yang tidak
// ada di PATH tetap bisa dibuka.
async function launchApp(command, args) {
  const useShell = command.endsWith(".cmd");
  try {
    await spawnDetached(command, args, useShell);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    await spawnDetached("cmd.exe", ["/c", "start", "", command, ...args], false);
  }
}

ipcMain.handle("open-app", async (_event, appName) => {
  const key = typeof appName === "string" ? appName.trim().toLowerCase() : "";
  const appCommand = APP_COMMANDS[key];
  if (!appCommand) return { ok: false, error: "unsupported_app" };

  const candidates = [appCommand.command, appCommand.fallbackCommand].filter(
    Boolean,
  );

  try {
    for (const command of candidates) {
      try {
        await launchApp(command, appCommand.args || []);
        console.log(`[App] Opened ${key} (${command})`);
        return { ok: true };
      } catch (err) {
        if (err.code !== "ENOENT") throw err;
        console.warn(`[App] ${command} tidak ditemukan, mencoba kandidat berikutnya…`);
      }
    }
    throw new Error("no_launcher_found");
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
    // whisper-large-v3-turbo: ~3x faster than whisper-large-v3, near-identical accuracy
    form.append("model", "whisper-large-v3-turbo");
    form.append("language", "id");
    form.append("response_format", "json");
    form.append("temperature", "0.0"); // deterministic transcription

    const res = await fetchWithTimeout(
      "https://api.groq.com/openai/v1/audio/transcriptions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          ...form.getHeaders(),
        },
        body: form,
      },
      15000,
    );

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Whisper API error ${res.status}: ${err}`);
    }

    const data = await res.json();
    const transcript = data.text?.trim() || "";

    // Filter out low-confidence hallucinations (common Whisper artifact when no speech)
    const noSpeechPhrases = [
      'terima kasih',
      'anda',
      'ditonton',
      'subscribe',
      'jangan lupa',
      'semoga bermanfaat',
      'assalamualaikum',
    ];
    const isLikelyHallucination =
      transcript.length < 3 ||
      (transcript.length < 15 && noSpeechPhrases.some(phrase => transcript.toLowerCase().includes(phrase)));

    if (isLikelyHallucination) {
      console.log(`[Whisper] Filtered hallucination: "${transcript}"`);
      return { ok: true, text: "" };
    }

    return { ok: true, text: transcript };
  } catch (err) {
    console.error("[Whisper]", err.message);
    return { ok: false, error: err.message };
  }
});

// ─── IPC: LLM chat via Groq (gpt-oss-120b) ────────────────────────────────

ipcMain.handle("llm-chat", async (_event, messages, effort) => {
  // Validasi reasoning effort: low | medium | high (fallback "low")
  const VALID_EFFORTS = new Set(["low", "medium", "high"]);
  const reasoningEffort = VALID_EFFORTS.has(effort) ? effort : "low";

  try {
    console.log(
      `[LLM] Request started (${messages.length} messages, effort=${reasoningEffort})`,
    );
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
        "例3(心配): [emotion:worried] 大丈夫?あんまり無理しないでね、ちゃんと休んでる?\nTerjemahan: Kamu baik-baik aja? Jangan maksain diri ya, udah istirahat cukup?" +
        "" +
        "\n\n【画面分析ツール (VISION) について】" +
        "\nNyraにはユーザーの画面を見る機能(VISION)があります。" +
        "\nユーザーが今開いている画面・アプリ・ゲーム・ウェブページ・ドキュメント・コードなど、" +
        "\n表示されている物の内容について分析・確認・質問・説明を求めてきたら、" +
        "\n感情タグの代わりに必ず [vision] タグだけを返してください。" +
        "\n[vision] を返すときは他のテキストやTerjemahanを書かないこと。" +
        "\n例: ユーザー「これ何?」「エラー出てるんだけど」「画面見て」「このコードおかしくない?」「画面の内容教えて」 → 返答: [vision]" +
        "\n※「開く/起動して」などアプリを操作してほしい頼み方は [vision] ではなく通常の返答で。" +
        "\n※画面とは無関係な普通の会話は通常通り返答すること。",
    };

    // gpt-oss is a reasoning model: reasoning tokens count toward max_tokens,
    // so the budget must scale with effort or content comes back empty.
    const maxTokensFor = (effort) =>
      effort === "high" ? 2048 : effort === "medium" ? 1024 : 512;

    const buildBody = (effort, maxTokens) =>
      JSON.stringify({
        model: "openai/gpt-oss-120b",
        messages: [systemPrompt, ...messages],
        reasoning_effort: effort,
        max_tokens: maxTokens ?? maxTokensFor(effort),
        temperature: 0.85, // slightly more varied responses
      });

    const stripThinking = (raw) =>
      String(raw ?? "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

    // One request → { data, answer }, atau { rateLimited: true } pada 429.
    const requestAnswer = async (effort, maxTokens) => {
      const res = await fetchWithTimeout(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: buildBody(effort, maxTokens),
        },
        15000,
      );

      if (res.status === 429) {
        console.warn("[LLM] Rate limited (429)");
        return { rateLimited: true };
      }
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`LLM API error ${res.status}: ${err}`);
      }

      const data = await res.json();
      return { data, answer: stripThinking(data.choices?.[0]?.message?.content) };
    };

    let llmAnswer = await requestAnswer(
      reasoningEffort,
      maxTokensFor(reasoningEffort),
    );

    if (llmAnswer.rateLimited) {
      return {
        ok: true,
        text: "hmm, aku butuh napas sebentar~",
        emotion: "neutral",
      };
    }

    // Reasoning ate the whole token budget → empty content. Retry once with
    // a doubled budget so the model still has room for the actual reply.
    // (Retry yang gagal diabaikan — jatuh ke fallback di bawah.)
    if (!llmAnswer.data || !llmAnswer.answer) {
      const finishReason = llmAnswer.data?.choices?.[0]?.finish_reason;
      console.warn(
        `[LLM] Empty content (finish_reason=${finishReason}) — retrying with doubled max_tokens`,
      );
      try {
        llmAnswer = await requestAnswer(
          reasoningEffort,
          maxTokensFor(reasoningEffort) * 2,
        );
      } catch (retryErr) {
        console.warn("[LLM] Retry failed:", retryErr.message);
      }
    }

    // Final fallback — never hand an empty string to VOICEVOX
    if (!llmAnswer.answer) {
      console.warn("[LLM] Still empty after retry — using fallback reply");
      return {
        ok: true,
        text: "ごめん、ちょっと考えすぎちゃった。もう一回聞いてもいい?",
        emotion: "neutral",
      };
    }

    const EMOTION_TAG =
      /^\[emotion:(happy|sad|surprised|neutral|angry|jealous|lonely|worried|playful|sulky)\]\s*/i;
    const rawReply = llmAnswer.answer;
    const emotion = (rawReply.match(EMOTION_TAG)?.[1] || "neutral").toLowerCase();
    const text = rawReply.replace(EMOTION_TAG, "").trim();

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
    // VOICEVOX memberi intonasi paling natural dengan tanda baca Jepang
    .replace(/\./g, "。")
    .replace(/,/g, "、")
    .replace(/!/g, "！")
    .replace(/\?/g, "？")
    .trim();
}

// ─── Vision — screen capture + Gemini Vision analysis ───────────────────────

const { GoogleGenAI } = require("@google/genai");
const GEMINI_VISION_MODEL = "gemini-3-flash-preview"; // tanpa prefix "gemini/" — SDK @google/genai tidak pakai prefix

// ─── TOOL 1: Screen capture ─────────────────────────────────────────────────
// Captures a display as JPEG base64. Runs before analysis so the pipeline is:
// capture → Gemini → translate → Voice Fox.

async function captureScreen({ displayIndex = 0, quality = 85 } = {}) {
  // Match native resolution (capped) so small on-screen text stays readable for Gemini
  const primary = screen.getPrimaryDisplay();
  const cap = 1920; // upload cap — small payload without losing readability
  const scale = Math.min(1, cap / Math.max(primary.size.width, primary.size.height));

  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: {
      width: Math.round(primary.size.width * scale),
      height: Math.round(primary.size.height * scale),
    },
  });
  if (!sources.length) throw new Error("no_screen_source");

  const source = sources[Math.min(displayIndex, sources.length - 1)];
  const thumb = source.thumbnail;
  if (thumb.isEmpty()) throw new Error("empty_screenshot");

  const base64 = thumb.toJPEG(quality).toString("base64");
  console.log(
    `[Vision] Capture OK: ${source.name} ` +
      `(${thumb.getSize().width}x${thumb.getSize().height}, ~${Math.round(base64.length / 1024)} KB)`,
  );
  return { base64, mimeType: "image/jpeg", sourceName: source.name };
}

// ─── TOOL 2: Gemini Vision analysis ─────────────────────────────────────────
// Sends the screenshot to Gemini, returns { japanese, translation }.
// Output contract: "<jawaban Jepang>\n|||IL|||\n<terjemahan Indonesia>"

async function analyzeScreenWithGemini(apiKey, image, userPrompt) {
  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model: GEMINI_VISION_MODEL,
    contents: [
      {
        role: "user",
        parts: [
          {
            inlineData: {
              mimeType: image.mimeType,
              data: image.base64,
            },
          },
          {
            text:
              "Kamu adalah Nyra, asisten AI dengan kemampuan melihat layar. " +
              "Analisis screenshot layar pengguna ini dengan detail. " +
              "Identifikasi: teks yang terlihat, elemen UI, gambar, atau pesan error. " +
              "Jawab pertanyaan pengguna berdasarkan isi layar. " +
              (userPrompt && userPrompt.trim()
                ? `Pertanyaan pengguna: ${userPrompt.trim()}`
                : "Jelaskan secara singkat apa yang sedang ditampilkan di layar.") +
              "\n" +
              "ATURAN OUTPUT (WAJIB, ikuti persis tanpa penjelasan tambahan):\n" +
              "1. Jawab dalam Bahasa Jepang (日本語) yang natural untuk diucapkan, maksimal 3 kalimat, tanpa markdown.\n" +
              "2. Setelah jawaban Jepang, buat baris baru, lalu tulis penanda persis: |||IL|||\n" +
              "3. Setelah penanda, tulis terjemahan jawabanmu dalam Bahasa Indonesia.\n" +
              "Format akhir:\n" +
              "<jawaban bahasa jepang>\n|||IL|||\n<terjemahan bahasa indonesia>",
          },
        ],
      },
    ],
  });

  const text = response.text?.trim() || "";
  if (!text) throw new Error("empty_vision_response");

  // Split: Japanese line → Voice Fox (VOICEVOX), Indonesian → chat bubble
  const SEP = "|||IL|||";
  const sepIdx = text.indexOf(SEP);
  const japanese = (sepIdx !== -1 ? text.slice(0, sepIdx) : text)
    .replace(SEP, "")
    .replace(/[（(【\[]?\s*(?:terjemahan|翻訳|訳|indonesia)[^\n）)】\]]*[）)】\]]?/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  const translation = sepIdx !== -1 ? text.slice(sepIdx + SEP.length).trim() : null;

  return { japanese, translation };
}

// Detects quota / rate-limit / auth failures so renderer can fall back gracefully
function isVisionLimitError(err) {
  const msg = String(err?.message || err || "");
  return (
    /\b429\b/.test(msg) ||
    /\b403\b/.test(msg) ||
    /quota/i.test(msg) ||
    /rate\s*limit/i.test(msg) ||
    /resource_exhausted/i.test(msg) ||
    /permission_denied/i.test(msg) ||
    /api[_\s]?key/i.test(msg) ||
    /unauthenticated/i.test(msg)
  );
}

ipcMain.handle("read-screen", async (_event, prompt) => {
  try {
    const apiKey = process.env.AI_API_KEY_GEMINI_VISION;
    if (!apiKey) throw new Error("AI_API_KEY_GEMINI_VISION not set in .env");

    // Step 1/3 — TOOL: screen capture
    console.log("[Vision] Step 1/3: capturing screen...");
    const image = await captureScreen();

    // Step 2/3 — TOOL: Gemini Vision analysis → Japanese + Indonesian translation
    console.log("[Vision] Step 2/3: analyzing with Gemini Vision...");
    const { japanese, translation } = await analyzeScreenWithGemini(apiKey, image, prompt);

    // Step 3/3 — hand off: Japanese goes to Voice Fox (VOICEVOX) via the renderer
    console.log("[Vision] Step 3/3: done — sending Japanese text to Voice Fox");
    console.log(`[Vision] 日本語: ${japanese}`);
    if (translation) console.log(`[Vision] ID: ${translation}`);
    return { ok: true, text: japanese, translation };
  } catch (err) {
    console.error("[Vision]", err?.message || err);
    // Quota / limit / failure → explicit flag so renderer speaks the fallback line
    if (isVisionLimitError(err)) {
      return {
        ok: false,
        error: "vision_limit",
        fallbackText: "すみません、今はまだそれを見ることができません。",
        fallbackTranslation: "Maaf, saat ini Nyra belum bisa melihatnya.",
      };
    }
    return { ok: false, error: err?.message || String(err) };
  }
});

// Two-step VOICEVOX synthesis:
//   1. POST /audio_query  → get query JSON
//   2. POST /synthesis    → get WAV audio buffer
// Returns ArrayBuffer of WAV to renderer; renderer plays it + drives lipsync.
//
// Timeout is DYNAMIC: synthesis time grows with text length, so a fixed 10s
// made long texts time out. Base 15s + 0.5s per 10 chars, capped at 120s.
function voicevoxTimeoutMs(textLength) {
  return Math.min(120000, 15000 + Math.ceil(textLength / 10) * 500);
}

// One full synthesis attempt (audio_query → synthesis). Throws on failure.
async function voicevoxSynthesizeOnce(VOICEVOX_BASE, SPEAKER_ID, voiceText, timeoutMs) {
  // Step 1: Generate audio query from text
  const queryRes = await fetchWithTimeout(
    `${VOICEVOX_BASE}/audio_query?text=${encodeURIComponent(voiceText)}&speaker=${SPEAKER_ID}`,
    { method: "POST" },
    timeoutMs,
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
    timeoutMs,
  );
  if (!synthRes.ok) {
    throw new Error(`synthesis failed: ${synthRes.status}`);
  }
  return synthRes.arrayBuffer();
}

ipcMain.handle("tts-synthesize", async (_event, text) => {
  const VOICEVOX_BASE = "http://localhost:50021";
  // BISA DI GANTI SESUAI YANG KALIAN MAU DI VOICEFOX SUDAH ADA ID YANG DI SEDIAKAN SARAN GUNAKAN ID 18 19 3 13 ATAU 48 itu suara terbaik menurut atmin
  const SPEAKER_ID = 8;
  const voiceText = normalizeVoiceText(text);
  const timeoutMs = voicevoxTimeoutMs(voiceText.length);
  const MAX_ATTEMPTS = 2; // 1 retry on transient timeout/failure

  try {
    console.log(
      `[VOICEVOX] Synthesis started (${voiceText.length} chars, timeout ${Math.round(timeoutMs / 1000)}s)`,
    );

    let wavBuffer;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        wavBuffer = await voicevoxSynthesizeOnce(
          VOICEVOX_BASE,
          SPEAKER_ID,
          voiceText,
          timeoutMs,
        );
        break; // success
      } catch (err) {
        const isTimeout = err.name === "AbortError";
        const isRetryableHttp =
          /failed: (5\d\d|429)/.test(err.message || "");
        const lastAttempt = attempt === MAX_ATTEMPTS;

        if (lastAttempt || (!isTimeout && !isRetryableHttp)) throw err;

        console.warn(
          `[VOICEVOX] Attempt ${attempt} failed (${err.message}) — retrying...`,
        );
        await new Promise((r) => setTimeout(r, 800)); // brief backoff before retry
      }
    }

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
        ? `VOICEVOX request timeout (${Math.round(timeoutMs / 1000)}s)`
        : err.message;
    console.error("[VOICEVOX]", message);
    return { ok: false, error: message };
  }
});
