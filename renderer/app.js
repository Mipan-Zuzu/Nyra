// renderer/app.js — Three.js scene, VRM character, chat UI, voice input, lipsync
// All Groq/VOICEVOX calls go through window.nyra (preload contextBridge)

import * as THREE from 'three';
import { GLTFLoader } from '../node_modules/three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, VRMHumanBoneName } from '@pixiv/three-vrm';

// ─── Scene setup ─────────────────────────────────────────────────────────────

const canvas = document.getElementById('vrm-canvas');
const renderer = new THREE.WebGLRenderer({
  canvas,
  alpha: true,
  antialias: true,
});

renderer.setSize(550, 400);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setClearColor(0x000000, 0);

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(30, 550 / 400, 0.1, 20);
camera.position.set(0, 1.25, 2.2);
camera.lookAt(0, 1.2, 0);

const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
scene.add(ambientLight);

const dirLight = new THREE.DirectionalLight(0xfff0f8, 1.2);
dirLight.position.set(1, 2, 2);
scene.add(dirLight);

// ─── App state ───────────────────────────────────────────────────────────────

let appState = 'idle';
let thinkingStep = null;

// ─── VRM loading ─────────────────────────────────────────────────────────────

let vrm = null;

let boneHips = null;
let boneSpine = null;
let boneChest = null;
let boneUpperChest = null;
let boneNeck = null;
let boneHead = null;
let boneLeftArm = null;
let boneRightArm = null;
let boneLeftLowerArm = null;
let boneRightLowerArm = null;

function cacheBones(vrmObj) {
  const h = vrmObj.humanoid;

  boneHips = h.getNormalizedBoneNode(VRMHumanBoneName.Hips);
  boneSpine = h.getNormalizedBoneNode(VRMHumanBoneName.Spine);
  boneChest = h.getNormalizedBoneNode(VRMHumanBoneName.Chest);
  boneUpperChest = h.getNormalizedBoneNode(VRMHumanBoneName.UpperChest);
  boneNeck = h.getNormalizedBoneNode(VRMHumanBoneName.Neck);
  boneHead = h.getNormalizedBoneNode(VRMHumanBoneName.Head);
  boneLeftArm = h.getNormalizedBoneNode(VRMHumanBoneName.LeftUpperArm);
  boneRightArm = h.getNormalizedBoneNode(VRMHumanBoneName.RightUpperArm);
  boneLeftLowerArm = h.getNormalizedBoneNode(VRMHumanBoneName.LeftLowerArm);
  boneRightLowerArm = h.getNormalizedBoneNode(VRMHumanBoneName.RightLowerArm);
}

const gazeTarget = new THREE.Object3D();
scene.add(gazeTarget);

let hasLookAt = false;
let hasLookExpressions = false;

const loader = new GLTFLoader();
loader.register((parser) => new VRMLoaderPlugin(parser));

loader.load(
  '../anime.vrm',
  (gltf) => {
    vrm = gltf.userData.vrm;

    VRMUtils.rotateVRM0(vrm);
    vrm.scene.scale.setScalar(1.2);
    scene.add(vrm.scene);

    cacheBones(vrm);

    const lookAt = vrm.lookAt;

    if (lookAt && typeof lookAt.target === 'object') {
      lookAt.target = gazeTarget;
      hasLookAt = true;

      if ('autoUpdate' in lookAt) {
        lookAt.autoUpdate = false;
      }
    }

    detectLookExpressions(vrm);
    detectEars(vrm);

    console.log(
      `[VRM] Model loaded (lookAt=${hasLookAt}, lookExpressions=${hasLookExpressions}):`,
      vrm,
    );
  },
  (progress) => {
    const pct = (
      (progress.loaded / (progress.total || 1)) * 100
    ).toFixed(0);

    console.log(`[VRM] Loading… ${pct}%`);
  },
  (err) => console.error('[VRM] Failed to load model:', err),
);

// ─── Idle animation: eye blinking ────────────────────────────────────────────

function scheduleBlink() {
  const delay = 3000 + Math.random() * 1500;

  setTimeout(() => {
    doBlink();
    scheduleBlink();
  }, delay);
}

function doBlink() {
  if (!vrm?.expressionManager) return;

  const exp = vrm.expressionManager;

  exp.setValue('blink', 1);
  setTimeout(() => exp.setValue('blink', 0.4), 90);
  setTimeout(() => exp.setValue('blink', 0), 160);
}

// ─── Cat ear twitch: telinga kucing bergerak setiap beberapa detik ──────────

let earNodes = [];
let earExpressionName = null;

function detectEars(vrmObj) {
  earNodes = [];
  earExpressionName = null;

  if (!vrmObj) return;

  // 1) Jika model punya expression telinga (VRM custom), pakai itu.
  const exp = vrmObj.expressionManager;

  if (exp && typeof exp.getExpression === 'function') {
    try {
      const names = (exp.expressions || [])
        .map((e) => e.expressionName)
        .filter(Boolean);

      const earExpName = names.find((name) => /ear/i.test(name));

      if (earExpName && exp.getExpression(earExpName) != null) {
        earExpressionName = earExpName;
      }
    } catch {
      earExpressionName = null;
    }
  }

  // 2) Jika tidak ada expression, cari bone/mesh telinga berdasarkan nama.
  if (!earExpressionName) {
    vrmObj.scene.traverse((obj) => {
      if (obj.name && /ear/i.test(obj.name)) {
        earNodes.push(obj);
      }
    });
  }

  console.log(
    `[Ears] Twitch mode: ${earExpressionName ? `expression "${earExpressionName}"` : earNodes.length ? `${earNodes.length} node(s): ${earNodes.map((n) => n.name).join(', ')}` : 'none found'}`,
  );
}

// ── Ear twitch berbasis frame: selalu berjalan di semua state ──

let earTwitch = null;           // twitch yang sedang berjalan
let nextEarTwitchAt = 2.0;      // detik ke-berapa twitch berikutnya (elapsed)

const EAR_TWITCH_MIN_DELAY = 3.5;   // jeda minimal antar twitch (detik)
const EAR_TWITCH_MAX_DELAY = 8.0;   // jeda maksimal antar twitch (detik)
const EAR_TWITCH_DURATION = 0.52;   // durasi satu twitch (detik)

