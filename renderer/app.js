// renderer/app.js — Three.js scene, VRM character, chat UI, voice input, lipsync
// All Groq/VOICEVOX calls go through window.nyra (preload contextBridge)

import * as THREE from 'three';
import { GLTFLoader } from '../node_modules/three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, VRMHumanBoneName } from '@pixiv/three-vrm';

// ─── Scene setup ─────────────────────────────────────────────────────────────

const canvas = document.getElementById('vrm-canvas');

const renderer = new THREE.WebGLRenderer({
  canvas,
  alpha: true,        // transparent background
  antialias: true,
});
renderer.setSize(550, 400);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setClearColor(0x000000, 0);

const scene = new THREE.Scene();

// Camera — upper body frame
const camera = new THREE.PerspectiveCamera(30, 550 / 400, 0.1, 20);
camera.position.set(0, 1.25, 2.2);
camera.lookAt(0, 1.2, 0);

// Lighting
const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
scene.add(ambientLight);
const dirLight = new THREE.DirectionalLight(0xfff0f8, 1.2);
dirLight.position.set(1, 2, 2);
scene.add(dirLight);

// ─── VRM loading ──────────────────────────────────────────────────────────────

let vrm = null;

// Cached bone nodes — populated after VRM loads
// Using direct humanoid bone lookups for idle movement
let boneHips       = null;
let boneSpine      = null;
let boneChest      = null;
let boneUpperChest = null;
let boneNeck       = null;
let boneHead       = null;
let boneLeftArm    = null;
let boneRightArm   = null;
let boneLeftLowerArm  = null;
let boneRightLowerArm = null;

function cacheBones(vrmObj) {
  // VRMHumanoid.getNormalizedBoneNode returns the bone's THREE.Object3D
  const h = vrmObj.humanoid;
  boneHips       = h.getNormalizedBoneNode(VRMHumanBoneName.Hips);
  boneSpine      = h.getNormalizedBoneNode(VRMHumanBoneName.Spine);
  boneChest      = h.getNormalizedBoneNode(VRMHumanBoneName.Chest);
  boneUpperChest = h.getNormalizedBoneNode(VRMHumanBoneName.UpperChest);
  boneNeck       = h.getNormalizedBoneNode(VRMHumanBoneName.Neck);
  boneHead       = h.getNormalizedBoneNode(VRMHumanBoneName.Head);
  boneLeftArm    = h.getNormalizedBoneNode(VRMHumanBoneName.LeftUpperArm);
  boneRightArm   = h.getNormalizedBoneNode(VRMHumanBoneName.RightUpperArm);
  boneLeftLowerArm  = h.getNormalizedBoneNode(VRMHumanBoneName.LeftLowerArm);
  boneRightLowerArm = h.getNormalizedBoneNode(VRMHumanBoneName.RightLowerArm);
}

const loader = new GLTFLoader();
loader.register((parser) => new VRMLoaderPlugin(parser));

loader.load(
  '../anime.vrm',
  (gltf) => {
    vrm = gltf.userData.vrm;
    VRMUtils.rotateVRM0(vrm); // safe no-op for VRM 1.0
    vrm.scene.scale.setScalar(1.2);
    scene.add(vrm.scene);
    cacheBones(vrm);
    console.log('[VRM] Model loaded:', vrm);
  },
  (progress) => {
    const pct = ((progress.loaded / (progress.total || 1)) * 100).toFixed(0);
    console.log(`[VRM] Loading… ${pct}%`);
  },
  (err) => console.error('[VRM] Failed to load model:', err)
);

// ─── Idle animation: eye blinking ────────────────────────────────────────────

function scheduleBlink() {
  const delay = 3000 + Math.random() * 3000; // 3–6 s
  setTimeout(() => { doBlink(); scheduleBlink(); }, delay);
}

function doBlink() {
  if (!vrm?.expressionManager) return;
  const exp = vrm.expressionManager;
  exp.setValue('blink', 1);
  setTimeout(() => {
    setTimeout(() => exp.setValue('blink', 0), 60);
  }, 80);
}

scheduleBlink();

// ─── Gesture poses ───────────────────────────────────────────────────────────

