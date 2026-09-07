// preload.js — runs in isolated context between main & renderer
// Uses contextBridge to safely expose IPC calls to renderer (no Node access leak)

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nyra', {
  // ── Window controls ──────────────────────────────────────────────────────
  dragWindow: (delta) => ipcRenderer.send('window-drag', delta),
  closeWindow: () => ipcRenderer.send('window-close'),
  minimizeWindow: () => ipcRenderer.send('window-minimize'),

  // ── Speech-to-Text (Groq Whisper) ────────────────────────────────────────
  // audioBuffer: ArrayBuffer of recorded audio
  transcribe: (audioBuffer) =>
    ipcRenderer.invoke('whisper-transcribe', audioBuffer),

  // ── LLM chat (Groq gpt-oss-120b) ─────────────────────────────────────────
  // messages: Array of { role: 'user'|'assistant', content: string }
  chat: (messages) => ipcRenderer.invoke('llm-chat', messages),

  // ── Text-to-Speech (VOICEVOX local) ──────────────────────────────────────
  // text: string to synthesize; returns { ok, audio?: ArrayBuffer, error? }
  synthesize: (text) => ipcRenderer.invoke('tts-synthesize', text),
});