function startEarTwitch(elapsed) {
  // Mode expression: pulse telinga via blendshape.
  if (earExpressionName && vrm?.expressionManager) {
    earTwitch = { mode: 'expression', start: elapsed };
    return;
  }

  // Mode node: pilih SATU telinga acak (kucing menggerakkan satu telinga).
  if (!earNodes.length) return;

  const node =
    earNodes.length > 1
      ? earNodes[Math.floor(Math.random() * earNodes.length)]
      : earNodes[0];

  earTwitch = {
    mode: 'node',
    start: elapsed,
    node,
    baseRot: node.rotation.clone(),
  };
}

function updateEarTwitch(elapsed) {
  // Belum waktunya twitch berikutnya.
  if (!earTwitch && elapsed < nextEarTwitchAt) return;

  // Mulai twitch baru.
  if (!earTwitch) {
    startEarTwitch(elapsed);
    if (!earTwitch) return;
  }

  const t = (elapsed - earTwitch.start) / EAR_TWITCH_DURATION;

  // Twitch selesai → pulihkan & jadwalkan berikutnya.
  if (t >= 1) {
    if (earTwitch.mode === 'expression') {
      vrm?.expressionManager?.setValue(earExpressionName, 0);
    } else if (earTwitch.node) {
      earTwitch.node.rotation.copy(earTwitch.baseRot);
    }

    earTwitch = null;
    nextEarTwitchAt =
      elapsed + EAR_TWITCH_MIN_DELAY +
      Math.random() * (EAR_TWITCH_MAX_DELAY - EAR_TWITCH_MIN_DELAY);

    return;
  }

  // Envelope sin² → mulai & berakhir mulus di 0.
  const envelope = Math.sin(t * Math.PI) ** 2;
  // Dua getaran cepat seperti telinga kucing yang berkedip.
  const wiggle = Math.sin(t * Math.PI * 5);

  if (earTwitch.mode === 'expression') {
    vrm?.expressionManager?.setValue(
      earExpressionName,
      wiggle * envelope,
    );
  } else if (earTwitch.node) {
    earTwitch.node.rotation.x =
      earTwitch.baseRot.x + wiggle * 0.14 * envelope;
    earTwitch.node.rotation.z =
      earTwitch.baseRot.z + wiggle * 0.1 * envelope;
  }
}

scheduleBlink();

// ─── Gesture poses ───────────────────────────────────────────────────────────

const GESTURE_POSES = {
  idle: {
    leftArm: { x: 0.15, y: 0, z: -1.1 },
    rightArm: { x: 0.15, y: 0, z: 1.1 },
    leftLowerArm: { x: 0, y: 0, z: -0.3 },
    rightLowerArm: { x: 0, y: 0, z: 0.3 },
  },

  natural: {
    leftArm: { x: 0.10, y: 0.03, z: -1.05 },
    rightArm: { x: 0.13, y: -0.02, z: 1.08 },
    leftLowerArm: { x: 0.05, y: 0.02, z: -0.25 },
    rightLowerArm: { x: 0.02, y: -0.01, z: 0.27 },
  },

  handsOnHip: {
    leftArm: { x: 0.35, y: 0.15, z: -0.75 },
    rightArm: { x: 0.32, y: -0.18, z: 0.78 },
    leftLowerArm: { x: 0.1, y: 0.35, z: -1.05 },
    rightLowerArm: { x: 0.08, y: -0.4, z: 1.1 },
  },

  touchHair: {
    leftArm: { x: 0.12, y: 0, z: -1.0 },
    rightArm: { x: 0.95, y: -0.25, z: 0.55 },
    leftLowerArm: { x: 0, y: 0.05, z: -0.35 },
    rightLowerArm: { x: 0.15, y: -0.55, z: 1.25 },
  },

  scratchHead: {
    leftArm: { x: 0.12, y: 0, z: -1.0 },
    rightArm: { x: 1.05, y: -0.3, z: 0.45 },
    leftLowerArm: { x: 0, y: 0.05, z: -0.35 },
    rightLowerArm: { x: 0.35, y: -0.6, z: 1.35 },
  },

  idleS: [
    {
      leftArm: { x: 0.18, y: 0.06, z: -1.02 },
      rightArm: { x: 0.12, y: -0.05, z: 1.12 },
      leftLowerArm: { x: 0.04, y: 0.02, z: -0.38 },
      rightLowerArm: { x: -0.02, y: -0.02, z: 0.32 },
    },
    {
      leftArm: { x: 0.16, y: 0.03, z: -1.06 },
      rightArm: { x: 0.10, y: -0.02, z: 1.09 },
      leftLowerArm: { x: 0.07, y: 0.01, z: -0.34 },
      rightLowerArm: { x: 0.01, y: -0.01, z: 0.35 },
    },
    {
      leftArm: { x: 0.20, y: 0.01, z: -0.98 },
      rightArm: { x: 0.14, y: -0.06, z: 1.14 },
      leftLowerArm: { x: 0.02, y: 0.03, z: -0.41 },
      rightLowerArm: { x: -0.04, y: -0.02, z: 0.29 },
    },
    {
      leftArm: { x: 0.17, y: 0.05, z: -1.04 },
      rightArm: { x: 0.11, y: -0.03, z: 1.10 },
      leftLowerArm: { x: 0.05, y: 0.01, z: -0.36 },
      rightLowerArm: { x: 0.00, y: -0.02, z: 0.33 },
    },
  ],
};

const ENABLE_SPEAKING_GESTURES = true;

let currentGesture = 'idle';
let gestureBlend = 0;
let gestureInterval = null;

let idlePoseIndex = 0;
let idleVariationTimer = null;

function startIdleVariation() {
  if (idleVariationTimer) return;

  idleVariationTimer = setInterval(() => {
    idlePoseIndex = (idlePoseIndex + 1) % GESTURE_POSES.idleS.length;
  }, 5000);
}

function stopIdleVariation() {
  if (idleVariationTimer) {
    clearInterval(idleVariationTimer);
    idleVariationTimer = null;
  }
}

function setGesture(gestureName) {
  if (!GESTURE_POSES[gestureName]) return;

  currentGesture = gestureName;
  gestureBlend = 0;
}