const GESTURE_POSES = {
  idle: {
    // Nilai dari user: ARM_DOWN_Z=-1.1, ARM_FRONT_X=0.15, FOREARM_BEND=-0.3
    leftArm:      { x: 0.15, y: 0, z: -1.1 },
    rightArm:     { x: 0.15, y: 0, z:  1.1 },
    leftLowerArm: { x: 0,    y: 0, z: -0.3 },
    rightLowerArm:{ x: 0,    y: 0, z:  0.3 },
  },
  handsOnHip: {
    leftArm: { x: 0.3, y: 0.2, z: 0.9 },
    rightArm: { x: 0.3, y: -0.2, z: -0.9 },
    leftLowerArm: { x: 0, y: 0.5, z: 1.2 },
    rightLowerArm: { x: 0, y: -0.5, z: -1.2 },
  },
  touchHair: {
    leftArm: { x: 0.12, y: 0, z: 0.9 },
    rightArm: { x: 1.1, y: -0.3, z: -0.5 },
    leftLowerArm: { x: 0, y: 0, z: 0.2 },
    rightLowerArm: { x: 0, y: -0.7, z: -1.4 },
  },
  scratchHead: {
    leftArm: { x: 0.12, y: 0, z: 0.9 },
    rightArm: { x: 1.3, y: -0.35, z: -0.4 },
    leftLowerArm: { x: 0, y: 0, z: 0.2 },
    rightLowerArm: { x: 0.2, y: -0.8, z: -1.5 },
  },
  explaining: {
    leftArm: { x: 0.5, y: 0.25, z: 0.7 },
    rightArm: { x: 0.5, y: -0.25, z: -0.7 },
    leftLowerArm: { x: 0, y: 0.2, z: 0.55 },
    rightLowerArm: { x: 0, y: -0.2, z: -0.55 },
  },
};

const speakingGestures = ['handsOnHip', 'touchHair', 'scratchHead', 'explaining'];
let currentGesture = 'idle';
let gestureBlend = 0;
let gestureInterval = null;

function setGesture(gestureName) {
  if (!GESTURE_POSES[gestureName]) return;
  currentGesture = gestureName;
  gestureBlend = 0;
}

function chooseSpeakingGesture() {
  const available = speakingGestures.filter((gesture) => gesture !== currentGesture);
  setGesture(available[Math.floor(Math.random() * available.length)]);
}

function startSpeakingGestures() {
  if (gestureInterval) return;
  chooseSpeakingGesture();
  gestureInterval = setInterval(chooseSpeakingGesture, 2200 + Math.random() * 800);
}

function stopSpeakingGestures() {
  if (gestureInterval) {
    clearInterval(gestureInterval);
    gestureInterval = null;
  }
  setGesture('idle');
}

function applyGesturePose(poseName, lerpFactor = 0.08) {
  const pose = GESTURE_POSES[poseName];
  if (!pose) return;

  gestureBlend = Math.min(1, gestureBlend + lerpFactor);
  const transitionFactor = THREE.MathUtils.lerp(lerpFactor * 0.5, lerpFactor, gestureBlend);
  const target = {
    leftArm: { ...pose.leftArm },
    rightArm: { ...pose.rightArm },
    leftLowerArm: { ...pose.leftLowerArm },
    rightLowerArm: { ...pose.rightLowerArm },
  };

  if (poseName === 'explaining') {
    const rhythm = lipsyncVolume * 0.12;
    target.leftArm.x += rhythm;
    target.rightArm.x += rhythm;
    target.leftLowerArm.z += rhythm * 0.5;
    target.rightLowerArm.z -= rhythm * 0.5;
  }

  const blendRotation = (bone, rotation) => {
    if (!bone) return;
    bone.rotation.x = THREE.MathUtils.lerp(bone.rotation.x, rotation.x, transitionFactor);
    bone.rotation.y = THREE.MathUtils.lerp(bone.rotation.y, rotation.y, transitionFactor);
    bone.rotation.z = THREE.MathUtils.lerp(bone.rotation.z, rotation.z, transitionFactor);
  };

  blendRotation(boneLeftArm, target.leftArm);
  blendRotation(boneRightArm, target.rightArm);
  blendRotation(boneLeftLowerArm, target.leftLowerArm);
  blendRotation(boneRightLowerArm, target.rightLowerArm);
}

// ─── App state ────────────────────────────────────────────────────────────────

let appState = 'idle'; // 'idle' | 'listening' | 'thinking' | 'speaking'

function setState(state) {
  const previousState = appState;
  appState = state;
  const indicator = document.getElementById('status-indicator');
  const statusText = document.getElementById('status-text');
  const btnMic     = document.getElementById('btn-mic');

  switch (state) {
    case 'listening':
      indicator.classList.remove('hidden');
      statusText.textContent = '🎙 mendengarkan…';
      btnMic.classList.add('recording');
      break;
    case 'thinking':
      indicator.classList.remove('hidden');
      statusText.textContent = 'berpikir…';
      btnMic.classList.remove('recording');
      break;
    case 'speaking':
      indicator.classList.remove('hidden');
      statusText.textContent = 'berbicara…';
      if (previousState !== 'speaking') startSpeakingGestures();
      break;
    default:
      indicator.classList.add('hidden');
      btnMic.classList.remove('recording');
      stopSpeakingGestures();
      break;
  }
}

