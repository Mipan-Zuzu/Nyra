const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nyra', {
  dragWindow: (delta) => ipcRenderer.send('window-drag', delta),
  closeWindow: () => ipcRenderer.send('window-close'),
  minimizeWindow: () => ipcRenderer.send('window-minimize'),

  transcribe: (audioBuffer) =>
    ipcRenderer.invoke('whisper-transcribe', audioBuffer),

  chat: (messages) => ipcRenderer.invoke('llm-chat', messages),

  synthesize: (text) => ipcRenderer.invoke('tts-synthesize', text),

  openApp: (appName) => ipcRenderer.invoke('open-app', appName),

  readScreen: (prompt) => ipcRenderer.invoke('read-screen', prompt),
});