// ─── Contextual gestures: driven by speech content, not randomness ──────────
//
// Gesture selection reads the actual sentence Nyra is about to say:
//   agreement   → nod (mengangguk)
//   disagreement→ head shake (menggeleng)
//   else        → subtle posture shifts only (natural/idle)

function planContextualGestures(text) {
  if (!text) return;

  // Tidak ada konteks khusus → postur halus, bukan gerakan acak.
  setGesture('natural');
}

function scheduleSubtleShift() {
  if (gestureInterval) {
    clearInterval(gestureInterval);
  }

  gestureInterval = setInterval(() => {
    if (appState !== 'speaking') return;

    // Hanya ganti antara postur natural dan idle saat masih bicara panjang.
    const next = currentGesture === 'natural' ? 'idle' : 'natural';

    setGesture(next);
  }, 4500);
}

function startSpeakingGestures(text = null) {
  if (!ENABLE_SPEAKING_GESTURES) return;

  stopIdleVariation();

  if (gestureInterval) {
    clearInterval(gestureInterval);
    gestureInterval = null;
  }

  // Pilih gesture dari isi pembicaraan, bukan acak.
  planContextualGestures(text);

  scheduleSubtleShift();
}

function stopSpeakingGestures() {
  if (gestureInterval) {
    clearInterval(gestureInterval);
    gestureInterval = null;
  }

  setGesture('idleS');
  startIdleVariation();
}

function applyGesturePose(poseName, lerpFactor = 0.08) {
  let pose = GESTURE_POSES[poseName];

  if (!pose) return;

  if (Array.isArray(pose)) {
    pose = pose[idlePoseIndex % pose.length];
  }

  gestureBlend = Math.min(1, gestureBlend + lerpFactor);

  const transitionFactor = THREE.MathUtils.lerp(
    lerpFactor * 0.5,
    lerpFactor,
    gestureBlend,
  );

  const target = {
    leftArm: { ...pose.leftArm },
    rightArm: { ...pose.rightArm },
    leftLowerArm: { ...pose.leftLowerArm },
    rightLowerArm: { ...pose.rightLowerArm },
  };

  const blendRotation = (bone, rotation) => {
    if (!bone) return;

    bone.rotation.x = THREE.MathUtils.lerp(
      bone.rotation.x,
      rotation.x,
      transitionFactor,
    );

    bone.rotation.y = THREE.MathUtils.lerp(
      bone.rotation.y,
      rotation.y,
      transitionFactor,
    );

    bone.rotation.z = THREE.MathUtils.lerp(
      bone.rotation.z,
      rotation.z,
      transitionFactor,
    );
  };

  blendRotation(boneLeftArm, target.leftArm);
  blendRotation(boneRightArm, target.rightArm);
  blendRotation(boneLeftLowerArm, target.leftLowerArm);
  blendRotation(boneRightLowerArm, target.rightLowerArm);
}

// ─── Head actions: nod & shake ───────────────────────────────────────────────

let headAction = null;
const HEAD_ACTION_DURATION = 1200;

function startHeadAction(type) {
  if (type !== 'nod' && type !== 'shake') return;

  headAction = {
    type,
    start: performance.now(),
    duration: HEAD_ACTION_DURATION,
  };
}

function headActionCurve(t) {
  return Math.sin(t * Math.PI) ** 1.4;
}

function updateHeadAction() {
  if (!headAction) return { x: 0, y: 0 };

  const t =
    (performance.now() - headAction.start) /
    headAction.duration;

  if (t >= 1) {
    headAction = null;
    return { x: 0, y: 0 };
  }

  const cycle = Math.sin(t * Math.PI * 4);
  const amp = headActionCurve(t);

  if (headAction.type === 'nod') {
    return { x: cycle * 0.22 * amp, y: 0 };
  }

  return { x: 0, y: cycle * 0.3 * amp };
}

const NOD_WORDS =
  /(うん|はい|そうだよ|そうそう|いいよ|もちろん|もちろん!|当然|わかった|了解|賛成|トップ|バッチリ|その通り|本当に|ほんとに|すごい|えらい|大丈夫|だいじょうぶ)/;