// ─── Chat history ─────────────────────────────────────────────────────────────

const MAX_HISTORY = 12;
const conversationHistory = [];

function addMessage(role, text) {
  conversationHistory.push({ role, content: text });
  if (conversationHistory.length > MAX_HISTORY) conversationHistory.shift();

  const history = document.getElementById('chat-history');
  const bubble  = document.createElement('div');
  bubble.className = `msg ${role}`;
  bubble.textContent = text;
  history.appendChild(bubble);
  history.scrollTop = history.scrollHeight;
}

// ─── Full pipeline: text → LLM → TTS → lipsync ───────────────────────────────

async function handleUserInput(text) {
  if (!text.trim() || appState === 'thinking' || appState === 'speaking') return;

  addMessage('user', text);
  setState('thinking');

  const llmResult = await window.nyra.chat(
    conversationHistory.filter((m) => m.role !== 'system')
  );

  if (!llmResult.ok) {
    addMessage('assistant', 'eh, ada yang error nih… coba lagi ya~');
    setState('idle');
    return;
  }

  const reply = llmResult.text;
  addMessage('assistant', reply);
  await playTTSAndLipsync(reply, llmResult.emotion);
  setState('idle');
}

// ─── TTS + lipsync ────────────────────────────────────────────────────────────

let audioCtx = null;
function getAudioContext() {
  if (!audioCtx || audioCtx.state === 'closed') audioCtx = new AudioContext();
  return audioCtx;
}

let lipsyncVolume = 0;
let lipsyncActive = false;
const supportedEmotions = new Set(['happy', 'sad', 'surprised', 'neutral', 'angry']);
let activeEmotion = 'neutral';

function setEmotion(emotion, value) {
  if (!vrm?.expressionManager || !supportedEmotions.has(emotion)) return;
  vrm.expressionManager.setValue(emotion, value);
}

async function playTTSAndLipsync(text, emotion = 'neutral') {
  setState('speaking');
  activeEmotion = supportedEmotions.has(emotion) ? emotion : 'neutral';
  setEmotion(activeEmotion, 1.0);
  const ttsResult = await window.nyra.synthesize(text);

  if (!ttsResult.ok) {
    if (ttsResult.error === 'voicevox_offline')
      console.warn('[TTS] VOICEVOX offline — skipping audio');
    setEmotion(activeEmotion, 0);
    setEmotion('neutral', 1.0);
    activeEmotion = 'neutral';
    setState('idle');
    return;
  }

  const ctx      = getAudioContext();
  const audioBuf = await ctx.decodeAudioData(ttsResult.audio);
  const source   = ctx.createBufferSource();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;

  source.buffer = audioBuf;
  source.connect(analyser);
  analyser.connect(ctx.destination);

  const dataArray = new Uint8Array(analyser.frequencyBinCount);
  lipsyncActive = true;

  // Read volume every frame while speaking
  function updateLipsync() {
    if (!lipsyncActive) return;
    analyser.getByteFrequencyData(dataArray);
    const avg = dataArray.reduce((s, v) => s + v, 0) / dataArray.length;
    lipsyncVolume = Math.min(avg / 128, 1);
    requestAnimationFrame(updateLipsync);
  }
  updateLipsync();

  source.start();
  await new Promise((resolve) => {
    source.onended = () => {
      lipsyncActive = false;
      lipsyncVolume = 0;
      setEmotion(activeEmotion, 0);
      setEmotion('neutral', 1.0);
      activeEmotion = 'neutral';
      resolve();
    };
  });
}

// ─── Voice recording (Whisper STT) ───────────────────────────────────────────

let mediaRecorder = null;
let audioChunks   = [];
const btnMic = document.getElementById('btn-mic');

btnMic.addEventListener('click', async () => {
  if (appState === 'thinking' || appState === 'speaking') return;

  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
    return;
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    console.error('[Mic] Permission denied:', err);
    return;
  }

  audioChunks = [];
  mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });

  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) audioChunks.push(e.data);
  };

  // Stop → transcribe → pipeline
  mediaRecorder.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    setState('thinking');

    const blob        = new Blob(audioChunks, { type: 'audio/webm' });
    const arrayBuffer = await blob.arrayBuffer();
    const sttResult   = await window.nyra.transcribe(arrayBuffer);

    if (!sttResult.ok || !sttResult.text) {
      console.warn('[STT] No transcript');
      setState('idle');
      return;
    }

    console.log('[STT] Transcript:', sttResult.text);
    await handleUserInput(sttResult.text);
  };

  mediaRecorder.start();
  setState('listening');
});