const NOD_WORDS_ID_EN =
  /(^|[\s,.!?'"])(iya|iya+|yoi|yap|yups|betul|benar|setuju|boleh|silakan|mantap|bagus|keren|ok|oke|okeh|okey|sip|siap|baik|tentu|pasti|jelas|banget|yes|yeah|sure|of\s+course|right|exactly|correct|great|nice|awesome|agreed)(?=$|[\s,.!?'"])/i;

const SHAKE_WORDS =
  /(ううん|うううん|いや|だめ|ダメ|違う|ちがう|無理|むり|できない|ちょっと違う|断る|拒否|やだ|嫌だ)/;

const SHAKE_WORDS_ID_EN =
  /(^|[\s,.!?'"])(nggak|ngga|gak|ga|nggak\s+boleh|tidak|tak\s+bisa|gak\s+bisa|gak\s+mau|jangan|gak\s+usah|tidak\s+setuju|belum|salah|keliru|no|nope|never|wrong|can't|cannot|don't)(?=$|[\s,.!?'"])/i;

function detectHeadAction(text) {
  if (!text) return null;
  if (
    SHAKE_WORDS.test(text) ||
    SHAKE_WORDS_ID_EN.test(text)
  ) {
    return 'shake';
  }

  if (
    NOD_WORDS.test(text) ||
    NOD_WORDS_ID_EN.test(text)
  ) {
    return 'nod';
  }

  return null;
}

// ─── State reactions ─────────────────────────────────────────────────────────

const STATE_REACTIONS = {
  listening: { lean: 0.06, headTiltZ: 0.05, headUp: 0.0 },
  thinking: { lean: 0.0, headTiltZ: 0.08, headUp: 0.10 },
  speaking: { lean: 0.0, headTiltZ: 0.0, headUp: 0.0 },
  idle: { lean: 0.0, headTiltZ: 0.0, headUp: 0.0 },
};

const stateReaction = {
  lean: 0,
  headTiltZ: 0,
  headUp: 0,
};

// ─── Eye tracking ────────────────────────────────────────────────────────────

const chatPanelEl = document.getElementById('chat-history');
const _gazePos = new THREE.Vector3();
const _gazeDir = new THREE.Vector3();

function gazePosFromElement(el, out, depth = 1.2) {
  if (!el) {
    return out
      .copy(camera.position)
      .add(new THREE.Vector3(0, 0, -depth));
  }

  const cr = canvas.getBoundingClientRect();
  const r = el.getBoundingClientRect();

  const nx =
    (((r.left + r.width / 2) - cr.left) / cr.width) * 2 - 1;

  const ny =
    -(((r.top + r.height / 2) - cr.top) / cr.height) * 2 + 1;

  _gazeDir
    .set(nx, ny, 0.5)
    .unproject(camera)
    .sub(camera.position)
    .normalize();

  return out
    .copy(camera.position)
    .addScaledVector(_gazeDir, depth);
}

function updateGaze(elapsed, delta) {
  let desired;

  switch (appState) {
    case 'listening':
      desired = _gazePos.copy(camera.position);
      break;

    case 'thinking':
      desired = _gazePos.set(
        Math.sin(elapsed * 0.3) * 1.0,
        1.6,
        1.0,
      );
      break;

    case 'speaking': {
      const readingPanel = (elapsed % 6) < 4.2;

      desired = readingPanel
        ? gazePosFromElement(chatPanelEl, _gazePos)
        : _gazePos.copy(camera.position);

      break;
    }

    default:
      desired = _gazePos.set(0, 1.35, 4);
      break;
  }

  gazeTarget.position.lerp(
    desired,
    Math.min(1, delta * 4),
  );

  if (!hasLookAt && hasLookExpressions && vrm?.expressionManager) {
    if (appState === 'thinking') {
      vrm.expressionManager.setValue('lookUp', 0.35);

      vrm.expressionManager.setValue(
        'lookLeft',
        0.2 * (Math.sin(elapsed * 0.3) >= 0 ? 1 : -1),
      );
    } else {
      vrm.expressionManager.setValue('lookUp', 0);
      vrm.expressionManager.setValue('lookLeft', 0);
    }
  }
}

function detectLookExpressions(vrmObj) {
  const exp = vrmObj?.expressionManager;

  if (!exp || typeof exp.getExpression !== 'function') return;

  try {
    hasLookExpressions =
      exp.getExpression('lookUp') != null &&
      exp.getExpression('lookLeft') != null;
  } catch {
    hasLookExpressions = false;
  }
}

// ─── State management ─────────────────────────────────────────────────────────

function setThinkingStep(label = null) {
  thinkingStep = label;

  if (appState === 'thinking') {
    const statusText = document.getElementById('status-text');

    if (statusText) {
      statusText.textContent = label || 'berpikir…';
    }
  }
}

function setState(state) {
  appState = state;

  const indicator = document.getElementById('status-indicator');
  const statusText = document.getElementById('status-text');
  const btnMic = document.getElementById('btn-mic');

  switch (state) {
    case 'listening':
      indicator?.classList.remove('hidden');

      if (statusText) {
        statusText.textContent = '🎙 mendengarkan…';
      }

      btnMic?.classList.toggle('recording', autoListeningEnabled);
      break;

    case 'thinking':
      indicator?.classList.remove('hidden');

      if (statusText) {
        statusText.textContent = thinkingStep || 'berpikir…';
      }

      btnMic?.classList.remove('recording');
      break;

    case 'speaking':
      indicator?.classList.remove('hidden');

      if (statusText) {
        statusText.textContent = 'berbicara…';
      }

      break;

    default:
      indicator?.classList.add('hidden');
      btnMic?.classList.remove('recording');
      stopSpeakingGestures();
      break;
  }
}

// ─── Chat history ─────────────────────────────────────────────────────────────

const MAX_HISTORY = 12;
const conversationHistory = [];

function parseTranslation(text) {
  if (!text || typeof text !== 'string') {
    return { mainText: '', translation: null };
  }

  const match = text.match(
    /^(.*?)(?:\r?\n\s*Terjemahan\s*:\s*(.+))$/is,
  );

  if (!match) {
    return { mainText: text.trim(), translation: null };
  }

  const mainText = (match[1] || '').trim();
  const translation = (match[2] || '').trim();

  return {
    mainText: mainText || text.trim(),
    translation: translation || null,
  };
}

function addMessage(role, text, translation = null) {
  conversationHistory.push({ role, content: text });

  if (conversationHistory.length > MAX_HISTORY) {
    conversationHistory.shift();
  }

  const history = document.getElementById('chat-history');
  const bubble = document.createElement('div');

  bubble.className = `msg ${role}`;

  const mainLine = document.createElement('div');
  mainLine.className = 'msg-main';
  mainLine.textContent = text;

  bubble.appendChild(mainLine);

  if (translation) {
    const translationLine = document.createElement('div');

    translationLine.className = 'msg-translation';
    translationLine.textContent = `Terjemahan: ${translation}`;

    bubble.appendChild(translationLine);
  }

  history.appendChild(bubble);
  history.scrollTop = history.scrollHeight;
}

// ─── Progress bubble ──────────────────────────────────────────────────────────

let progressBubbleEl = null;

function showProgress(label) {
  const history = document.getElementById('chat-history');

  if (!progressBubbleEl) {
    progressBubbleEl = document.createElement('div');
    progressBubbleEl.className = 'msg progress';
    history.appendChild(progressBubbleEl);
  }

  progressBubbleEl.textContent = label;
  history.scrollTop = history.scrollHeight;
}

function hideProgress() {
  progressBubbleEl?.remove();
  progressBubbleEl = null;
}

// ─── Vision intent detection ─────────────────────────────────────────────────

const SCREEN_WORDS =
  /(layar|screen|screenshot|tangkapan\s+layar|tampilan|display|monitor|desktop|apa\s+yang\s+(?:ada\s+)?di\s+(?:layar|screen))/i;

const VISION_VERBS =
  /(lihat|liat|lihatin|baca|bacain|cek|cekin|periksa|analisa|analisis|analisasikan|tengok|tinjau|scan|identifikasi|jelaskan|jelasin|kenapa|kok|gimana|bagaimana|error|salah|masalah|bantu|tolong|apa\s+(?:itu|ini)|itu\s+apa|ini\s+apa)/i;

function getVisionCommand(text) {
  const t = text.trim();

  if (!t) return null;

  if (SCREEN_WORDS.test(t) && VISION_VERBS.test(t)) {
    return t;
  }

  if (
    /(analisa|analisis|periksa|cek|lihat|liat|baca|jelaskan|jelasin|bantu)\s+(?:isi\s+|soal\s+|tentang\s+)?(?:ini|yang\s+ini|itu)/i.test(t)
  ) {
    return t;
  }

  if (
    /(analisa|analisis|periksa|cek|lihat|liat|baca|jelaskan|jelasin)\s+(?:isi\s+)?(?:tampilan|aplikasi|app|game|web(?:site)?|halaman|dokumen|kode|code)/i.test(t)
  ) {
    return t;
  }

  if (
    /(layar|screen)\s+(?:aku|saya|ku|ini)\s+(?:error|salah|kenapa|kok)/i.test(t)
  ) {
    return t;
  }

  if (/(apa\s+itu|itu\s+apa|ini\s+apa)/i.test(t) && SCREEN_WORDS.test(t)) {
    return t;
  }

  if (/screenshot|tangkapan\s+layar/i.test(t)) {
    return t;
  }

  return null;
}

// ─── Open-app intent detection ───────────────────────────────────────────────

const APP_NAME_ALIASES = {
  'vs code': 'vscode',
  'visual studio code': 'vscode',
  vsc: 'vscode',
  coding: 'vscode',
  ide: 'vscode',
  'windows terminal': 'terminal',
  cmd: 'cmd',
  'command prompt': 'cmd',
  'task manager': 'task manager',
  'manajer tugas': 'task manager',
  pengaturan: 'settings',
  setting: 'settings',
};

function getOpenAppCommand(text) {
  const raw = text.trim().match(
    /^\s*(?:(?:tolong\s+)?nyra[\s,]*)?(?:tolong\s+)?buka(?:kan)?\s+(.+?)\s*$/i,
  )?.[1];

  if (!raw) return null;

  const appName = raw.trim().replace(
    /^(?:aplikasi|app)\s+/i,
    '',
  );

  return APP_NAME_ALIASES[appName.toLowerCase()] || appName;
}

// ─── Vision pipeline ─────────────────────────────────────────────────────────

async function runVisionFlow(userPrompt) {
  setState('thinking');
  setThinkingStep('Sedang mengambil gambar...');

  const patienceLine = '少し待ってね、確認するから〜';
  const patienceTranslation = 'Sabar ya, aku cek dulu~';

  await playTTSAndLipsync(
    patienceLine,
    'happy',
    () => addMessage('assistant', patienceLine, patienceTranslation),
  );

  showProgress('Sedang mengambil gambar layar…');
  setThinkingStep('Sedang menganalisis dengan AI…');

  const visionResult = await window.nyra.readScreen(userPrompt);

  if (visionResult.ok) {
    showProgress('📦 Sedang menganalisis dengan AI…');
    setThinkingStep('🗣 menyiapkan jawaban…');
    hideProgress();

    await playTTSAndLipsync(
      visionResult.text,
      'neutral',
      () => addMessage(
        'assistant',
        visionResult.text,
        visionResult.translation,
      ),
    );
  } else {
    console.error('[Pipeline] Vision failed:', visionResult.error);

    showProgress('📦 menganalisis dengan AI…');
    setThinkingStep('🗣 menyiapkan jawaban…');
    hideProgress();

    const fallback =
      visionResult.fallbackText ||
      'すみません、今はまだそれを見ることができません。';

    const fallbackTr =
      visionResult.fallbackTranslation ||
      'Maaf, saat ini Nyra belum bisa melihatnya.';

    await playTTSAndLipsync(
      fallback,
      'sad',
      () => addMessage('assistant', fallback, fallbackTr),
    );
  }

  setThinkingStep(null);
  setState('listening');
}

// ─── Main input pipeline ──────────────────────────────────────────────────────

async function handleUserInput(text) {
  if (
    !text.trim() ||
    appState === 'thinking' ||
    appState === 'speaking'
  ) {
    return;
  }

  const visionRequest = getVisionCommand(text);

  if (visionRequest) {
    addMessage('user', text);
    await runVisionFlow(visionRequest);
    return;
  }

  const requestedApp = getOpenAppCommand(text);

  if (requestedApp) {
    addMessage('user', text);
    setState('thinking');

    const result = await window.nyra.openApp(requestedApp);

    const response = result.ok
      ? `Oke, ${requestedApp} sudah dibuka.`
      : `Maaf, aku belum bisa membuka ${requestedApp}.`;

    addMessage('assistant', response);
    setState('listening');
    return;
  }

  console.log('[Pipeline] Sending transcript to LLM');

  addMessage('user', text);
  setState('thinking');

  let llmResult;

  try {
    llmResult = await window.nyra.chat(
      conversationHistory.filter((m) => m.role !== 'system'),
      thinkingEffort,
    );
  } catch (err) {
    console.error('[Pipeline] LLM IPC failed:', err);
    setState('listening');
    return;
  }

  if (!llmResult.ok) {
    console.error('[Pipeline] LLM failed:', llmResult.error);

    addMessage(
      'assistant',
      'eh, ada yang error nih… coba lagi ya~',
    );

    setState('listening');
    return;
  }

  if (/^\s*\[vision\]\s*$/i.test(llmResult.text || '')) {
    console.log('[Pipeline] LLM flagged [vision] → running vision pipeline');

    await runVisionFlow(text);
    return;
  }

  const parsedReply = parseTranslation(llmResult.text);
  const reply = parsedReply.mainText;

  console.log('[Pipeline] LLM response received, sending to VOICEVOX');

  try {
    await playTTSAndLipsync(
      reply,
      llmResult.emotion,
      () => addMessage(
        'assistant',
        reply,
        parsedReply.translation,
      ),
    );
  } catch (err) {
    console.error('[Pipeline] TTS playback failed:', err);
  }

  setState('listening');
}

// ─── TTS + lipsync ────────────────────────────────────────────────────────────

let audioCtx = null;

function getAudioContext() {
  if (!audioCtx || audioCtx.state === 'closed') {
    audioCtx = new AudioContext();
  }

  return audioCtx;
}

let lipsyncVolume = 0;
let lipsyncActive = false;

const supportedEmotions = new Set([
  'happy',
  'sad',
  'surprised',
  'neutral',
  'angry',
]);

const emotionBlendMap = {
  jealous: { angry: 0.4, sad: 0.3, neutral: 0.3 },
  lonely: { sad: 0.6, neutral: 0.4 },
  worried: { sad: 0.5, neutral: 0.5 },
  playful: { happy: 0.7, surprised: 0.3 },
  sulky: { sad: 0.4, angry: 0.2, neutral: 0.4 },
};

let activeEmotion = 'neutral';

const EMOTION_FADE_SPEED = 3.0;

function getEmotionWeights(emotion) {
  if (supportedEmotions.has(emotion)) {
    return { [emotion]: 1.0 };
  }

  const blend = emotionBlendMap[emotion];

  if (blend) {
    return { ...blend };
  }

  return { neutral: 1.0 };
}

function updateEmotions(delta) {
  if (!vrm?.expressionManager) return;

  const exp = vrm.expressionManager;
  const targets = getEmotionWeights(activeEmotion);
  const factor = Math.min(1, EMOTION_FADE_SPEED * delta);

  for (const base of supportedEmotions) {
    const target = targets[base] ?? 0;
    const current = exp.getValue(base) ?? 0;

    const next = Math.abs(target - current) < 0.01
      ? target
      : THREE.MathUtils.lerp(current, target, factor);

    exp.setValue(base, next);
  }
}

async function playTTSAndLipsync(
  text,
  emotion = 'neutral',
  onSpeechStart = null,
) {
  setState('speaking');

  const ttsResult = await window.nyra.synthesize(text);

  if (!ttsResult.ok) {
    console.error('[Pipeline] VOICEVOX failed:', ttsResult.error);

    if (ttsResult.error === 'voicevox_offline') {
      console.warn('[TTS] VOICEVOX offline — skipping audio');
    }

    applySpeechExpression(text, emotion);
    onSpeechStart?.();
    setState('listening');

    return;
  }

  const ctx = getAudioContext();
  let audioBuf;

  try {
    audioBuf = await ctx.decodeAudioData(ttsResult.audio);
  } catch (err) {
    applySpeechExpression(text, emotion);
    onSpeechStart?.();
    throw err;
  }

  const source = ctx.createBufferSource();
  const analyser = ctx.createAnalyser();

  analyser.fftSize = 256;
  source.buffer = audioBuf;
  source.connect(analyser);
  analyser.connect(ctx.destination);

  const dataArray = new Uint8Array(analyser.frequencyBinCount);

  lipsyncActive = true;

  function updateLipsync() {
    if (!lipsyncActive) return;

    analyser.getByteFrequencyData(dataArray);

    const avg =
      dataArray.reduce((sum, value) => sum + value, 0) /
      dataArray.length;

    lipsyncVolume = Math.min(avg / 128, 1);

    requestAnimationFrame(updateLipsync);
  }

  updateLipsync();

  applySpeechExpression(text, emotion);
  onSpeechStart?.();
  source.start();

  await new Promise((resolve) => {
    source.onended = () => {
      lipsyncActive = false;
      lipsyncVolume = 0;
      activeEmotion = 'neutral';
      resolve();
    };
  });
}

function applySpeechExpression(text, emotion) {
  activeEmotion = emotion || 'neutral';

  const headActionType = detectHeadAction(text);

  if (headActionType) {
    startHeadAction(headActionType);
  }

  if (appState === 'speaking') {
    // Gesture dipilih berdasarkan isi kalimat yang sedang diucapkan.
    startSpeakingGestures(text);
  }
}

// ─── Always-on voice recording ────────────────────────────────────────────────

let mediaRecorder = null;
let audioChunks = [];
let micStream = null;
let micAnalyser = null;
let micData = null;
let vadFrame = null;
let micSource = null;
let silenceStartedAt = 0;
let speechStarted = false;
let autoListeningEnabled = false;

const VAD_THRESHOLD = 0.065;
const SILENCE_DURATION_MS = 1800;
const MIN_SPEECH_DURATION_MS = 600;

let speechStartTime = 0;

const btnMic = document.getElementById('btn-mic');

function getSupportedMimeType() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
  ];

  return candidates.find(
    (type) => MediaRecorder.isTypeSupported(type),
  ) || '';
}

function getMicVolume() {
  micAnalyser.getByteTimeDomainData(micData);

  let sum = 0;

  for (const value of micData) {
    const normalized = (value - 128) / 128;
    sum += normalized * normalized;
  }

  return Math.sqrt(sum / micData.length);
}

function beginSpeechCapture() {
  if (mediaRecorder || appState !== 'listening') return;

  audioChunks = [];

  const mimeType = getSupportedMimeType();

  mediaRecorder = new MediaRecorder(
    micStream,
    mimeType ? { mimeType } : undefined,
  );

  mediaRecorder.ondataavailable = (event) => {
    if (event.data.size > 0) {
      audioChunks.push(event.data);
    }
  };

  mediaRecorder.onstop = finishSpeechCapture;
  mediaRecorder.start(250);

  speechStarted = true;
  speechStartTime = performance.now();
  silenceStartedAt = 0;

  console.log('[VAD] Speech detected, recording started');
}

async function finishSpeechCapture() {
  const recorder = mediaRecorder;
  const speechDuration = performance.now() - speechStartTime;

  mediaRecorder = null;
  speechStarted = false;
  silenceStartedAt = 0;
  speechStartTime = 0;

  if (speechDuration < MIN_SPEECH_DURATION_MS) {
    console.log(
      `[VAD] Speech too short (${speechDuration.toFixed(0)}ms), discarded`,
    );

    audioChunks = [];
    setState('listening');
    return;
  }

  if (!recorder || !audioChunks.length) {
    setState('listening');
    return;
  }

  setState('thinking');

  const blob = new Blob(audioChunks, {
    type: recorder.mimeType || 'audio/webm',
  });

  audioChunks = [];

  const arrayBuffer = await blob.arrayBuffer();
  const sttResult = await window.nyra.transcribe(arrayBuffer);

  if (!sttResult.ok || !sttResult.text) {
    console.warn('[STT] No transcript — playing fallback message');

    audioChunks = [];
    setState('listening');

    const cantHearLine =
      'Aku tidak dapat mendengar sesuatu, bisa tolong diulangi?';

    try {
      await playTTSAndLipsync(
        cantHearLine,
        'worried',
        () => addMessage('assistant', cantHearLine),
      );
    } catch (err) {
      console.error('[Pipeline] Fallback TTS failed:', err);
    }

    return;
  }

  console.log('[STT] Transcript:', sttResult.text);

  setState('listening');
  await handleUserInput(sttResult.text);
}

function monitorVoiceActivity() {
  if (!autoListeningEnabled || !micAnalyser) return;

  const volume = getMicVolume();
  const canListen = appState === 'listening';

  if (canListen && volume >= VAD_THRESHOLD) {
    if (!speechStarted) {
      beginSpeechCapture();
    }

    silenceStartedAt = 0;
  } else if (speechStarted && volume < VAD_THRESHOLD) {
    if (!silenceStartedAt) {
      silenceStartedAt = performance.now();
    }

    if (
      performance.now() - silenceStartedAt >= SILENCE_DURATION_MS &&
      mediaRecorder?.state === 'recording'
    ) {
      mediaRecorder.stop();
    }
  } else if (!canListen) {
    silenceStartedAt = 0;
  }

  vadFrame = requestAnimationFrame(monitorVoiceActivity);
}

function stopAlwaysListening() {
  autoListeningEnabled = false;

  stopIdleVariation();

  if (vadFrame) {
    cancelAnimationFrame(vadFrame);
    vadFrame = null;
  }

  if (mediaRecorder) {
    mediaRecorder.onstop = null;

    if (mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }

    mediaRecorder = null;
  }

  audioChunks = [];
  speechStarted = false;
  speechStartTime = 0;
  silenceStartedAt = 0;

  micSource?.disconnect();
  micSource = null;
  micAnalyser = null;
  micData = null;

  micStream?.getTracks().forEach((track) => track.stop());
  micStream = null;

  btnMic.classList.remove('recording');
  btnMic.title = 'Aktifkan mendengar otomatis';

  if (appState === 'listening') {
    setState('idle');
  }

  console.log('[VAD] Always-listening microphone stopped');
}

async function startAlwaysListening() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
    });

    const ctx = getAudioContext();
    await ctx.resume();

    micSource = ctx.createMediaStreamSource(micStream);
    micAnalyser = ctx.createAnalyser();
    micAnalyser.fftSize = 512;
    micData = new Uint8Array(micAnalyser.fftSize);

    micSource.connect(micAnalyser);

    btnMic.title = 'Mendengarkan otomatis';

    setState('listening');
    monitorVoiceActivity();

    console.log('[VAD] Always-listening microphone ready');
  } catch (err) {
    console.error('[Mic] Permission denied or unavailable:', err);

    autoListeningEnabled = false;
    btnMic.title = 'Mikrofon tidak tersedia';
  }
}