// ─── Text input ───────────────────────────────────────────────────────────────

const textInput = document.getElementById('text-input');
const btnSend   = document.getElementById('btn-send');

async function submitText() {
  const text = textInput.value.trim();
  if (!text) return;
  textInput.value = '';
  await handleUserInput(text);
}

btnSend.addEventListener('click', submitText);
textInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitText(); }
});

// ─── Window controls ──────────────────────────────────────────────────────────

document.getElementById('btn-close').addEventListener('click', () => window.nyra.closeWindow());
document.getElementById('btn-minimize').addEventListener('click', () => window.nyra.minimizeWindow());

// ─── Animation loop ───────────────────────────────────────────────────────────

const clock = new THREE.Clock();

// Track whether rest pose has been applied (only once after bones are ready)
let restPoseApplied = false;

function animate() {
  requestAnimationFrame(animate);
  const delta = clock.getDelta();
  const elapsed = clock.elapsedTime;

  if (vrm) {
    // Apply the initial idle pose once after bones are cached.
    if (!restPoseApplied && boneLeftArm) {
      setGesture('idle');
      restPoseApplied = true;
    }

    // ── Idle body animations ────────────────────────────────────────────────

    // 1. Breathing — gentle chest/spine rise using Z rotation
    //    sin wave: period ~4 s, amplitude small
    const breathe = Math.sin(elapsed * 1.6) * 0.012;
    if (boneSpine)      boneSpine.rotation.x      = breathe * 0.6;
    if (boneChest)      boneChest.rotation.x      = breathe;
    if (boneUpperChest) boneUpperChest.rotation.x = breathe * 0.8;

    // 2. Body sway — speaking is more active, then eases back to idle.
    const speaking = appState === 'speaking';
    const swayAmplitude = speaking ? 0.027 : 0.018;
    const sway = Math.sin(elapsed * (speaking ? 1.35 : 1.05)) * swayAmplitude;
    if (boneHips)  boneHips.rotation.z  = THREE.MathUtils.lerp(boneHips.rotation.z, sway, 0.08);
    if (boneSpine) boneSpine.rotation.z = THREE.MathUtils.lerp(boneSpine.rotation.z, sway * 0.5, 0.08);

    // 3. Head look-around — compound of two sin waves for organic feel
    //    horizontal drift (Y) + gentle nod (X)
    const headY = Math.sin(elapsed * (speaking ? 1.1 : 0.7) + 1.2) * (speaking ? 0.075 : 0.06)
                + Math.sin(elapsed * (speaking ? 2.0 : 1.4) + 0.3) * (speaking ? 0.035 : 0.025);
    const headX = Math.sin(elapsed * (speaking ? 1.0 : 0.55) + 2.1) * (speaking ? 0.065 : 0.04)
                + breathe * 0.4;
    const headZ = Math.sin(elapsed * (speaking ? 0.85 : 0.5) + 0.8) * (speaking ? 0.025 : 0.015);

    if (boneHead) {
      boneHead.rotation.y = THREE.MathUtils.lerp(boneHead.rotation.y, headY, 0.08);
      boneHead.rotation.x = THREE.MathUtils.lerp(boneHead.rotation.x, headX, 0.08);
      boneHead.rotation.z = THREE.MathUtils.lerp(boneHead.rotation.z, headZ, 0.08);
    }
    if (boneNeck) {
      // Neck follows head at half the amplitude
      boneNeck.rotation.y = THREE.MathUtils.lerp(boneNeck.rotation.y, headY * 0.4, 0.08);
      boneNeck.rotation.x = THREE.MathUtils.lerp(boneNeck.rotation.x, headX * 0.3, 0.08);
    }

    // 4. Alternate expressive hand poses while speaking.
    applyGesturePose(currentGesture, 0.08);

    // ── Lipsync: map audio volume to mouth 'aa' expression ─────────────────
    if (vrm.expressionManager) {
      if (lipsyncActive) {
        vrm.expressionManager.setValue('aa', lipsyncVolume * 0.9);
      } else {
        // Smooth close
        const cur = vrm.expressionManager.getValue('aa') ?? 0;
        vrm.expressionManager.setValue('aa', cur * 0.75);
      }
    }

    // Update VRM internals (spring bones, constraints, etc.)
    vrm.update(delta);
  }

  renderer.render(scene, camera);
}

animate();