btnMic.addEventListener('click', async () => {
  if (autoListeningEnabled) {
    stopAlwaysListening();
    return;
  }

  autoListeningEnabled = true;
  btnMic.title = 'Mengaktifkan mikrofon...';

  await startAlwaysListening();
});

autoListeningEnabled = true;
startAlwaysListening();

// ─── Text input ───────────────────────────────────────────────────────────────

const textInput = document.getElementById('text-input');
const btnSend = document.getElementById('btn-send');

async function submitText() {
  const text = textInput.value.trim();

  if (!text) return;

  textInput.value = '';
  await handleUserInput(text);
}

btnSend.addEventListener('click', submitText);

textInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submitText();
  }
});

// ─── Thinking-effort picker ──────────────────────────────────────────────────

const btnThinking = document.getElementById('btn-thinking');
const thinkingLabel = document.getElementById('thinking-label');
const thinkingMenu = document.getElementById('thinking-menu');

const THINKING_EFFORTS = ['low', 'medium', 'high'];

let thinkingEffort = 'low';

try {
  const saved = localStorage.getItem('nyra_thinking_effort');

  if (THINKING_EFFORTS.includes(saved)) {
    thinkingEffort = saved;
  }
} catch {
  // Storage unavailable — keep default.
}

function applyThinkingEffortUI() {
  thinkingLabel.textContent =
    thinkingEffort === 'low'
      ? 'Low'
      : thinkingEffort === 'medium'
        ? 'Medium'
        : 'High';

  thinkingMenu.querySelectorAll('.thinking-option').forEach((opt) => {
    opt.classList.toggle(
      'active',
      opt.dataset.effort === thinkingEffort,
    );
  });
}

function setThinkingEffort(effort) {
  if (!THINKING_EFFORTS.includes(effort)) return;

  thinkingEffort = effort;

  try {
    localStorage.setItem('nyra_thinking_effort', effort);
  } catch {
    // Ignore unavailable storage.
  }

  applyThinkingEffortUI();
}

btnThinking.addEventListener('click', (e) => {
  e.stopPropagation();
  thinkingMenu.classList.toggle('hidden');
});

thinkingMenu.querySelectorAll('.thinking-option').forEach((opt) => {
  opt.addEventListener('click', (e) => {
    e.stopPropagation();

    setThinkingEffort(opt.dataset.effort);
    thinkingMenu.classList.add('hidden');
  });
});

document.addEventListener('click', (e) => {
  if (
    !thinkingMenu.classList.contains('hidden') &&
    !e.target.closest('#thinking-picker')
  ) {
    thinkingMenu.classList.add('hidden');
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    thinkingMenu.classList.add('hidden');
  }
});

applyThinkingEffortUI();

// ─── Window controls ──────────────────────────────────────────────────────────

document
  .getElementById('btn-close')
  .addEventListener('click', () => window.nyra.closeWindow());

document
  .getElementById('btn-minimize')
  .addEventListener('click', () => window.nyra.minimizeWindow());

// ─── Right-click hold drag ───────────────────────────────────────────────────

const DRAG_EXCLUDE_SELECTOR =
  '#input-row, #chat-history, #drag-bar, button, input, textarea';

let dragging = false;
let dragLastX = 0;
let dragLastY = 0;

document.addEventListener('contextmenu', (e) => {
  if (
    dragging ||
    !e.target.closest(DRAG_EXCLUDE_SELECTOR)
  ) {
    e.preventDefault();
  }
});

document.addEventListener('mousedown', (e) => {
  if (e.button !== 2 || e.target.closest(DRAG_EXCLUDE_SELECTOR)) {
    return;
  }

  dragging = true;
  dragLastX = e.screenX;
  dragLastY = e.screenY;

  e.preventDefault();
});

document.addEventListener('mousemove', (e) => {
  if (!dragging) return;

  const dx = e.screenX - dragLastX;
  const dy = e.screenY - dragLastY;

  dragLastX = e.screenX;
  dragLastY = e.screenY;

  if (dx !== 0 || dy !== 0) {
    window.nyra.dragWindow({
      deltaX: dx,
      deltaY: dy,
    });
  }
});

document.addEventListener('mouseup', (e) => {
  if (e.button === 2) {
    dragging = false;
  }
});

window.addEventListener('blur', () => {
  dragging = false;
});

// ─── Animation loop ───────────────────────────────────────────────────────────

const clock = new THREE.Clock();
let restPoseApplied = false;

function animate() {
  requestAnimationFrame(animate);

  const delta = clock.getDelta();
  const elapsed = clock.elapsedTime;

  if (vrm) {
    if (!restPoseApplied && boneLeftArm) {
      setGesture('idleS');
      startIdleVariation();
      restPoseApplied = true;
    }

    // Kedipan telinga kucing — selalu aktif di semua state
    // (idle, listening, thinking, maupun speaking).
    updateEarTwitch(elapsed);

    // Breathing
    const breathe = Math.sin(elapsed * 1.6) * 0.012;

    if (boneSpine) boneSpine.rotation.x = breathe * 0.6;
    if (boneChest) boneChest.rotation.x = breathe;
    if (boneUpperChest) boneUpperChest.rotation.x = breathe * 0.8;

    // Body sway
    const speaking = appState === 'speaking';

    const swayAmplitude = speaking ? 0.027 : 0.018;

    const sway =
      Math.sin(elapsed * (speaking ? 1.35 : 1.05)) *
      swayAmplitude;

    if (boneHips) {
      boneHips.rotation.z = THREE.MathUtils.lerp(
        boneHips.rotation.z,
        sway,
        0.08,
      );
    }

    if (boneSpine) {
      boneSpine.rotation.z = THREE.MathUtils.lerp(
        boneSpine.rotation.z,
        sway * 0.5,
        0.08,
      );
    }

    // Natural head movement
    const emotionHeadMod =
      activeEmotion === 'happy' || activeEmotion === 'playful'
        ? 1.15
        : activeEmotion === 'sad' || activeEmotion === 'lonely'
          ? 0.7
          : 1.0;

    const headY = (
      Math.sin(elapsed * (speaking ? 1.1 : 0.7) + 1.2) *
        (speaking ? 0.075 : 0.06) +
      Math.sin(elapsed * (speaking ? 2.0 : 1.4) + 0.3) *
        (speaking ? 0.035 : 0.025)
    ) * emotionHeadMod;

    const headX = (
      Math.sin(elapsed * (speaking ? 1.0 : 0.55) + 2.1) *
        (speaking ? 0.065 : 0.04) +
      breathe * 0.4
    ) * emotionHeadMod;

    const headZ =
      Math.sin(elapsed * (speaking ? 0.85 : 0.5) + 0.8) *
      (speaking ? 0.025 : 0.015) *
      emotionHeadMod;

    const action = updateHeadAction();
    const actionX = action.x;
    const actionY = action.y;

    const reactionTarget =
      STATE_REACTIONS[appState] || STATE_REACTIONS.idle;

    const reactEase = Math.min(1, 4.0 * delta);

    stateReaction.lean = THREE.MathUtils.lerp(
      stateReaction.lean,
      reactionTarget.lean,
      reactEase,
    );

    stateReaction.headTiltZ = THREE.MathUtils.lerp(
      stateReaction.headTiltZ,
      reactionTarget.headTiltZ,
      reactEase,
    );

    stateReaction.headUp = THREE.MathUtils.lerp(
      stateReaction.headUp,
      reactionTarget.headUp,
      reactEase,
    );

    // Listening lean overlay
    const leanPulse = Math.sin(elapsed * 0.9) * 0.008;

    if (boneUpperChest) {
      boneUpperChest.rotation.x += stateReaction.lean + leanPulse;
    }

    if (boneChest) {
      boneChest.rotation.x +=
        (stateReaction.lean + leanPulse) * 0.5;
    }

    // Eye tracking
    updateGaze(elapsed, delta);

    if (boneHead) {
      boneHead.rotation.y = THREE.MathUtils.lerp(
        boneHead.rotation.y,
        headY + actionY,
        0.14,
      );

      boneHead.rotation.x = THREE.MathUtils.lerp(
        boneHead.rotation.x,
        headX + actionX + stateReaction.headUp,
        0.14,
      );

      boneHead.rotation.z = THREE.MathUtils.lerp(
        boneHead.rotation.z,
        headZ + stateReaction.headTiltZ,
        0.08,
      );
    }

    if (boneNeck) {
      boneNeck.rotation.y = THREE.MathUtils.lerp(
        boneNeck.rotation.y,
        (headY + actionY) * 0.4,
        0.08,
      );

      boneNeck.rotation.x = THREE.MathUtils.lerp(
        boneNeck.rotation.x,
        (headX + actionX + stateReaction.headUp) * 0.3,
        0.08,
      );

      boneNeck.rotation.z = THREE.MathUtils.lerp(
        boneNeck.rotation.z,
        stateReaction.headTiltZ * 0.6,
        0.08,
      );
    }

    // Gesture animation
    applyGesturePose(currentGesture, 0.08);

    // Emotion expressions
    updateEmotions(delta);

    // Lipsync
    if (vrm.expressionManager) {
      if (lipsyncActive) {
        const mouthCycle =
          Math.sin(elapsed * 12) * 0.15 + 0.85;

        vrm.expressionManager.setValue(
          'aa',
          lipsyncVolume * 0.9 * mouthCycle,
        );
      } else {
        const cur =
          vrm.expressionManager.getValue('aa') ?? 0;

        vrm.expressionManager.setValue('aa', cur * 0.75);
      }
    }

    // Update VRM internals
    vrm.update(delta);
  }

  renderer.render(scene, camera);
}

animate();