// ============================================
// Relay Main Renderer
// ============================================

const transcriptEl = document.getElementById('transcript');
const statusTextEl = document.getElementById('status-text');
const dotEl = document.getElementById('status-dot');
const captionBar = document.getElementById('caption-bar');
const alertOverlay = document.getElementById('alert-overlay');

console.log("App.js loading...");
try {
    if (window.electronAPI) window.electronAPI.log("App.js started loading");
} catch (e) {
    console.error("IPC not available", e);
}

// Import all modules
import { MLSoundDetector } from './ml-sound-detector.js';
import { CaptionRenderer } from './caption-renderer.js';
import { AlertSystem } from './alert-system.js';
import { ScreenExplainer } from './screen-explainer.js';
import { CommandBar } from './command-bar.js';
import { MeetingMode } from './meeting-mode.js';
import { TranscriptStore } from './transcript-store.js';
import { ConfusionDetector } from './confusion-detector.js';
import { MusicVisualizer } from './music-visualizer.js';
import { DirectionalAudio } from './directional-audio.js';
import { BlindMode } from './blind-mode.js';
import { SoundFeedback } from './sound-feedback.js';
import { MediaPipeGestureInput } from './mediapipe-gesture-input.js';
import { ToneCaptioning } from './tone-captioning.js';
import { ModeSwitcher } from './mode-switcher.js';
import './navigator.js';

// Global error handler
window.addEventListener('error', (event) => {
    if (window.electronAPI) {
        window.electronAPI.log(`Renderer Error: ${event.message} at ${event.filename}:${event.lineno}`);
    }
});

// ============================================
// DOM ELEMENTS
// ============================================
const closeBtn = document.getElementById('close-btn');
const ttsToggle = document.getElementById('tts-toggle');
const ttsContainer = document.getElementById('tts-container');
const ttsInput = document.getElementById('tts-input');
const ttsOutputSelect = document.getElementById('tts-output-select');
const canvas = document.getElementById('visualizer');
const canvasCtx = canvas.getContext('2d');
const guidanceLayer = document.getElementById('layer-3-guidance');
const alertContainer = document.getElementById('layer-1-alerts');
const meetingBadge = document.getElementById('meeting-badge');
const confusionHelp = document.getElementById('confusion-help');
const confusionMsg = document.getElementById('confusion-msg');
const gesturePanel = document.getElementById('gesture-panel');
const gesturePanelSpacer = document.getElementById('gesture-panel-spacer');
const gestureWidgetToggleBtn = document.getElementById('gesture-widget-toggle');
const gesturePanelDisableBtn = document.getElementById('gesture-panel-disable');

// ============================================
// SETTINGS
// ============================================
let appSettings = {};
const commandRouterState = {
    mode: 'global',
    cooldownMs: 1800,
    maxWords: 8
};
const wakeCommandState = {
    enabled: true,
    phrase: 'hey relay',
    aliases: ['hey relay'],
    strict: true,
    allowStopWithoutWake: true
};
const recentRoutedPhrases = new Map();
let deepgramFeedbackMuteUntil = 0;
const automationState = {
    context: {
        app: '',
        target: '',
        recipient: '',
        intent: '',
        timestamp: 0
    },
    inFlight: false,
    pendingConfirmation: null
};
const compoundCaptureState = {
    pendingRaw: '',
    pendingSource: 'deepgram',
    expiresAt: 0,
    timerId: null
};
const wakeContinuationState = {
    source: '',
    phrase: '',
    expiresAt: 0
};
const partialVoiceCommandState = {
    command: '',
    source: '',
    expiresAt: 0
};
const blindConfirmationState = {
    lastKey: '',
    lastTs: 0
};
const gestureCommandRoutingState = {
    lastCommand: '',
    lastTs: 0
};
const gestureSpeechState = {
    lastKey: '',
    lastTs: 0
};
const immediateStopState = {
    lastTs: 0
};
const contextualWakeAssistState = {
    inFlight: false,
    lastPrompt: '',
    lastTs: 0
};
let gestureWidgetOpen = true;
const ROUTABLE_GESTURE_COMMANDS = new Set(['yes', 'no', 'stop', 'click']);
const SPOKEN_GESTURE_BY_ID = new Map([
    ['thumbup', 'yes'],
    ['thumbdown', 'no'],
    ['openpalm', 'stop'],
    ['pointingup', 'click'],
    ['iloveyou', 'i love you'],
    ['victory', 'victory'],
    ['closedfist', 'closed fist']
]);

function toGestureLookupKey(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
}

function toSpokenGestureText(value) {
    const normalized = canonicalizeCommandPhrase(normalizeSignPhrase(value));
    if (!normalized) return '';
    const lookupKey = toGestureLookupKey(normalized);
    if (lookupKey === 'iloveyou') return 'I love you';
    return normalized;
}

function syncCommandRouterSettings() {
    // Product default: commands are globally active across modes.
    commandRouterState.mode = 'global';
    commandRouterState.cooldownMs = Math.max(500, Number(appSettings.voiceCommandCooldownMs || 1800));
    commandRouterState.maxWords = Math.max(2, Number(appSettings.voiceCommandMaxWords || 8));

    const wakeEnabled = appSettings.wakePhraseEnabled !== false;
    const wakePhrase = String(appSettings.wakePhrase || 'hey relay').trim().toLowerCase();
    const wakeAliasesRaw = Array.isArray(appSettings.wakePhraseAliases)
        ? appSettings.wakePhraseAliases
        : [];
    const wakeAliases = new Set(
        wakeAliasesRaw
            .map((item) => normalizeSignPhrase(item))
            .filter(Boolean)
    );
    if (wakePhrase) wakeAliases.add(normalizeSignPhrase(wakePhrase));
    wakeCommandState.enabled = wakeEnabled;
    wakeCommandState.phrase = wakePhrase || 'hey relay';
    wakeCommandState.aliases = [...wakeAliases];
    wakeCommandState.strict = appSettings.wakePhraseStrict !== false;
    wakeCommandState.allowStopWithoutWake = appSettings.wakePhraseAllowStopWithoutWake !== false;
}

function clearCompoundCapture() {
    if (compoundCaptureState.timerId) {
        clearTimeout(compoundCaptureState.timerId);
    }
    compoundCaptureState.pendingRaw = '';
    compoundCaptureState.pendingSource = 'deepgram';
    compoundCaptureState.expiresAt = 0;
    compoundCaptureState.timerId = null;
}

function clearWakeContinuation() {
    wakeContinuationState.source = '';
    wakeContinuationState.phrase = '';
    wakeContinuationState.expiresAt = 0;
}

function setPendingPartialVoiceCommand(command, source = 'deepgram') {
    partialVoiceCommandState.command = String(command || '').trim();
    partialVoiceCommandState.source = String(source || 'deepgram');
    partialVoiceCommandState.expiresAt = Date.now() + 2600;
}

function clearPendingPartialVoiceCommand() {
    partialVoiceCommandState.command = '';
    partialVoiceCommandState.source = '';
    partialVoiceCommandState.expiresAt = 0;
}

async function loadSettings() {
    try {
        appSettings = await window.electronAPI.getAllSettings();
        syncCommandRouterSettings();
    } catch (e) {
        console.warn('Failed to load settings, using defaults');
        syncCommandRouterSettings();
    }
}

// ============================================
// CLICK-THROUGH: pass events through except over Relay UI
// ============================================
const clickThroughState = {
    ignoringMouse: null
};
const mainWidgetDragState = {
    isDragging: false,
    startMouseX: 0,
    startMouseY: 0,
    startOffsetX: 0,
    startOffsetY: 0,
    offsetX: 0,
    offsetY: 0
};

function setOverlayIgnoreMouse(ignore) {
    if (clickThroughState.ignoringMouse === Boolean(ignore)) return;
    clickThroughState.ignoringMouse = Boolean(ignore);
    if (ignore) {
        window.electronAPI?.setIgnoreMouseEvents(true, { forward: true });
    } else {
        window.electronAPI?.setIgnoreMouseEvents(false);
    }
}

function isVisibleInteractiveRoot(node) {
    if (!node) return false;
    const style = window.getComputedStyle(node);
    if (!style) return false;
    if (style.display === 'none') return false;
    if (style.visibility === 'hidden') return false;
    if (style.pointerEvents === 'none') return false;
    if (Number(style.opacity || '1') <= 0) return false;
    return true;
}

function isMouseOverRelayUi(target) {
    if (!target || !(target instanceof Element)) return false;
    const interactiveRoot = target.closest(
        '#caption-bar, #gesture-panel, #layer-1-alerts, #layer-3-guidance, #layer-4-emergency, #confusion-help, #audio-guide-modal, #meeting-summary-modal, .modal-overlay, #mode-dropdown'
    );
    if (!interactiveRoot) return false;
    return isVisibleInteractiveRoot(interactiveRoot);
}

function syncClickThroughFromPointer(clientX, clientY) {
    const target = document.elementFromPoint(clientX, clientY);
    const overRelayUi = isMouseOverRelayUi(target);
    setOverlayIgnoreMouse(!overRelayUi);
}

function handlePointerSync(event) {
    if (!event || typeof event.clientX !== 'number' || typeof event.clientY !== 'number') return;
    if (mainWidgetDragState.isDragging) return;
    syncClickThroughFromPointer(event.clientX, event.clientY);
}

document.addEventListener('mousemove', handlePointerSync, true);
document.addEventListener('mousedown', handlePointerSync, true);
document.addEventListener('mouseup', handlePointerSync, true);
window.addEventListener('focus', () => {
    mainWidgetDragState.isDragging = false;
    document.body.style.userSelect = '';
    setOverlayIgnoreMouse(false);
});
window.addEventListener('blur', () => {
    mainWidgetDragState.isDragging = false;
    document.body.style.userSelect = '';
    setOverlayIgnoreMouse(true);
    gesturePanelDockState.isDragging = false;
    if (gesturePanel) gesturePanel.dataset.dragging = 'false';
});
setOverlayIgnoreMouse(false);

const captionToolbarForDrag = captionBar?.querySelector('.caption-toolbar');

const gesturePanelDockState = {
    mode: 'docked',
    isDragging: false,
    dragOffsetX: 0,
    dragOffsetY: 0,
    floatingX: 16,
    floatingY: 16
};

function clampNumber(value, min, max) {
    const numeric = Number(value);
    const lower = Number.isFinite(min) ? min : 0;
    const upperCandidate = Number.isFinite(max) ? max : lower;
    const upper = Math.max(lower, upperCandidate);
    if (!Number.isFinite(numeric)) return lower;
    return Math.max(lower, Math.min(upper, numeric));
}

function resolveMainWidgetBaseRect() {
    if (!captionBar) return { left: 0, top: 0, width: 900, height: 230 };
    const rect = captionBar.getBoundingClientRect();
    const width = rect.width || captionBar.offsetWidth || 900;
    const height = rect.height || captionBar.offsetHeight || 230;
    return {
        left: rect.left - mainWidgetDragState.offsetX,
        top: rect.top - mainWidgetDragState.offsetY,
        width,
        height
    };
}

function clampMainWidgetOffset(x, y) {
    const baseRect = resolveMainWidgetBaseRect();
    const pad = 8;
    const minX = pad - baseRect.left;
    const maxX = window.innerWidth - pad - (baseRect.left + baseRect.width);
    const minY = pad - baseRect.top;
    const maxY = window.innerHeight - pad - (baseRect.top + baseRect.height);
    return {
        x: clampNumber(x, minX, maxX),
        y: clampNumber(y, minY, maxY)
    };
}

function applyMainWidgetOffset(x, y) {
    if (!captionBar) return;
    const clamped = clampMainWidgetOffset(x, y);
    mainWidgetDragState.offsetX = clamped.x;
    mainWidgetDragState.offsetY = clamped.y;
    if (clamped.x === 0 && clamped.y === 0) {
        captionBar.style.transform = '';
    } else {
        captionBar.style.transform = `translate(${clamped.x}px, ${clamped.y}px)`;
    }
}

function setupMainWidgetDrag() {
    if (!captionToolbarForDrag || !captionBar) return;

    const pinMouse = () => setOverlayIgnoreMouse(false);
    captionToolbarForDrag.addEventListener('mouseenter', pinMouse, true);
    captionToolbarForDrag.addEventListener('mousemove', pinMouse, true);
    captionToolbarForDrag.addEventListener('mousedown', (event) => {
        pinMouse();
        if (event.button !== 0) return;
        if (event.target.closest('button, input, select, textarea, a')) return;
        event.preventDefault();
        mainWidgetDragState.isDragging = true;
        mainWidgetDragState.startMouseX = event.clientX;
        mainWidgetDragState.startMouseY = event.clientY;
        mainWidgetDragState.startOffsetX = mainWidgetDragState.offsetX;
        mainWidgetDragState.startOffsetY = mainWidgetDragState.offsetY;
        document.body.style.userSelect = 'none';
    }, true);

    document.addEventListener('mousemove', (event) => {
        if (!mainWidgetDragState.isDragging) return;
        const dx = event.clientX - mainWidgetDragState.startMouseX;
        const dy = event.clientY - mainWidgetDragState.startMouseY;
        applyMainWidgetOffset(
            mainWidgetDragState.startOffsetX + dx,
            mainWidgetDragState.startOffsetY + dy
        );
    });

    document.addEventListener('mouseup', (event) => {
        if (!mainWidgetDragState.isDragging) return;
        mainWidgetDragState.isDragging = false;
        document.body.style.userSelect = '';
        if (event && typeof event.clientX === 'number' && typeof event.clientY === 'number') {
            syncClickThroughFromPointer(event.clientX, event.clientY);
        }
    });
}

function updateGesturePanelDockStateOnBody() {
    if (!gesturePanel) return;
    const isDocked = gesturePanelDockState.mode === 'docked';
    gesturePanel.dataset.panelState = isDocked ? 'docked' : 'floating';
    document.body.dataset.gesturePanelDocked = isDocked ? 'true' : 'false';
}

function resolveGesturePanelSize() {
    if (!gesturePanel) return { width: 320, height: 380 };
    const rect = gesturePanel.getBoundingClientRect();
    const width = rect.width || gesturePanel.offsetWidth || 320;
    const height = rect.height || gesturePanel.offsetHeight || 380;
    return { width, height };
}

function clampGestureFloatingPosition(x, y) {
    const { width, height } = resolveGesturePanelSize();
    const pad = 8;
    const maxX = Math.max(pad, window.innerWidth - width - pad);
    const maxY = Math.max(pad, window.innerHeight - height - pad);
    return {
        x: clampNumber(x, pad, maxX),
        y: clampNumber(y, pad, maxY)
    };
}

function dockGesturePanel({ resetFloating = false } = {}) {
    if (!gesturePanel) return;
    gesturePanelDockState.mode = 'docked';
    gesturePanelDockState.isDragging = false;
    gesturePanel.dataset.dragging = 'false';
    gesturePanel.style.left = '';
    gesturePanel.style.top = '';
    gesturePanel.style.right = '';
    gesturePanel.style.bottom = '';
    if (resetFloating) {
        gesturePanelDockState.floatingX = 16;
        gesturePanelDockState.floatingY = 16;
    }
    updateGesturePanelDockStateOnBody();
    syncGesturePanelSpacer();
}

function floatGesturePanelAt(x, y) {
    if (!gesturePanel) return;
    const clamped = clampGestureFloatingPosition(x, y);
    gesturePanelDockState.mode = 'floating';
    gesturePanelDockState.floatingX = clamped.x;
    gesturePanelDockState.floatingY = clamped.y;
    gesturePanel.style.left = `${clamped.x}px`;
    gesturePanel.style.top = `${clamped.y}px`;
    gesturePanel.style.right = 'auto';
    gesturePanel.style.bottom = 'auto';
    updateGesturePanelDockStateOnBody();
    syncGesturePanelSpacer();
}

function clampFloatingPanelsAfterResize() {
    if (gesturePanel && gesturePanelDockState.mode === 'floating') {
        floatGesturePanelAt(gesturePanelDockState.floatingX, gesturePanelDockState.floatingY);
    }
    syncGesturePanelSpacer();
    if (window.cvNavigator?.repositionDocked) {
        window.cvNavigator.repositionDocked();
    }
}

function syncGesturePanelSpacer() {
    if (!gesturePanelSpacer || !gesturePanel) return;
    const inLayoutFlow = gesturePanelDockState.mode !== 'floating' && gesturePanel.style.display !== 'none';
    gesturePanelSpacer.style.display = inLayoutFlow ? 'none' : 'block';
}

function setupGesturePanelDocking() {
    if (!gesturePanel) return;
    const panelHeader = gesturePanel.querySelector('.gesture-panel-header');
    if (!panelHeader) return;

    dockGesturePanel({ resetFloating: true });

    panelHeader.addEventListener('mousedown', (event) => {
        if (event.button !== 0) return;
        if (event.target.closest('button, input, select, textarea, a')) return;
        if (String(document.body?.dataset?.accessibilityMode || '').toLowerCase() === 'blind') return;

        event.preventDefault();
        const rect = gesturePanel.getBoundingClientRect();
        if (gesturePanelDockState.mode !== 'floating') {
            floatGesturePanelAt(rect.left, rect.top);
        }

        const nextRect = gesturePanel.getBoundingClientRect();
        gesturePanelDockState.dragOffsetX = event.clientX - nextRect.left;
        gesturePanelDockState.dragOffsetY = event.clientY - nextRect.top;
        gesturePanelDockState.isDragging = true;
        gesturePanel.dataset.dragging = 'true';
        setOverlayIgnoreMouse(false);
    });

    panelHeader.addEventListener('dblclick', () => {
        dockGesturePanel();
    });

    document.addEventListener('mousemove', (event) => {
        if (!gesturePanelDockState.isDragging) return;
        const targetX = event.clientX - gesturePanelDockState.dragOffsetX;
        const targetY = event.clientY - gesturePanelDockState.dragOffsetY;
        floatGesturePanelAt(targetX, targetY);
    });

    document.addEventListener('mouseup', (event) => {
        if (!gesturePanelDockState.isDragging) return;
        gesturePanelDockState.isDragging = false;
        gesturePanel.dataset.dragging = 'false';
        if (event && typeof event.clientX === 'number' && typeof event.clientY === 'number') {
            syncClickThroughFromPointer(event.clientX, event.clientY);
        }
    });
}
setupMainWidgetDrag();
setupGesturePanelDocking();
syncGesturePanelSpacer();

// ============================================
// INITIALIZE MODULES
// ============================================

// Caption Renderer
const captionRenderer = new CaptionRenderer(transcriptEl, appSettings);

// Alert System
const alertSystem = new AlertSystem(alertContainer, {
    enabledCategories: appSettings.alertCategories,
    onHapticRequest: (pattern) => {
        if (window.electronAPI?.triggerHaptic) {
            window.electronAPI.triggerHaptic(pattern);
        }
    },
});

// Screen Explainer
const screenExplainer = new ScreenExplainer(guidanceLayer);

// Command Bar
const commandBar = new CommandBar(guidanceLayer, {
    onAction: handleAction,
});

// Meeting Mode
const meetingMode = new MeetingMode({
    onMeetingStart: (appInfo) => {
        meetingMode.bindBadgeElement(meetingBadge);
        meetingMode.updateBadge();
        statusTextEl.innerText = `Meeting Mode: ${appInfo.name}`;
    },
    onMeetingEnd: async (summary) => {
        meetingMode.updateBadge();
        if (appSettings.meetingAutoSummary && summary.transcriptCount > 5) {
            showMeetingSummaryPrompt(summary);
        }
    },
});

// Transcript Store
const transcriptStore = new TranscriptStore();
transcriptStore.init().catch(e => console.warn('TranscriptStore init failed:', e));

// Confusion Detector
const confusionDetector = new ConfusionDetector({
    onSuggestion: (suggestion) => {
        confusionMsg.textContent = suggestion.message;
        confusionHelp.style.display = 'flex';
        confusionHelp.onclick = () => {
            confusionHelp.style.display = 'none';
            handleAction(suggestion.action);
        };
        // Auto-hide after 10s
        setTimeout(() => {
            confusionHelp.style.display = 'none';
        }, 10000);
    },
});

// Music Visualizer
const musicVisualizer = new MusicVisualizer(document.body);

// Directional Audio
const directionalAudio = new DirectionalAudio();

// Blind Mode
const blindMode = new BlindMode();

// Sound Feedback (for all users)
const soundFeedback = new SoundFeedback({ enabled: true, volume: 0.3 });

// MediaPipe gesture input (on-device)
const gestureInput = new MediaPipeGestureInput({
    minConfidence: 0.7,
    commandCandidateMinConfidence: 0.7,
    numHands: 2
});

// Tone Captioning (enhances captions with emotion)
const toneCaptioning = new ToneCaptioning(captionRenderer);

// Mode Switcher
const modeSwitcher = new ModeSwitcher();
window.modeSwitcher = modeSwitcher;

// Sound Detector (YAMNet-enhanced)
let soundDetector;

// ============================================
// SOURCE SELECTOR
// ============================================
const sourcesSelect = document.createElement('select');
sourcesSelect.style.cssText = `
    position: absolute;
    top: -40px;
    right: 0;
    width: 220px;
    padding: 5px;
    background: var(--color-surface);
    color: var(--color-text);
    border-radius: 8px;
    border: 1px solid var(--color-border);
    font-size: 12px;
    opacity: 0.9;
    cursor: pointer;
    pointer-events: auto;
    -webkit-app-region: no-drag;
`;
document.getElementById('caption-bar').appendChild(sourcesSelect);

const PHONE_MIC_SOURCE = 'phone-mic';
let phoneMicAvailable = false;
let phoneMicDevice = '';

function phoneMicOptionLabel() {
    return phoneMicAvailable ? `Phone Microphone (${phoneMicDevice || 'Remote Mic'})` : 'Phone Microphone (start Remote Mic on your phone)';
}

async function refreshSources() {
    const previousValue = sourcesSelect.value;
    try {
        const sources = await window.electronAPI.getSources();
        sourcesSelect.innerHTML = `
            <option value="mic">Microphone (Default)</option>
            <option value="system-audio">System Audio (Screen)</option>
        `;

        const phoneOption = document.createElement('option');
        phoneOption.value = PHONE_MIC_SOURCE;
        phoneOption.innerText = phoneMicOptionLabel();
        phoneOption.disabled = !phoneMicAvailable;
        sourcesSelect.appendChild(phoneOption);

        if (sources && sources.length > 0) {
            sources.forEach(source => {
                const option = document.createElement('option');
                option.value = source.id;
                option.innerText = source.name;
                sourcesSelect.appendChild(option);
            });
        }
        if ([...sourcesSelect.options].some((option) => option.value === previousValue && !option.disabled)) {
            sourcesSelect.value = previousValue;
        }
    } catch (e) {
        window.electronAPI.log("Error getting sources: " + e);
    }
}

if (window.electronAPI.onCaptionSourceChanged) {
    window.electronAPI.onCaptionSourceChanged((info = {}) => {
        phoneMicAvailable = Boolean(info.remoteMicActive);
        phoneMicDevice = info.device || '';
        const phoneOption = [...sourcesSelect.options].find((option) => option.value === PHONE_MIC_SOURCE);
        if (phoneOption) {
            phoneOption.disabled = !phoneMicAvailable;
            phoneOption.innerText = phoneMicOptionLabel();
        }
        if (info.source === 'phone') {
            if (phoneOption) sourcesSelect.value = PHONE_MIC_SOURCE;
            statusTextEl.innerText = `Listening (Phone Microphone: ${phoneMicDevice || 'Remote Mic'})`;
        } else if (sourcesSelect.value === PHONE_MIC_SOURCE) {
            sourcesSelect.value = 'mic';
            statusTextEl.innerText = 'Listening (Microphone)';
        }
    });
}

sourcesSelect.addEventListener('mouseenter', () => {
    refreshSources();
    window.electronAPI.setIgnoreMouseEvents(false);
});

sourcesSelect.addEventListener('change', async (e) => {
    const value = e.target.value;
    if (value === PHONE_MIC_SOURCE) {
        // Local capture keeps running for sound alerts; captions come from the phone.
        await window.electronAPI.setCaptionSource?.('phone');
        return;
    }
    await window.electronAPI.setCaptionSource?.('local');
    startRecording(value);
});

// ============================================
// BUTTON HANDLERS
// ============================================
closeBtn.addEventListener('click', () => window.electronAPI.quit());

const navToggle = document.getElementById('nav-toggle');
if (navToggle) {
    navToggle.addEventListener('click', () => {
        if (window.cvNavigator) window.cvNavigator.toggle();
    });
}

if (gestureWidgetToggleBtn) {
    gestureWidgetToggleBtn.addEventListener('click', () => {
        setGestureWidgetOpen(!gestureWidgetOpen);
    });
}

if (gesturePanelDisableBtn) {
    gesturePanelDisableBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        setGestureWidgetOpen(false);
    });
}

document.getElementById('minimize-btn').addEventListener('click', () => window.electronAPI.minimize());

const transcriptBtn = document.getElementById('transcript-btn');
if (transcriptBtn) {
    transcriptBtn.addEventListener('click', () => {
        if (window.electronAPI.openTranscriptViewer) {
            window.electronAPI.openTranscriptViewer();
        }
    });
}

function setBlindModeMinimalControls(enabled) {
    const show = !enabled;
    [transcriptBtn, navToggle, gestureWidgetToggleBtn, ttsToggle, audioHelpBtn, sourcesSelect]
        .filter(Boolean)
        .forEach((el) => {
            el.style.display = show ? '' : 'none';
        });

    if (enabled) {
        if (audioGuideModal) audioGuideModal.style.display = 'none';
        if (meetingSummaryModal) meetingSummaryModal.style.display = 'none';
        if (window.cvNavigator && typeof window.cvNavigator.hide === 'function') {
            window.cvNavigator.hide();
        }
    }
}

// Audio output
let selectedAudioOutputId = 'default';

async function loadAudioOutputs() {
    if (!ttsOutputSelect) return;
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const outputs = devices.filter(d => d.kind === 'audiooutput');
        ttsOutputSelect.innerHTML = '<option value="default">Default Output</option>';
        outputs.forEach(device => {
            const option = document.createElement('option');
            option.value = device.deviceId;
            option.label = device.label || `Speaker ${ttsOutputSelect.length + 1}`;
            ttsOutputSelect.appendChild(option);
        });
    } catch (e) {}
}

if (ttsOutputSelect) {
    ttsOutputSelect.addEventListener('change', (e) => {
        selectedAudioOutputId = e.target.value;
    });
}

loadAudioOutputs();

// Audio help guide
const audioHelpBtn = document.getElementById('audio-help-btn');
const audioGuideModal = document.getElementById('audio-guide-modal');
const closeGuideBtn = document.getElementById('close-guide-btn');

if (audioHelpBtn) {
    audioHelpBtn.addEventListener('click', () => {
        audioGuideModal.style.display = 'flex';
        window.electronAPI.setIgnoreMouseEvents(false);
    });
}
if (closeGuideBtn) {
    closeGuideBtn.addEventListener('click', () => {
        audioGuideModal.style.display = 'none';
    });
}

// TTS
ttsToggle.addEventListener('click', () => {
    ttsContainer.classList.toggle('active');
    if (ttsContainer.classList.contains('active')) {
        ttsInput.focus();
        window.electronAPI.setIgnoreMouseEvents(false);
        loadAudioOutputs();
    }
});

ttsInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        const text = ttsInput.value;
        if (text) {
            captionRenderer.addFinalSegment({
                transcript: `You: ${text}`,
                words: [],
                confidence: 1,
            });
            speakText(text);
            ttsInput.value = '';
        }
    }
});

async function speakText(text) {
    if (!text) return;
    try {
        statusTextEl.innerText = "Generating Speech...";
        const result = await window.electronAPI.ttsSpeak(text);
        if (result.success) {
            const audio = new Audio(result.path);
            if (selectedAudioOutputId !== 'default' && typeof audio.setSinkId === 'function') {
                await audio.setSinkId(selectedAudioOutputId);
            }
            audio.play();
            statusTextEl.innerText = "Speaking (Natural AI)";
            audio.onended = () => { statusTextEl.innerText = "Listening..."; };
        } else {
            throw new Error(result.error);
        }
    } catch (e) {
        window.electronAPI.log("TTS Error: " + e);
        const speech = new SpeechSynthesisUtterance(text);
        window.speechSynthesis.speak(speech);
        statusTextEl.innerText = "Speaking (System)";
    }
}

// Meeting summary modal
const meetingSummaryModal = document.getElementById('meeting-summary-modal');
const meetingSummaryContent = document.getElementById('meeting-summary-content');
document.getElementById('close-summary-btn')?.addEventListener('click', () => {
    meetingSummaryModal.style.display = 'none';
});
document.getElementById('export-summary-btn')?.addEventListener('click', async () => {
    const content = meetingSummaryContent.textContent;
    if (window.electronAPI.exportTranscript) {
        await window.electronAPI.exportTranscript('txt', content);
    }
});

async function showMeetingSummaryPrompt(meetingData) {
    statusTextEl.innerText = "Generating meeting summary...";
    try {
        const result = await meetingMode.generateSummary();
        if (result && result.success) {
            meetingSummaryContent.textContent = result.summary;
            meetingSummaryModal.style.display = 'flex';
            window.electronAPI.setIgnoreMouseEvents(false);
        }
    } catch (e) {
        console.error('Summary generation failed:', e);
    }
    statusTextEl.innerText = "Listening...";
}

// ============================================
// CONTEXT AWARENESS
// ============================================
const contextSuggestions = {
    'zoom.us': { icon: '📹', name: 'Zoom', message: "Zoom Meeting - Connect Audio?", intent: 'connect-audio', sourceHint: 'zoom' },
    'facetime': { icon: '📱', name: 'FaceTime', message: "FaceTime Call - Connect Audio?", intent: 'connect-audio', sourceHint: 'facetime' },
    'microsoft teams': { icon: '👥', name: 'Teams', message: "Teams Meeting - Connect Audio?", intent: 'connect-audio', sourceHint: 'teams' },
    'discord': { icon: '🎮', name: 'Discord', message: "Discord Active - Caption Voice Chat?", intent: 'connect-audio', sourceHint: 'discord' },
    'google meet': { icon: '🟢', name: 'Google Meet', message: "Google Meet - Connect Audio?", intent: 'connect-audio', sourceHint: 'meet' },
    'webex': { icon: '🌐', name: 'Webex', message: "Webex Meeting - Connect Audio?", intent: 'connect-audio', sourceHint: 'webex' },
    'slack': { icon: '💬', name: 'Slack', message: "Slack Huddle? Connect Audio?", intent: 'connect-audio', sourceHint: 'slack' },
    'skype': { icon: '📞', name: 'Skype', message: "Skype Call - Connect Audio?", intent: 'connect-audio', sourceHint: 'skype' },
};

const dismissedApps = new Set();
let currentDetectedApp = null;
let contextIndicator = null;

function createContextIndicator() {
    if (contextIndicator) return;
    contextIndicator = document.createElement('div');
    contextIndicator.id = 'context-indicator';
    contextIndicator.style.cssText = `
        position: absolute;
        top: -35px;
        left: 10px;
        background: var(--color-surface);
        color: var(--color-text);
        padding: 6px 12px;
        border-radius: 15px;
        font-size: 12px;
        display: flex;
        align-items: center;
        gap: 6px;
        opacity: 0.9;
        border: 1px solid var(--color-border);
        pointer-events: auto;
        transition: all 0.3s ease;
    `;
    contextIndicator.innerHTML = `<span id="context-icon">🎤</span> <span id="context-app">Listening</span>`;
    captionBar.appendChild(contextIndicator);
}

function updateContextIndicator(icon, appName) {
    if (!contextIndicator) createContextIndicator();
    const iconEl = document.getElementById('context-icon');
    const appEl = document.getElementById('context-app');
    if (iconEl && appEl) {
        iconEl.innerText = icon;
        appEl.innerText = appName;
        if (appName !== 'Listening') {
            contextIndicator.style.background = 'var(--color-accent)';
            contextIndicator.style.color = 'white';
            contextIndicator.style.borderColor = 'var(--color-accent)';
        } else {
            contextIndicator.style.background = 'var(--color-surface)';
            contextIndicator.style.color = 'var(--color-text)';
            contextIndicator.style.borderColor = 'var(--color-border)';
        }
    }
}

createContextIndicator();

if (window.electronAPI?.onContextUpdate) {
    window.electronAPI.onContextUpdate((appNameRaw) => {
        const appName = appNameRaw.toLowerCase();

        // Update meeting mode
        if (appSettings.meetingAutoDetect !== false) {
            meetingMode.checkContext(appNameRaw);
            meetingMode.updateBadge();
        }

        // Update confusion detector
        confusionDetector.recordActivity();

        let match = null;
        let matchKey = null;
        for (const [key, data] of Object.entries(contextSuggestions)) {
            if (appName.includes(key)) {
                match = data;
                matchKey = key;
                break;
            }
        }

        if (match) {
            updateContextIndicator(match.icon, match.name);
            currentDetectedApp = match;
            if (!dismissedApps.has(matchKey)) {
                showContextSuggestion(match.message, match.intent, match.sourceHint, matchKey);
            }
        } else {
            updateContextIndicator('🎤', 'Listening');
            currentDetectedApp = null;
        }
    });
}

function showContextSuggestion(text, intent, sourceHint, appKey) {
    if (document.getElementById('context-toast')) return;
    const toast = document.createElement('div');
    toast.id = 'context-toast';
    toast.style.cssText = `
        position: absolute; bottom: 80px; left: 50%; transform: translateX(-50%);
        background: var(--color-accent); color: white; padding: 12px 20px; border-radius: 20px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.3); font-weight: 600; cursor: pointer;
        opacity: 0; animation: slideUpFade 0.4s forwards; z-index: 100;
        display: flex; align-items: center; gap: 12px; font-size: 14px; pointer-events: auto;
    `;
    toast.innerHTML = `
        <span>${text}</span>
        <button id="toast-yes" style="background:white;color:var(--color-accent);border:none;padding:6px 12px;border-radius:12px;font-weight:600;cursor:pointer;">Yes</button>
        <button id="toast-no" style="background:transparent;color:white;border:1px solid white;padding:6px 12px;border-radius:12px;cursor:pointer;opacity:0.8;">Not now</button>
    `;
    captionBar.appendChild(toast);

    document.getElementById('toast-yes').onclick = (e) => {
        e.stopPropagation();
        handleContextIntent(intent, sourceHint);
        toast.remove();
    };
    document.getElementById('toast-no').onclick = (e) => {
        e.stopPropagation();
        dismissedApps.add(appKey);
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
    };
    setTimeout(() => {
        if (toast.parentNode) {
            toast.style.opacity = '0';
            setTimeout(() => toast.remove(), 300);
        }
    }, 15000);
}

function handleContextIntent(intent, sourceHint) {
    if (intent === 'connect-audio') {
        const options = Array.from(sourcesSelect.options);
        let found = false;
        for (const option of options) {
            if (sourceHint && option.text.toLowerCase().includes(sourceHint)) {
                sourcesSelect.value = option.value;
                sourcesSelect.dispatchEvent(new Event('change'));
                found = true;
                break;
            }
        }
        if (!found) {
            sourcesSelect.style.border = "2px solid var(--color-accent)";
            sourcesSelect.style.boxShadow = "0 0 10px var(--color-accent)";
            setTimeout(() => {
                sourcesSelect.style.border = "1px solid var(--color-border)";
                sourcesSelect.style.boxShadow = "none";
            }, 3000);
        }
    }
}

// ============================================
// GLOBAL SHORTCUT HANDLER
// ============================================
function speakBlindConfirmation(message, key = message, cooldownMs = 1200) {
    if (appSettings.accessibilityMode !== 'blind') return;
    const text = String(message || '').trim();
    if (!text) return;

    const dedupeKey = String(key || text).trim().toLowerCase();
    const now = Date.now();
    if (
        dedupeKey &&
        blindConfirmationState.lastKey === dedupeKey &&
        (now - blindConfirmationState.lastTs) < cooldownMs
    ) {
        return;
    }

    blindConfirmationState.lastKey = dedupeKey;
    blindConfirmationState.lastTs = now;
    deepgramFeedbackMuteUntil = now + 1600;
    blindMode.speak(text);
}

function maybeSpeakActionCompletion(action, { source = 'unknown', extra = '' } = {}) {
    if (source === 'blind-mode') return;

    const completionByAction = {
        'toggle-captions': captionBar.style.display === 'none' ? 'Captions hidden' : 'Captions shown',
        'dismiss-alerts': 'Alerts cleared',
        'open-settings': 'Opening settings',
        'meeting-summary': 'Opening meeting summary',
        'meeting-toggle': 'Meeting mode updated',
        'show-transcripts': 'Opening transcripts',
        'stop-all': 'Stopped'
    };

    const message = completionByAction[action];
    if (!message) return;
    const suffix = String(extra || '').trim();
    speakBlindConfirmation(suffix ? `${message}. ${suffix}` : message, `action:${action}:${suffix}`);
}

function speakRoutedGestureCommand(commandText) {
    if (appSettings.accessibilityMode !== 'deaf') return;
    const spoken = toSpokenGestureText(commandText);
    if (!spoken) return;

    const key = `gesture-route:${toGestureLookupKey(spoken)}`;
    const now = Date.now();

    if (gestureSpeechState.lastKey === key && (now - gestureSpeechState.lastTs) < 2200) {
        return;
    }

    gestureSpeechState.lastKey = key;
    gestureSpeechState.lastTs = now;

    try {
        window.speechSynthesis?.cancel?.();
    } catch (error) {
        // Ignore speech synthesis cancel errors.
    }

    try {
        const utterance = new SpeechSynthesisUtterance(String(spoken));
        utterance.rate = 1;
        utterance.pitch = 1;
        utterance.volume = 1;
        window.speechSynthesis?.speak?.(utterance);
    } catch (error) {
        window.electronAPI?.log?.(`[GestureInput] speech error ${error?.message || error}`);
    }
}

function resolveSpokenGestureCommand(detail, candidate = null) {
    const direct = canonicalizeCommandPhrase(normalizeSignPhrase(candidate?.command || ''));
    if (direct) return direct;

    const hands = Array.isArray(detail?.hands) ? detail.hands : [];
    if (hands.length === 0) return '';
    const sortedHands = [...hands].sort((a, b) => Number(b?.confidence || 0) - Number(a?.confidence || 0));

    for (const hand of sortedHands) {
        const confidence = Number(hand?.confidence || 0);
        if (confidence < 0.55) continue;
        const lookupKey = toGestureLookupKey(hand?.gestureId || hand?.gesture || '');
        if (!lookupKey || lookupKey === 'none') continue;
        const mapped = SPOKEN_GESTURE_BY_ID.get(lookupKey);
        if (mapped) return canonicalizeCommandPhrase(normalizeSignPhrase(mapped));
    }

    return '';
}

if (window.electronAPI?.onShortcut) {
    window.electronAPI.onShortcut((action) => {
        handleAction(action, { source: 'shortcut' });
    });
}

function handleAction(action, { source = 'unknown' } = {}) {
    switch (action) {
        case 'toggle-captions':
            const vis = captionBar.style.display;
            captionBar.style.display = vis === 'none' ? 'flex' : 'none';
            maybeSpeakActionCompletion('toggle-captions', { source });
            break;
        case 'explain-screen':
            screenExplainer.toggle();
            break;
        case 'command-bar':
            commandBar.toggle();
            break;
        case 'request-guidance':
            if (appSettings.accessibilityMode === 'blind') {
                break;
            }
            if (window.cvNavigator) window.cvNavigator.toggle();
            break;
        case 'dismiss-alerts':
            alertSystem.dismissAll();
            alertOverlay.className = '';
            maybeSpeakActionCompletion('dismiss-alerts', { source });
            break;
        case 'caption-larger': {
            const newSize = captionRenderer.increaseFontSize();
            if (window.electronAPI?.setSettings) {
                window.electronAPI.setSettings('captionFontSize', newSize);
            }
            break;
        }
        case 'caption-smaller': {
            const newSize = captionRenderer.decreaseFontSize();
            if (window.electronAPI?.setSettings) {
                window.electronAPI.setSettings('captionFontSize', newSize);
            }
            break;
        }
        case 'open-settings':
            window.electronAPI.openSettings();
            maybeSpeakActionCompletion('open-settings', { source });
            break;
        case 'meeting-summary':
            if (meetingMode.isActive) {
                showMeetingSummaryPrompt();
                maybeSpeakActionCompletion('meeting-summary', { source });
            } else {
                statusTextEl.innerText = 'No active meeting';
                setTimeout(() => {
                    statusTextEl.innerText = 'Listening (Deepgram Nova-3)';
                }, 1400);
                speakBlindConfirmation('No active meeting', 'meeting-summary-empty', 1000);
            }
            break;
        case 'meeting-toggle': {
            const isActive = typeof meetingMode.toggleManualSession === 'function'
                ? meetingMode.toggleManualSession()
                : meetingMode.isActive;
            meetingMode.updateBadge();
            statusTextEl.innerText = isActive ? 'Meeting mode active' : 'Meeting mode ended';
            setTimeout(() => {
                statusTextEl.innerText = 'Listening (Deepgram Nova-3)';
            }, 1400);
            maybeSpeakActionCompletion('meeting-toggle', { source, extra: isActive ? 'Meeting mode active' : 'Meeting mode ended' });
            break;
        }
        case 'show-transcripts':
            if (appSettings.accessibilityMode === 'blind') {
                break;
            }
            if (window.electronAPI.openTranscriptViewer) {
                window.electronAPI.openTranscriptViewer();
                maybeSpeakActionCompletion('show-transcripts', { source });
            }
            break;
        case 'stop-all':
            try { window.speechSynthesis?.cancel?.(); } catch (e) {}
            try { screenExplainer.hide?.(); } catch (e) {}
            try { commandBar.hide?.(); } catch (e) {}
            statusTextEl.innerText = 'Stopped';
            setTimeout(() => {
                statusTextEl.innerText = 'Listening (Deepgram Nova-3)';
            }, 1200);
            maybeSpeakActionCompletion('stop-all', { source });
            break;
        default:
            console.log('Unknown action:', action);
    }
}

// Allow BlindMode and other modules to request the same centralized actions.
window.addEventListener('action-request', (event) => {
    const action = event?.detail?.action;
    if (!action) return;
    handleAction(action, { source: event?.detail?.source || 'event' });
});

window.addEventListener('command-executed', (event) => {
    const detail = event?.detail || {};
    const status = detail.success ? 'success' : 'miss';
    const command = detail.command || 'unknown';
    const source = detail.source || 'unknown';
    window.electronAPI?.log?.(`[CommandRouter] ${status} command=${command} source=${source} phrase=\"${detail.normalized || ''}\"`);
    if (detail.success) {
        statusTextEl.innerText = `Command: ${command}`;
        setTimeout(() => {
            statusTextEl.innerText = 'Listening (Deepgram Nova-3)';
        }, 1400);
    }
});

window.addEventListener('automation-executed', (event) => {
    const detail = event?.detail || {};
    window.electronAPI?.log?.(
        `[Automation] ${detail.success ? 'success' : 'miss'} intent=${detail.intent || 'unknown'} ` +
        `risk=${detail.risk || 'medium'} source=${detail.source || 'unknown'} ` +
        `confirmed=${detail.confirmed ? 'yes' : 'no'} reason=${detail.reason || 'none'} ` +
        `duration_ms=${Number(detail.duration_ms || 0)}`
    );
});

window.addEventListener('gesture-model-health', (event) => {
    const detail = event?.detail || {};
    const fps = Number(detail.fps || 0).toFixed(1);
    const inference = Number(detail.inference_ms_median || 0).toFixed(2);
    window.electronAPI?.log?.(
        `[GestureModel] fps=${fps} inference_ms=${inference} ` +
        `frames=${Number(detail.frames || 0)} backend=${detail.backend || 'unknown'}`
    );
});

// ============================================
// SETTINGS CHANGE LISTENER
// ============================================
if (window.electronAPI?.onSettingsChanged) {
    window.electronAPI.onSettingsChanged(async (key, value) => {
        if (key === null) {
            appSettings = await window.electronAPI.getAllSettings();
        } else {
            appSettings[key] = value;
        }
        syncCommandRouterSettings();
        // Apply relevant settings
        captionRenderer.updateSettings(appSettings);
        if (appSettings.alertCategories) {
            alertSystem.setEnabledCategories(appSettings.alertCategories);
        }
        if (appSettings.userNames) {
            captionRenderer.setNameWords(appSettings.userNames);
            confusionDetector.setUserNames(appSettings.userNames);
        }
    });
}

// ============================================
// DEEPGRAM STREAMING TRANSCRIPTION
// ============================================
let useWhisperFallback = false;
let whisperWorker = null;
let audioContext = null;
let mediaStream = null;
let scriptProcessor = null;
let isRecording = false;
let isDeepgramStreaming = false;

function setupDeepgramListeners() {
    window.electronAPI.onDeepgramTranscript((result) => {
        if (result.transcript && result.transcript.trim()) {
            if (result.isFinal) {
                captionRenderer.addFinalSegment(result);

                // Global voice command bridge for short command-like phrases
                routeCommandInput(result.transcript, 'deepgram');

                // Store transcript
                transcriptStore.store({
                    text: result.transcript,
                    words: result.words,
                    speaker: result.words?.[0]?.speaker ?? null,
                    confidence: result.confidence,
                    timestamp: Date.now(),
                });

                // Feed to meeting mode
                meetingMode.addTranscript(result);

                // Check for name mentions
                if (result.words) {
                    const nameMention = captionRenderer.checkNameMention(result.words);
                    if (nameMention) {
                        alertSystem.show({
                            category: 'nameMention',
                            label: `"${nameMention}" was mentioned`,
                            detail: result.transcript,
                        });
                        confusionDetector.onNameMentioned(nameMention);
                    }
                }

                statusTextEl.innerText = "Listening (Deepgram Nova-3)";
            } else {
                captionRenderer.setInterim(result);
                statusTextEl.innerText = "Transcribing...";
            }

            confusionDetector.recordActivity();
        }
    });

    window.electronAPI.onDeepgramStatus((status) => {
        if (status.connected) {
            isDeepgramStreaming = true;
            statusTextEl.innerText = "Connected (Deepgram Nova-3)";
            dotEl.classList.add('active');
        } else {
            isDeepgramStreaming = false;
            statusTextEl.innerText = status.error ? `Error: ${status.error}` : "Disconnected";
            dotEl.classList.remove('active');
        }
    });

    window.electronAPI.onDeepgramUtteranceEnd(() => {
        window.electronAPI.log("Utterance ended");
    });
}

function initWhisper() {
    if (whisperWorker) return;
    statusTextEl.innerText = "Initializing Offline Engine...";
    whisperWorker = new Worker('whisper-worker.js', { type: 'module' });
    whisperWorker.onmessage = (e) => {
        const { status, text } = e.data;
        if (status === 'ready') statusTextEl.innerText = "Offline Engine Ready";
        if (status === 'result' && text?.trim()) {
            captionRenderer.addFinalSegment({ transcript: text, words: [], confidence: 0.5 });
        }
    };
    whisperWorker.postMessage({ type: 'load' });
}

async function startRecording(sourceId = 'mic') {
    // Cleanup
    if (scriptProcessor) scriptProcessor.disconnect();
    if (mediaStream) mediaStream.getTracks().forEach(track => track.stop());
    if (audioContext && audioContext.state !== 'closed') audioContext.close();
    isRecording = false;
    captionRenderer.clear();

    try {
        if (sourceId === 'mic') {
            mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    channelCount: 1,
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false
                }
            });
            statusTextEl.innerText = "Listening (Microphone)";
        } else if (sourceId === 'system-audio') {
            // System audio via desktopCapturer
            const sources = await window.electronAPI.getSources();
            const screenSource = sources.find(s => s.id.startsWith('screen:'));
            if (!screenSource) {
                statusTextEl.innerText = "Screen Recording permission required";
                return;
            }
            mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    mandatory: {
                        chromeMediaSource: 'desktop',
                        chromeMediaSourceId: screenSource.id
                    }
                },
                video: {
                    mandatory: {
                        chromeMediaSource: 'desktop',
                        chromeMediaSourceId: screenSource.id,
                        maxWidth: 1,
                        maxHeight: 1,
                    }
                }
            });
            // Stop video tracks - we only want audio
            mediaStream.getVideoTracks().forEach(t => t.stop());
            statusTextEl.innerText = "Listening (System Audio)";
        } else {
            // Specific window/screen source
            mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    mandatory: {
                        chromeMediaSource: 'desktop',
                        chromeMediaSourceId: sourceId
                    }
                },
                video: {
                    mandatory: {
                        chromeMediaSource: 'desktop',
                        chromeMediaSourceId: sourceId
                    }
                }
            });
            mediaStream.getVideoTracks().forEach(t => t.stop());
            statusTextEl.innerText = "Listening (System Audio)";
        }

        audioContext = new AudioContext({ sampleRate: 16000 });
        const source = audioContext.createMediaStreamSource(mediaStream);

        // Setup ML sound detector (falls back to heuristic while model loads)
        soundDetector = new MLSoundDetector(audioContext);
        soundDetector.onDetect((event) => {
            if (event.category === 'media' && event.isMusic) {
                musicVisualizer.show({ genre: event.className });
            } else if (event.category !== 'media') {
                // Clear music vis when non-music detected
                musicVisualizer.hide();
            }

            // Show alert for non-media categories
            if (event.category !== 'media' || appSettings.alertCategories?.media) {
                alertSystem.show({
                    category: event.category,
                    label: event.label,
                    detail: null,
                    className: event.className,
                });
            }

            // Dispatch sound detection event for cross-module accessibility cues
            window.dispatchEvent(new CustomEvent('sound-detected', {
                detail: {
                    category: event.category,
                    label: event.label,
                    direction: event.direction || 'center',
                    timestamp: Date.now()
                }
            }));

            // Legacy alert overlay flash
            const type = event.category === 'emergency' ? 'danger' : 'warning';
            alertOverlay.className = type + " active";
            if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
            
            // Broadcast to connected Mobile Apps
            if (window.electronAPI && window.electronAPI.broadcastAlert) {
                window.electronAPI.broadcastAlert({
                    message: event.label,
                    severity: event.category === 'emergency' ? 'high' : 'normal'
                }).catch(e => console.error("Broadcast failed:", e));
            }

            setTimeout(() => { alertOverlay.className = ""; }, 2000);
        });

        // Use mono path for microphone capture; reserve stereo path for desktop/system capture.
        const preferStereoDetection = sourceId !== 'mic';
        soundDetector.connect(source, preferStereoDetection);

        // Setup directional audio
        directionalAudio.connect(audioContext, source);

        // Connect music visualizer analyser
        const visAnalyser = audioContext.createAnalyser();
        visAnalyser.fftSize = 256;
        source.connect(visAnalyser);
        musicVisualizer.connectAnalyser(visAnalyser);

        // Start Deepgram
        const startResult = await window.electronAPI.deepgramStart();
        if (startResult.success) {
            statusTextEl.innerText = "Connecting to Deepgram...";

            scriptProcessor = audioContext.createScriptProcessor(4096, 1, 1);
            source.connect(scriptProcessor);
            scriptProcessor.connect(audioContext.destination);

            scriptProcessor.onaudioprocess = (e) => {
                const inputData = e.inputBuffer.getChannelData(0);
                const int16Data = float32ToInt16(inputData);
                if (isDeepgramStreaming) {
                    window.electronAPI.deepgramSendAudio(Array.from(int16Data));
                }
                drawVisualizer(inputData);
            };

            isRecording = true;
            dotEl.classList.add('listening');
            dotEl.classList.add('active');
        } else {
            throw new Error(startResult.error || "Failed to connect to Deepgram");
        }
    } catch (err) {
        window.electronAPI.log("Recording error: " + err);
        statusTextEl.innerText = "Error: " + err.message;
        useWhisperFallback = true;
        initWhisper();
    }
}

function float32ToInt16(float32Array) {
    const int16Array = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
        const s = Math.max(-1, Math.min(1, float32Array[i]));
        int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return int16Array;
}

function drawVisualizer(data) {
    if (!canvasCtx) return;
    const width = canvas.width;
    const height = canvas.height;
    canvasCtx.clearRect(0, 0, width, height);

    const sliceWidth = width / 20;
    const chunkSize = Math.floor(data.length / 20);
    let x = 0;

    for (let i = 0; i < 20; i++) {
        let chunkSum = 0;
        for (let j = 0; j < chunkSize; j++) chunkSum += Math.abs(data[i * chunkSize + j]);
        const avg = chunkSum / chunkSize;
        const barHeight = Math.min(avg * height * 8, height);
        const intensity = Math.min(avg * 10, 1);
        canvasCtx.fillStyle = `rgba(0, 113, 227, ${0.4 + intensity * 0.6})`;
        canvasCtx.fillRect(x, (height - barHeight) / 2, sliceWidth - 1, barHeight);
        x += sliceWidth;
    }
}

// Cleanup
window.addEventListener('beforeunload', async () => {
    try { await window.electronAPI.deepgramStop(); } catch (e) {}
    try { gestureInput.stop(); } catch (e) {}
});

// ============================================
// MODE SWITCHER INTEGRATION
// ============================================
function getOverlayViewportHeight() {
    const screenHeight = Number(window.screen?.availHeight || 0);
    const innerHeight = Number(window.innerHeight || 0);
    return Math.max(480, screenHeight, innerHeight);
}

function getAdaptiveOverlayHeight(mode = 'deaf') {
    const viewportHeight = getOverlayViewportHeight();
    if (mode === 'blind') {
        return clampNumber(Math.round(viewportHeight * 0.28), 180, 360);
    }
    const maxDeaf = Math.max(520, viewportHeight - 24);
    return clampNumber(Math.round(viewportHeight * 0.74), 460, maxDeaf);
}

window.__relayGetOverlayHeightForMode = (mode) => getAdaptiveOverlayHeight(mode);

function syncGestureWidgetControls() {
    const isOpen = gestureWidgetOpen === true;
    if (gestureWidgetToggleBtn) {
        gestureWidgetToggleBtn.classList.toggle('active', isOpen);
        gestureWidgetToggleBtn.title = isOpen ? 'Close Sign Widget' : 'Open Sign Widget';
        gestureWidgetToggleBtn.setAttribute('aria-label', isOpen ? 'Close Sign Widget' : 'Open Sign Widget');
    }
    if (gesturePanelDisableBtn) {
        gesturePanelDisableBtn.textContent = isOpen ? 'Close' : 'Open';
        gesturePanelDisableBtn.setAttribute('aria-label', isOpen ? 'Close Sign Widget' : 'Open Sign Widget');
    }
}

function applyGestureWidgetForCurrentMode() {
    const mode = String(document.body?.dataset?.accessibilityMode || appSettings.accessibilityMode || 'deaf').toLowerCase();
    const shouldShow = mode === 'deaf' && gestureWidgetOpen === true;

    if (!gesturePanel) return;

    if (shouldShow) {
        gesturePanel.style.display = 'flex';
        gesturePanel.style.visibility = 'visible';
        gesturePanel.style.pointerEvents = '';
        if (gesturePanelDockState.mode !== 'floating') {
            dockGesturePanel();
        } else {
            clampFloatingPanelsAfterResize();
        }
        gestureInput.start().catch((error) => {
            window.electronAPI?.log?.(`[GestureInput] start failed: ${error?.message || error}`);
        });
        syncGesturePanelSpacer();
        return;
    }

    gestureInput.stop();
    gesturePanel.dataset.active = 'false';
    if (mode === 'blind') {
        if (gesturePanelDockState.mode === 'floating') {
            gesturePanel.style.display = 'none';
        } else {
            // Keep dock geometry stable between Deaf/Blind so the main panel does not shift.
            gesturePanel.style.display = 'flex';
            gesturePanel.style.visibility = 'hidden';
            gesturePanel.style.pointerEvents = 'none';
        }
        syncGesturePanelSpacer();
        return;
    }
    dockGesturePanel();
    gesturePanel.style.visibility = 'visible';
    gesturePanel.style.pointerEvents = '';
    gesturePanel.style.display = 'none';
    syncGesturePanelSpacer();
}

function setGestureWidgetOpen(nextOpen) {
    gestureWidgetOpen = Boolean(nextOpen);
    syncGestureWidgetControls();
    applyGestureWidgetForCurrentMode();
}

window.addEventListener('mode-changed', (e) => {
    const rawMode = String(e?.detail?.mode || '').toLowerCase();
    const mode = rawMode === 'blind' ? 'blind' : 'deaf';
    const previousMode = e?.detail?.previousMode || null;
    console.log(`[App] Mode changed from ${previousMode} to ${mode}`);

    // Single source of truth for mode persistence.
    appSettings.accessibilityMode = mode;
    try {
        window.electronAPI?.setSettings?.('accessibilityMode', mode);
    } catch (error) {
        console.warn('[Mode] Unable to persist accessibilityMode:', error?.message || error);
    }
    document.body.dataset.accessibilityMode = mode;

    // Update mode indicator
    const modeIndicator = document.getElementById('mode-indicator');
    if (modeIndicator) {
        modeIndicator.className = `mode-indicator ${mode}`;
        modeIndicator.style.display = 'flex';
        modeIndicator.setAttribute('aria-label', `Accessibility Mode: ${mode.charAt(0).toUpperCase() + mode.slice(1)}`);
        const modeText = modeIndicator.querySelector('.mode-text');
        if (modeText) {
            modeText.textContent = `${mode.charAt(0).toUpperCase() + mode.slice(1)}`;
        }

    }

    // Handle mode-specific features
    switch(mode) {
        case 'deaf':
            blindMode.deactivate();
            setBlindModeMinimalControls(false);
            applyGestureWidgetForCurrentMode();
            if (transcriptBtn) transcriptBtn.style.display = '';
            // Activate tone captioning
            toneCaptioning.activate();
            // Ensure captions are visible
            captionBar.style.display = 'flex';
            captionBar.style.opacity = '1';
            if (transcriptEl) {
                transcriptEl.style.display = '';
                transcriptEl.setAttribute('aria-hidden', 'false');
            }
            break;
        case 'blind':
            blindMode.activate();
            setBlindModeMinimalControls(true);
            applyGestureWidgetForCurrentMode();
            if (transcriptBtn) transcriptBtn.style.display = '';
            // Keep transcript button available in blind mode for quick screenshots/demos.
            // Deactivate tone captioning (not needed for blind)
            toneCaptioning.deactivate();
            // Keep subtitles visible in blind mode so captions remain available for demos/screenshots.
            captionBar.style.display = 'flex';
            captionBar.style.opacity = '1';
            if (transcriptEl) {
                transcriptEl.style.display = '';
                transcriptEl.setAttribute('aria-hidden', 'false');
            }
            break;
    }

    requestAnimationFrame(() => {
        applyMainWidgetOffset(mainWidgetDragState.offsetX, mainWidgetDragState.offsetY);
    });
});

window.addEventListener('resize', () => {
    applyMainWidgetOffset(mainWidgetDragState.offsetX, mainWidgetDragState.offsetY);
    clampFloatingPanelsAfterResize();
});

// Listen for mode switcher ready
window.addEventListener('mode-switcher-ready', () => {
    console.log('[App] Mode switcher initialized');
});

function normalizeSignPhrase(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

const COMMAND_WORD_ALIASES = new Map([
    ['halp', 'help'],
    ['hepl', 'help'],
    ['hlep', 'help'],
    ['reed', 'read'],
    ['reda', 'read'],
    ['captino', 'caption'],
    ['capiton', 'caption'],
    ['capshun', 'caption'],
    ['capton', 'caption'],
    ['nativage', 'navigate'],
    ['navagate', 'navigate'],
    ['naviagte', 'navigate'],
    ['navgiate', 'navigate'],
    ['naviate', 'navigate'],
    ['nagivite', 'navigate'],
    ['nagivate', 'navigate'],
    ['clik', 'click'],
    ['clic', 'click'],
    ['scrol', 'scroll'],
    ['skroll', 'scroll'],
    ['stpo', 'stop'],
    ['lisen', 'listen'],
    ['lisin', 'listen'],
    ['repat', 'repeat'],
    ['repeet', 'repeat'],
    ['explian', 'explain'],
    ['exlpain', 'explain'],
    ['meting', 'meeting'],
    ['meetin', 'meeting'],
    ['discribe', 'describe'],
    ['desribe', 'describe'],
    ['descrive', 'describe'],
    ['descirbe', 'describe'],
    ['summarise', 'summarize'],
    ['sumarize', 'summarize'],
    ['okey', 'ok'],
    ['imgae', 'image'],
    ['img', 'image'],
    ['poto', 'photo'],
    ['capure', 'capture'],
    ['setings', 'settings'],
    ['seting', 'settings'],
    ['seetings', 'settings'],
    ['largar', 'larger'],
    ['largr', 'larger'],
    ['smaler', 'smaller'],
    ['smallar', 'smaller'],
    ['trascript', 'transcript'],
    ['transcipt', 'transcript'],
    ['transript', 'transcript'],
    ['trasncript', 'transcript'],
    ['transcipts', 'transcripts'],
    ['trascripts', 'transcripts'],
    ['captions', 'caption'],
    ['transcripts', 'transcript'],
    ['pics', 'images'],
    ['pic', 'image'],
    ['photo', 'image'],
    ['photos', 'images']
]);

function canonicalizeCommandPhrase(normalized) {
    if (!normalized) return '';
    return normalized
        .split(' ')
        .filter(Boolean)
        .map((word) => COMMAND_WORD_ALIASES.get(word) || word)
        .join(' ');
}

function shouldRouteVoiceCommands() {
    return true;
}

const WAKE_REQUIRED_SOURCES = new Set(['deepgram', 'speech-recognition']);
const WAKE_BYPASS_COMMANDS = new Set(['stop']);
const RELAY_WAKE_ALT_NAMES = new Set([
    'relay',
    'relai',
    'relays',
    'really',
    'relly',
    'riley',
    'vla',
    'heavylay',
    'relayy',
    'relei'
]);

function escapeRegexLiteral(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getWakePhraseAliases() {
    const aliases = Array.isArray(wakeCommandState.aliases) ? wakeCommandState.aliases : [];
    const normalized = aliases
        .map((item) => canonicalizeCommandPhrase(normalizeSignPhrase(item)))
        .filter(Boolean);
    if (normalized.length === 0) {
        return [canonicalizeCommandPhrase(normalizeSignPhrase(wakeCommandState.phrase || 'hey relay'))];
    }
    return [...new Set(normalized)];
}

function buildWakeAliasRegex(alias) {
    const aliasPattern = String(alias || '')
        .split(/\s+/)
        .filter(Boolean)
        .map((token) => escapeRegexLiteral(token))
        .join('[\\s,!.?:;\\-]+');
    if (!aliasPattern) return null;
    return new RegExp(`(^|[\\s,!.?:;\\-])${aliasPattern}(?:[\\s,!.?:;\\-]|$)`, 'i');
}

function extractWakeQualifiedSegment(rawText) {
    const source = String(rawText || '').trim();
    if (!source) return '';
    const aliases = getWakePhraseAliases();

    let bestIndex = -1;
    for (const alias of aliases) {
        const regex = buildWakeAliasRegex(alias);
        if (!regex) continue;
        const match = regex.exec(source);
        if (!match || typeof match.index !== 'number') continue;
        const start = match.index + (match[1] ? match[1].length : 0);
        if (bestIndex === -1 || start < bestIndex) {
            bestIndex = start;
        }
    }

    if (bestIndex < 0) return '';
    return source.slice(bestIndex).trim();
}

function stripWakePrefixFromText(rawText) {
    const source = String(rawText || '').trim();
    if (!source) return { matched: false, phrase: '', text: '' };

    const aliases = getWakePhraseAliases();
    for (const alias of aliases) {
        if (!alias) continue;
        const aliasPattern = alias
            .split(/\s+/)
            .filter(Boolean)
            .map((token) => escapeRegexLiteral(token))
            .join('[\\s,!.?:;\\-]+');
        const pattern = new RegExp(
            `^\\s*${aliasPattern}(?:[\\s,!.?:;\\-]+|$)`,
            'i'
        );
        if (!pattern.test(source)) continue;
        const stripped = source.replace(pattern, '').trim();
        return { matched: true, phrase: alias, text: stripped };
    }

    // Fallback for common Deepgram wake-word drift (for example "Hey VLA").
    const canonical = canonicalizeCommandPhrase(normalizeSignPhrase(source));
    const tokens = canonical.split(/\s+/).filter(Boolean);
    if (tokens.length >= 3 && (tokens[0] === 'a' || tokens[0] === 'uh' || tokens[0] === 'hey')) {
        const shiftedWake = tokens[1];
        if (RELAY_WAKE_ALT_NAMES.has(shiftedWake)) {
            return {
                matched: true,
                phrase: `${tokens[0]} ${shiftedWake}`,
                text: tokens.slice(2).join(' ').trim()
            };
        }
    }
    if (tokens.length >= 2 && RELAY_WAKE_ALT_NAMES.has(tokens[0])) {
        return {
            matched: true,
            phrase: tokens[0],
            text: tokens.slice(1).join(' ').trim()
        };
    }
    if (tokens.length >= 2 && tokens[0] === 'hey') {
        const aliasWakeNames = new Set(
            aliases
                .map((entry) => entry.split(/\s+/).filter(Boolean))
                .filter((parts) => parts[0] === 'hey' && parts[1])
                .map((parts) => parts[1])
        );
        const wakeName = tokens[1];
        if (aliasWakeNames.has(wakeName) || RELAY_WAKE_ALT_NAMES.has(wakeName)) {
            const strippedText = tokens.slice(2).join(' ').trim();
            return {
                matched: true,
                phrase: `hey ${wakeName}`,
                text: strippedText
            };
        }
    }

    return { matched: false, phrase: '', text: source };
}

function isLikelyCommandSafetyBypass(normalized) {
    const text = String(normalized || '').trim();
    return WAKE_BYPASS_COMMANDS.has(text);
}

function isLikelyActionPhrase(normalized) {
    const text = String(normalized || '').trim();
    if (!text) return false;
    if (/^(help|read|caption|captions|navigate|click|type|press|scroll|stop|listen|repeat|explain|describe|meeting|settings|larger|smaller|open)\b/.test(text)) {
        return true;
    }
    if (isLikelyPremiumAutomationPhrase(text)) {
        return true;
    }
    return /\b(navigate to|click on|type to|type:|send a message|call|play)\b/.test(text);
}

function shouldDeduplicateRoutedPhrase(normalized, source) {
    if (!normalized) return false;
    if (!WAKE_REQUIRED_SOURCES.has(source)) return false;
    const key = `${source}:${normalized}`;
    const now = Date.now();
    const dedupeWindowMs = Math.max(700, Math.min(commandRouterState.cooldownMs, 1700));
    const previous = Number(recentRoutedPhrases.get(key) || 0);
    if (previous && (now - previous) < dedupeWindowMs) {
        return true;
    }
    recentRoutedPhrases.set(key, now);
    if (recentRoutedPhrases.size > 240) {
        const expiry = now - Math.max(dedupeWindowMs * 3, 5000);
        for (const [entryKey, timestamp] of recentRoutedPhrases.entries()) {
            if (timestamp < expiry) {
                recentRoutedPhrases.delete(entryKey);
            }
        }
    }
    return false;
}

function gateCandidateForWakePhrase(candidate, source) {
    const raw = String(candidate || '').trim();
    const normalized = canonicalizeCommandPhrase(normalizeSignPhrase(raw));
    if (!raw || !normalized) {
        return { allowed: false, raw: '', normalized: '', wakeMatched: false, wakePhrase: '', reason: 'empty_phrase' };
    }

    if (!WAKE_REQUIRED_SOURCES.has(source) || !wakeCommandState.enabled || !wakeCommandState.strict) {
        return { allowed: true, raw, normalized, wakeMatched: false, wakePhrase: '', reason: null };
    }

    if (
        isLikelyCommandSafetyBypass(normalized) &&
        (normalized === 'stop' || wakeCommandState.allowStopWithoutWake)
    ) {
        return { allowed: true, raw, normalized, wakeMatched: false, wakePhrase: '', reason: 'wake_bypass' };
    }

    const stripped = stripWakePrefixFromText(raw);
    if (stripped.matched) {
        const strippedNormalized = canonicalizeCommandPhrase(normalizeSignPhrase(stripped.text));
        if (!strippedNormalized) {
            return {
                allowed: false,
                raw: stripped.text,
                normalized: '',
                wakeMatched: true,
                wakePhrase: stripped.phrase,
                reason: 'wake_only'
            };
        }
        return {
            allowed: true,
            raw: stripped.text,
            normalized: strippedNormalized,
            wakeMatched: true,
            wakePhrase: stripped.phrase,
            reason: null
        };
    }

    if (!isLikelyActionPhrase(normalized)) {
        return { allowed: false, raw, normalized, wakeMatched: false, wakePhrase: '', reason: 'not_command_phrase' };
    }

    if (!stripped.matched) {
        return { allowed: false, raw, normalized, wakeMatched: false, wakePhrase: '', reason: 'wake_required' };
    }
    if (!canonicalizeCommandPhrase(normalizeSignPhrase(stripped.text))) {
        return {
            allowed: false,
            raw: stripped.text,
            normalized: '',
            wakeMatched: true,
            wakePhrase: stripped.phrase,
            reason: 'wake_only'
        };
    }

    return { allowed: false, raw, normalized, wakeMatched: false, wakePhrase: '', reason: 'wake_required' };
}

function isChainedAutomationPhrase(normalized) {
    const text = String(normalized || '').trim();
    if (!text) return false;
    return /\b(and then|then|and send|and call|and play|and type|and search)\b/.test(text);
}

function isPremiumFirstPhrase(normalized) {
    const text = String(normalized || '').trim();
    if (!text) return false;
    if (/^click(?: on)?\s+/.test(text)) return true;
    if (isChainedAutomationPhrase(text) && isLikelyPremiumAutomationPhrase(text)) return true;
    return false;
}

function isLikelyTruncatedPremiumPhrase(normalized) {
    const text = String(normalized || '').trim();
    if (!text) return false;
    if (!isLikelyPremiumAutomationPhrase(text)) return false;
    if (/\b(send a message to|message to|call|play|click on|navigate to|type)\s*$/.test(text)) return true;
    if (/\b(to|and|then|with|saying|that)\s*$/.test(text)) return true;
    return false;
}

function isLikelyCompoundContinuation(rawText) {
    const normalized = canonicalizeCommandPhrase(normalizeSignPhrase(rawText));
    if (!normalized) return false;
    if (/^(saying|to|that|and|then|him|her|them|dad|mom|message|call|play|type)\b/.test(normalized)) return true;
    const words = normalized.split(/\s+/).filter(Boolean);
    if (words.length <= 4) return true;
    return false;
}

const DEEPGRAM_SUPPRESSED_PREFIXES = [
    'say ',
    'relay',
    'clear voice',
    'voice navigation',
    'available commands',
    'focused ',
    'clicked ',
    'reading captions',
    'listening mode',
    'scrolling ',
    'command ',
    'focus type to speak',
    'text box ready',
    'box ready',
    'control focused',
    'control activated',
    'capturing image',
    'image description',
    'target not found',
    'i can t see',
    'please provide a clearer',
    'please provide clearer'
];

const DEEPGRAM_SUPPRESSED_CONTAINS = [
    ' for commands',
    ' to hear ',
    ' relay blind mode activated',
    ' voice navigation enabled',
    ' help to hear ',
    ' command list',
    'adjust the lighting',
    'clearer view or more light',
    'for better visibility'
];

function shouldIgnoreDeepgramPhrase(normalized) {
    if (!normalized) return true;
    if (isLikelyCommandSafetyBypass(normalized)) return false;
    if (Date.now() < deepgramFeedbackMuteUntil) return true;

    // Prevent blind-mode TTS narration from feeding back into command routing.
    if (appSettings.accessibilityMode === 'blind' && window.speechSynthesis?.speaking) {
        return true;
    }

    if (DEEPGRAM_SUPPRESSED_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
        return true;
    }
    if (DEEPGRAM_SUPPRESSED_CONTAINS.some((snippet) => normalized.includes(snippet))) {
        return true;
    }
    return false;
}

function shouldSkipContextualWakeFallback(normalized) {
    const text = String(normalized || '').trim();
    if (!text) return true;
    return /^(help|read|caption|captions|navigate|click|type|press|stop|listen|repeat|explain|describe|meeting|settings|larger|smaller|open)$/i.test(text);
}

function estimateDataUrlBytes(dataUrl) {
    const source = String(dataUrl || '');
    const commaIndex = source.indexOf(',');
    if (commaIndex < 0) return 0;
    const b64 = source.slice(commaIndex + 1);
    const padding = b64.endsWith('==') ? 2 : (b64.endsWith('=') ? 1 : 0);
    return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
}

function captureFrameFromVideoElement(videoEl) {
    if (!videoEl) return null;
    if (videoEl.readyState < 2) return null;
    const width = Number(videoEl.videoWidth || 0);
    const height = Number(videoEl.videoHeight || 0);
    if (width <= 1 || height <= 1) return null;

    const maxWidth = 1280;
    const scale = width > maxWidth ? (maxWidth / width) : 1;
    const targetWidth = Math.max(2, Math.round(width * scale));
    const targetHeight = Math.max(2, Math.round(height * scale));
    const canvasEl = document.createElement('canvas');
    canvasEl.width = targetWidth;
    canvasEl.height = targetHeight;
    const ctx = canvasEl.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(videoEl, 0, 0, targetWidth, targetHeight);
    let avgLuma = 0;
    try {
        const sampleWidth = Math.max(4, Math.min(80, targetWidth));
        const sampleHeight = Math.max(4, Math.min(80, targetHeight));
        const sample = ctx.getImageData(0, 0, sampleWidth, sampleHeight).data;
        let sum = 0;
        let pixels = 0;
        for (let i = 0; i < sample.length; i += 4) {
            const r = sample[i];
            const g = sample[i + 1];
            const b = sample[i + 2];
            sum += (0.2126 * r) + (0.7152 * g) + (0.0722 * b);
            pixels += 1;
        }
        avgLuma = pixels > 0 ? (sum / pixels) : 0;
    } catch {}

    const dataUrl = canvasEl.toDataURL('image/jpeg', 0.82);
    return {
        dataUrl,
        width: targetWidth,
        height: targetHeight,
        avgLuma,
        bytes: estimateDataUrlBytes(dataUrl)
    };
}

async function captureQuickCameraSnapshotDataUrl() {
    const startedAt = Date.now();
    try {
        const liveGestureVideo = document.getElementById('gesture-input-video');
        const liveFrame = captureFrameFromVideoElement(liveGestureVideo);
        if (liveFrame?.dataUrl) {
            window.electronAPI?.log?.(
                `[ContextAssist] step=2 camera_capture source=gesture_live ` +
                `width=${liveFrame.width} height=${liveFrame.height} bytes=${liveFrame.bytes} ` +
                `avg_luma=${Number(liveFrame.avgLuma || 0).toFixed(1)} latency_ms=${Date.now() - startedAt}`
            );
            return {
                ...liveFrame,
                source: 'gesture_live',
                error: ''
            };
        }
    } catch {}

    let stream = null;
    let tempVideo = null;
    try {
        if (!navigator.mediaDevices?.getUserMedia) {
            return { dataUrl: '', source: 'unavailable', width: 0, height: 0, bytes: 0, avgLuma: 0, error: 'getUserMedia_unavailable' };
        }
        window.electronAPI?.log?.('[ContextAssist] step=2 camera_capture source=temp_stream status=request_start');
        const mediaPromise = navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: 'user',
                width: { ideal: 1280 },
                height: { ideal: 720 }
            },
            audio: false
        });
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('camera_snapshot_timeout')), 2200);
        });
        stream = await Promise.race([mediaPromise, timeoutPromise]);
        tempVideo = document.createElement('video');
        tempVideo.muted = true;
        tempVideo.playsInline = true;
        tempVideo.autoplay = true;
        tempVideo.srcObject = stream;
        await tempVideo.play();
        await new Promise((resolve) => {
            if (tempVideo.readyState >= 2 && tempVideo.videoWidth > 1) {
                resolve();
                return;
            }
            const done = () => resolve();
            tempVideo.addEventListener('loadeddata', done, { once: true });
            setTimeout(done, 450);
        });
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const sampledFrames = [];
        // Give auto-exposure/white-balance a short warmup and sample multiple frames.
        for (let i = 0; i < 5; i += 1) {
            if (i > 0) await wait(180);
            const sample = captureFrameFromVideoElement(tempVideo);
            if (sample?.dataUrl) {
                sampledFrames.push(sample);
            }
        }
        const frame = sampledFrames.sort((a, b) => {
            const lumaDelta = Number(b.avgLuma || 0) - Number(a.avgLuma || 0);
            if (Math.abs(lumaDelta) > 0.6) return lumaDelta;
            return Number(b.bytes || 0) - Number(a.bytes || 0);
        })[0] || null;
        if (frame?.dataUrl) {
            const lumaSamples = sampledFrames
                .map((item) => Number(item.avgLuma || 0).toFixed(1))
                .join(',');
            window.electronAPI?.log?.(
                `[ContextAssist] step=2 camera_capture source=temp_stream ` +
                `width=${frame.width} height=${frame.height} bytes=${frame.bytes} ` +
                `avg_luma=${Number(frame.avgLuma || 0).toFixed(1)} ` +
                `luma_samples=[${lumaSamples}] latency_ms=${Date.now() - startedAt}`
            );
            return {
                ...frame,
                source: 'temp_stream',
                error: ''
            };
        }
        return { dataUrl: '', source: 'temp_stream', width: 0, height: 0, bytes: 0, avgLuma: 0, error: 'empty_frame' };
    } catch (error) {
        const reason = String(error?.message || error || 'camera_capture_failed');
        window.electronAPI?.log?.(`[ContextAssist] step=2 camera_capture source=temp_stream status=failed reason="${reason}"`);
        return { dataUrl: '', source: 'temp_stream_failed', width: 0, height: 0, bytes: 0, avgLuma: 0, error: reason };
    } finally {
        try {
            if (tempVideo) {
                tempVideo.pause();
                tempVideo.srcObject = null;
            }
        } catch {}
        try {
            if (stream) {
                stream.getTracks().forEach((track) => track.stop());
            }
        } catch {}
    }
}

function surfaceContextualAssistantAnswer(answerText, source = 'unknown') {
    const text = String(answerText || '').trim();
    if (!text) return;

    // Always mute command routing briefly after assistant-spoken responses
    // to prevent Deepgram feedback loops in every mode.
    deepgramFeedbackMuteUntil = Date.now() + Math.max(3200, Math.min(text.length * 32, 10000));

    captionRenderer.addFinalSegment({
        transcript: `Relay: ${text}`,
        words: [],
        confidence: 0.98
    });

    if (appSettings.accessibilityMode === 'blind') {
        blindMode.speak(text);
    }

    emitCommandExecution({
        command: 'context_assist',
        source,
        normalized: canonicalizeCommandPhrase(normalizeSignPhrase(text)),
        handled: true,
        reason: 'context_assist',
        routingStage: 'context_assist'
    });
}

async function runContextualWakeFallback(rawPrompt, source = 'unknown', routingMeta = {}) {
    const prompt = String(rawPrompt || '').trim();
    if (!prompt || !window.electronAPI?.contextAssist) return false;

    const normalizedPrompt = canonicalizeCommandPhrase(normalizeSignPhrase(prompt));
    if (!normalizedPrompt || shouldSkipContextualWakeFallback(normalizedPrompt)) {
        return false;
    }

    const now = Date.now();
    if (contextualWakeAssistState.inFlight) return true;
    if (
        contextualWakeAssistState.lastPrompt === normalizedPrompt &&
        (now - contextualWakeAssistState.lastTs) < 2200
    ) {
        return true;
    }

    contextualWakeAssistState.inFlight = true;
    contextualWakeAssistState.lastPrompt = normalizedPrompt;
    contextualWakeAssistState.lastTs = now;
    const startedAt = Date.now();
    window.electronAPI?.log?.(
        `[ContextAssist] step=1 route_start source=${source} prompt="${prompt}" normalized="${normalizedPrompt}"`
    );
    statusTextEl.innerText = 'Analyzing context...';

    try {
        // Only open the camera when the question is about something in front of it.
        const wantsCamera = /(what am i holding|holding|hold|fingers|finger|hand|object|showing you|this item|camera|in front of me)/i.test(prompt);
        const cameraFrame = wantsCamera ? await captureQuickCameraSnapshotDataUrl() : null;
        const cameraBytes = Number(cameraFrame?.bytes || 0);
        window.electronAPI?.log?.(
            `[ContextAssist] step=3 payload_prepare include_screen=true include_camera=${wantsCamera} ` +
            `camera_source=${cameraFrame?.source || 'none'} camera_bytes=${cameraBytes} ` +
            `camera_luma=${Number(cameraFrame?.avgLuma || 0).toFixed(1)}`
        );
        const result = await window.electronAPI.contextAssist({
            prompt,
            includeScreen: true,
            includeCamera: wantsCamera,
            cameraImageDataUrl: String(cameraFrame?.dataUrl || ''),
            cameraMeta: {
                source: cameraFrame?.source || 'none',
                width: Number(cameraFrame?.width || 0),
                height: Number(cameraFrame?.height || 0),
                avgLuma: Number(cameraFrame?.avgLuma || 0),
                bytes: cameraBytes,
                error: cameraFrame?.error || ''
            }
        });
        window.electronAPI?.log?.(
            `[ContextAssist] step=4 main_response success=${result?.success === true} ` +
            `used_screen=${result?.usedScreen === true} used_camera=${result?.usedCamera === true} ` +
            `latency_ms=${Date.now() - startedAt} error="${String(result?.error || '')}"`
        );
        if (result?.debug) {
            window.electronAPI?.log?.(
                `[ContextAssist] step=5 debug screen_bytes=${Number(result.debug.screenBytes || 0)} ` +
                `camera_bytes=${Number(result.debug.cameraBytes || 0)} ` +
                `screen_detail=${String(result.debug.screenDetail || '')} ` +
                `camera_detail=${String(result.debug.cameraDetail || '')} ` +
                `api_latency_ms=${Number(result.debug.latencyMs || 0)}`
            );
            if (result.debug.screenImagePath || result.debug.cameraImagePath || result.debug.metaPath) {
                window.electronAPI?.log?.(
                    `[ContextAssist] step=6 capture_paths ` +
                    `dir="${String(result.debug.captureDir || '')}" ` +
                    `screen="${String(result.debug.screenImagePath || '')}" ` +
                    `camera="${String(result.debug.cameraImagePath || '')}" ` +
                    `meta="${String(result.debug.metaPath || '')}"`
                );
            }
        }

        if (result?.success && result?.answer) {
            surfaceContextualAssistantAnswer(result.answer, source);
            statusTextEl.innerText = 'Listening (Deepgram Nova-3)';
            return true;
        }

        const failureReason = String(result?.error || 'context_assist_failed');
        emitCommandExecution({
            command: 'context_assist',
            source,
            normalized: normalizedPrompt,
            handled: false,
            reason: failureReason,
            wakeMatched: routingMeta?.wakeMatched,
            wakePhrase: routingMeta?.wakePhrase || '',
            routingStage: 'context_assist'
        });
        statusTextEl.innerText = 'Listening (Deepgram Nova-3)';
        return false;
    } catch (error) {
        const failureReason = String(error?.message || 'context_assist_error');
        emitCommandExecution({
            command: 'context_assist',
            source,
            normalized: normalizedPrompt,
            handled: false,
            reason: failureReason,
            wakeMatched: routingMeta?.wakeMatched,
            wakePhrase: routingMeta?.wakePhrase || '',
            routingStage: 'context_assist'
        });
        statusTextEl.innerText = 'Listening (Deepgram Nova-3)';
        return false;
    } finally {
        contextualWakeAssistState.inFlight = false;
    }
}

function splitCommandCandidates(rawText, source = 'unknown') {
    const sourceText = String(rawText || '').trim();
    if (!sourceText) return [];

    // Keep wake-qualified Deepgram utterances intact so downstream routing can
    // strip the wake phrase once and process chained intents reliably.
    if (source === 'deepgram' && wakeCommandState.enabled) {
        const wakeTail = extractWakeQualifiedSegment(sourceText);
        if (wakeTail) {
            return [wakeTail];
        }
    }

    const candidates = [];
    const sentenceChunks = sourceText
        .split(/[\n\r]+/)
        .flatMap((line) => line.split(/[.!?;]+/))
        .map((chunk) => chunk.trim())
        .filter(Boolean);

    sentenceChunks.forEach((chunk) => candidates.push(chunk));
    if (sentenceChunks.length === 0) {
        candidates.push(sourceText);
    }

    // For deepgram input, avoid extracting sub-command candidates from long phrases.
    // This prevents command self-trigger loops from spoken help prompts.
    if (source !== 'deepgram') {
        const normalizedFull = canonicalizeCommandPhrase(normalizeSignPhrase(sourceText));
        const knownCommands = Array.from(
            blindMode.normalizedVoiceCommands?.keys?.() ||
            blindMode.voiceCommands?.keys?.() ||
            []
        )
            .map((command) => canonicalizeCommandPhrase(normalizeSignPhrase(command)))
            .filter(Boolean)
            .sort((a, b) => b.length - a.length);

        if (normalizedFull && knownCommands.length > 0) {
            const padded = ` ${normalizedFull} `;
            for (const command of knownCommands) {
                if (padded.includes(` ${command} `)) {
                    candidates.push(command);
                }
            }
        }
    }

    const seen = new Set();
    return candidates.filter((item) => {
        const key = canonicalizeCommandPhrase(normalizeSignPhrase(item));
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function emitCommandExecution({
    command = null,
    source = 'unknown',
    normalized = '',
    handled = false,
    reason = null,
    wakeMatched = null,
    wakePhrase = '',
    routingStage = '',
    failureReason = null
}) {
    const detail = {
        command,
        source,
        normalized,
        timestamp: Date.now(),
        success: handled,
        reason
    };
    if (typeof wakeMatched === 'boolean') {
        detail.wake_matched = wakeMatched;
    }
    if (wakePhrase) {
        detail.wake_phrase = wakePhrase;
    }
    if (routingStage) {
        detail.routing_stage = routingStage;
    }
    const resolvedFailureReason = failureReason || (!handled ? reason : null);
    if (resolvedFailureReason) {
        detail.failure_reason = resolvedFailureReason;
    }
    window.dispatchEvent(new CustomEvent('command-executed', { detail }));
}

function emitAutomationExecution(detail = {}) {
    window.dispatchEvent(new CustomEvent('automation-executed', {
        detail: {
            intent: detail.intent || 'unknown',
            platform: detail.platform || (navigator.platform || 'unknown'),
            risk: detail.risk || 'medium',
            confirmed: detail.confirmed === true,
            success: detail.success === true,
            duration_ms: Number(detail.duration_ms || 0),
            reason: detail.reason || null,
            source: detail.source || 'unknown',
            normalized: detail.normalized || '',
            timestamp: Date.now()
        }
    }));
}

function getAutomationContextTtlMs() {
    const ttl = Number(appSettings.automationContextTtlMs || 45000);
    return Number.isFinite(ttl) ? Math.max(10000, ttl) : 45000;
}

function normalizeAutomationContext(context = {}) {
    return {
        app: String(context.app || '').trim(),
        target: String(context.target || '').trim(),
        recipient: String(context.recipient || '').trim(),
        intent: String(context.intent || '').trim(),
        timestamp: Number(context.timestamp || Date.now())
    };
}

function refreshAutomationContext() {
    const now = Date.now();
    const ttl = getAutomationContextTtlMs();
    if (!automationState.context.timestamp || now - automationState.context.timestamp > ttl) {
        automationState.context = normalizeAutomationContext({ timestamp: now });
    }
    return automationState.context;
}

function updateAutomationContext(next = {}) {
    automationState.context = normalizeAutomationContext({
        ...automationState.context,
        ...next,
        timestamp: Date.now()
    });
}

let lastRoutedPhraseCommand = { phrase: '', timestamp: 0 };

function isPremiumAutomationEnabled() {
    return false;
}

function isConfirmPhrase(normalized) {
    return /^confirm$/.test(normalized) ||
        /^yes( do it| proceed)?$/.test(normalized) ||
        /^go ahead$/.test(normalized);
}

function isCancelPhrase(normalized) {
    return /^cancel$/.test(normalized) ||
        /^stop$/.test(normalized) ||
        /^no$/.test(normalized);
}

function isLikelyPremiumAutomationPhrase(normalized) {
    const text = String(normalized || '').trim();
    if (!text) return false;

    const primaryPatterns = [
        /^then\b/,
        /^(open|go to|navigate to|click on|click|send|call|play|type|search|focus|press)\b/,
        /\b(youtube|chrome|safari|messages|facetime|phone|discord|slack|mail)\b/,
        /\b(send message|make a call|play this|play that)\b/
    ];
    if (primaryPatterns.some((pattern) => pattern.test(text))) {
        return true;
    }

    const ctx = refreshAutomationContext();
    const withinContext = Date.now() - Number(ctx.timestamp || 0) <= getAutomationContextTtlMs();
    if (withinContext && /\b(him|her|them|that|it)\b/.test(text)) {
        return true;
    }

    return false;
}

function announceAutomationMessage(message) {
    const text = String(message || '').trim();
    if (!text) return;
    statusTextEl.innerText = text;
    if (appSettings.accessibilityMode === 'blind') {
        deepgramFeedbackMuteUntil = Date.now() + 2200;
        blindMode.speak(text);
    }
    setTimeout(() => {
        statusTextEl.innerText = 'Listening (Deepgram Nova-3)';
    }, 1800);
}

function handlePendingAutomationConfirmation(normalized, source) {
    const pending = automationState.pendingConfirmation;
    if (!pending) return false;

    if (isCancelPhrase(normalized)) {
        automationState.pendingConfirmation = null;
        emitAutomationExecution({
            intent: pending.plan?.intent || 'unknown',
            risk: pending.plan?.risk || 'high',
            confirmed: false,
            success: false,
            reason: 'cancelled_by_user',
            source,
            normalized
        });
        announceAutomationMessage('Canceled');
        return true;
    }

    if (!isConfirmPhrase(normalized)) {
        return false;
    }

    automationState.pendingConfirmation = null;
    const startedAt = Date.now();
    window.electronAPI.desktopAutomationExecute({
        ...pending.plan,
        requires_confirmation: false
    })
        .then((execution) => {
            const success = execution?.success === true;
            if (success && execution?.context) {
                updateAutomationContext(execution.context);
            }
            emitAutomationExecution({
                intent: pending.plan?.intent || 'unknown',
                risk: pending.plan?.risk || 'high',
                confirmed: true,
                success,
                reason: success ? null : (execution?.reason || 'execution_failed'),
                duration_ms: Date.now() - startedAt,
                source: pending.source || source,
                normalized: pending.normalized || normalized
            });
            emitCommandExecution({
                command: pending.plan?.intent || 'premium-automation',
                source: pending.source || source,
                normalized: pending.normalized || normalized,
                handled: success,
                reason: success ? null : (execution?.reason || 'execution_failed')
            });
                if (success) {
                    announceAutomationMessage(pending.plan?.summary || 'Done');
                } else {
                    announceAutomationMessage('Could not complete that action');
                }
            })
        .catch((error) => {
            emitAutomationExecution({
                intent: pending.plan?.intent || 'unknown',
                risk: pending.plan?.risk || 'high',
                confirmed: true,
                success: false,
                reason: 'execution_error',
                duration_ms: Date.now() - startedAt,
                source: pending.source || source,
                normalized: pending.normalized || normalized
            });
            window.electronAPI?.log?.(`[Automation] execute error ${error?.message || error}`);
            announceAutomationMessage('Automation failed');
        })
        .finally(() => {
            automationState.inFlight = false;
        });

    return true;
}

function maybeRoutePremiumAutomation(rawText, source, normalizedForLog, routingMeta = {}) {
    if (!isPremiumAutomationEnabled()) return false;
    if (automationState.inFlight) return false;
    if (!['deepgram', 'speech-recognition', 'gesture-input', 'event'].includes(source)) return false;

    const normalized = canonicalizeCommandPhrase(normalizeSignPhrase(rawText));
    if (!normalized) return false;
    if (source === 'deepgram' && shouldIgnoreDeepgramPhrase(normalized)) return false;
    if (!isLikelyPremiumAutomationPhrase(normalized)) return false;

    const wakeMatched = routingMeta.wakeMatched === true;
    const wakePhrase = routingMeta.wakePhrase || '';
    const fallbackRunner = typeof routingMeta.fallback === 'function' ? routingMeta.fallback : null;
    let fallbackUsed = false;
    const runFallback = (reason) => {
        if (!fallbackRunner || fallbackUsed) return;
        fallbackUsed = true;
        window.electronAPI?.log?.(
            `[Automation] stage=fallback source=${source} reason=${reason || 'unknown'} normalized="${normalizedForLog || normalized}"`
        );
        try {
            fallbackRunner(reason || 'unknown');
        } catch (fallbackError) {
            window.electronAPI?.log?.(`[Automation] fallback error ${fallbackError?.message || fallbackError}`);
        }
    };
    const context = refreshAutomationContext();
    automationState.inFlight = true;
    const startedAt = Date.now();
    window.electronAPI?.log?.(
        `[Automation] stage=invoke source=${source} normalized="${normalizedForLog || normalized}" wake_matched=${wakeMatched}`
    );

    window.electronAPI.desktopAutomationPlan({
        utterance: rawText,
        source,
        context
    })
        .then((planned) => {
            if (!planned?.success || !planned?.plan) {
                window.electronAPI?.log?.(
                    `[Automation] stage=blocked source=${source} reason=${planned?.reason || 'planning_failed'}`
                );
                emitAutomationExecution({
                    intent: 'plan',
                    risk: 'medium',
                    confirmed: false,
                    success: false,
                    reason: planned?.reason || 'planning_failed',
                    duration_ms: Date.now() - startedAt,
                    source,
                    normalized: normalizedForLog || normalized
                });
                runFallback(planned?.reason || 'planning_failed');
                automationState.inFlight = false;
                return;
            }

            const plan = planned.plan;
            window.electronAPI?.log?.(
                `[Automation] stage=planned source=${source} intent=${plan?.intent || 'unknown'} risk=${plan?.risk || 'medium'}`
            );
            updateAutomationContext({
                app: plan?.context_refs?.app || context.app,
                target: plan?.context_refs?.target || context.target,
                recipient: plan?.context_refs?.recipient || context.recipient,
                intent: plan?.intent || context.intent
            });

            if (plan.requires_confirmation === true) {
                automationState.pendingConfirmation = {
                    plan,
                    source,
                    normalized: normalizedForLog || normalized,
                    createdAt: Date.now()
                };
                automationState.inFlight = false;
                window.electronAPI?.log?.(
                    `[Automation] stage=blocked source=${source} reason=confirmation_required intent=${plan?.intent || 'unknown'}`
                );
                announceAutomationMessage(`${plan.summary || 'High risk action'}: say confirm to continue or cancel.`);
                return;
            }

            return window.electronAPI.desktopAutomationExecute(plan).then((execution) => {
                const success = execution?.success === true;
                window.electronAPI?.log?.(
                    `[Automation] stage=${success ? 'executed' : 'failed'} source=${source} intent=${plan?.intent || 'unknown'} reason=${execution?.reason || 'none'}`
                );
                if (success && execution?.context) {
                    updateAutomationContext(execution.context);
                }
                emitAutomationExecution({
                    intent: plan.intent || 'premium-automation',
                    risk: plan.risk || 'medium',
                    confirmed: true,
                    success,
                    reason: success ? null : (execution?.reason || 'execution_failed'),
                    duration_ms: Date.now() - startedAt,
                    source,
                    normalized: normalizedForLog || normalized
                });
                emitCommandExecution({
                    command: plan.intent || 'premium-automation',
                    source,
                    normalized: normalizedForLog || normalized,
                    handled: success,
                    reason: success ? null : (execution?.reason || 'execution_failed'),
                    wakeMatched,
                    wakePhrase,
                    routingStage: 'premium_execute'
                });
                if (success) {
                    announceAutomationMessage(plan.summary || 'Done');
                } else {
                    runFallback(execution?.reason || 'execution_failed');
                    announceAutomationMessage('Could not complete that action');
                }
            });
        })
        .catch((error) => {
            window.electronAPI?.log?.(
                `[Automation] stage=failed source=${source} reason=planning_error error="${error?.message || error}"`
            );
            emitAutomationExecution({
                intent: 'premium-automation',
                risk: 'medium',
                confirmed: false,
                success: false,
                reason: 'planning_error',
                duration_ms: Date.now() - startedAt,
                source,
                normalized: normalizedForLog || normalized
            });
            window.electronAPI?.log?.(`[Automation] planning error ${error?.message || error}`);
            runFallback('planning_error');
        })
        .finally(() => {
            if (!automationState.pendingConfirmation) {
                automationState.inFlight = false;
            }
        });

    return true;
}

function maybeHandleDesktopTargetFallback({ normalized, source, rawText = '' }) {
    const supportsDesktopFallback = Boolean(
        window.electronAPI?.desktopNavigateTarget &&
        window.electronAPI?.desktopClickTarget &&
        window.electronAPI?.desktopTypeText
    );
    if (!supportsDesktopFallback) return false;

    const isDesktopSource = source === 'deepgram' || source === 'speech-recognition' || source === 'gesture-input';
    if (!isDesktopSource) return false;
    const targetAppHint = String(automationState?.context?.app || '').trim();

    const isOpenNewTab = /^open\s+(?:a\s+|the\s+)?new\s+tab$/.test(normalized) || normalized === 'new tab';
    if (isOpenNewTab && window.electronAPI?.desktopPressKey) {
        window.electronAPI?.log?.(
            `[CommandRouter] desktop fallback invoke command=press source=${source} phrase="command t" (open_new_tab)`
        );
        Promise.resolve(window.electronAPI.desktopPressKey({ phrase: 'command t', targetApp: targetAppHint }))
            .then((response) => {
                const success = response?.success === true;
                window.electronAPI?.log?.(
                    `[CommandRouter] desktop fallback result command=press source=${source} success=${success} reason=${response?.reason || 'none'}`
                );
                emitCommandExecution({
                    command: 'press',
                    source,
                    normalized,
                    handled: success,
                    reason: success ? null : (response?.reason || 'desktop_press_failed')
                });
            })
            .catch((error) => {
                emitCommandExecution({
                    command: 'press',
                    source,
                    normalized,
                    handled: false,
                    reason: 'desktop_press_error'
                });
                window.electronAPI?.log?.(`[CommandRouter] desktop fallback error command=press error="${error?.message || error}"`);
            });
        return true;
    }

    const pressMatch = normalized.match(/^press(?:\s+on)?\s+(.+)$/);
    if (pressMatch && window.electronAPI?.desktopPressKey) {
        const rawPressMatch = String(rawText || '').match(/^\s*press(?:\s+on)?\s+(.+)\s*$/i);
        let phraseToPress = String((rawPressMatch ? rawPressMatch[1] : pressMatch[1]) || '').trim();
        phraseToPress = phraseToPress.replace(/^(the|a|an)\s+/i, '').replace(/[.!?]+$/g, '').trim();
        if (!phraseToPress) return false;

        window.electronAPI?.log?.(
            `[CommandRouter] desktop fallback invoke command=press source=${source} phrase="${phraseToPress}"`
        );
        Promise.resolve(window.electronAPI.desktopPressKey({ phrase: phraseToPress, targetApp: targetAppHint }))
            .then((response) => {
                const success = response?.success === true;
                window.electronAPI?.log?.(
                    `[CommandRouter] desktop fallback result command=press source=${source} ` +
                    `success=${success} reason=${response?.reason || 'none'}`
                );
                emitCommandExecution({
                    command: 'press',
                    source,
                    normalized,
                    handled: success,
                    reason: success ? null : (response?.reason || 'desktop_press_failed')
                });
                if (success) {
                    statusTextEl.innerText = 'Pressed key';
                    setTimeout(() => {
                        statusTextEl.innerText = 'Listening (Deepgram Nova-3)';
                    }, 1200);
                }
            })
            .catch((error) => {
                emitCommandExecution({
                    command: 'press',
                    source,
                    normalized,
                    handled: false,
                    reason: 'desktop_press_error'
                });
                window.electronAPI?.log?.(`[CommandRouter] desktop fallback error command=press error="${error?.message || error}"`);
            });
        return true;
    }

    const normalizedTypeMatch = normalized.match(/^type(?::|\s+)(.+)$/);
    const normalizedIsTypeToSpeak = normalized === 'type to speak' ||
        normalized.startsWith('focus type to speak') ||
        normalized.startsWith('open text box');
    if (normalizedTypeMatch && !normalizedIsTypeToSpeak) {
        const rawTypeMatch = String(rawText || '').match(/^\s*type(?::|\s+)(.+)\s*$/i);
        let textToType = String((rawTypeMatch ? rawTypeMatch[1] : normalizedTypeMatch[1]) || '').trim();
        if (!textToType) return false;
        const pressEnter = /\s+(and send|enter|submit)\s*$/i.test(textToType);
        if (pressEnter) {
            textToType = textToType.replace(/\s+(and send|enter|submit)\s*$/i, '').trim();
        }
        textToType = textToType.replace(/[.!?]+$/g, '').trim();
        if (/^(high|hai|hii)$/i.test(textToType)) {
            textToType = 'hi';
        }
        if (!textToType) return false;

        window.electronAPI?.log?.(
            `[CommandRouter] desktop fallback invoke command=type source=${source} text="${textToType}" pressEnter=${pressEnter}`
        );
        Promise.resolve(window.electronAPI.desktopTypeText({
            text: textToType,
            pressEnter,
            targetApp: targetAppHint
        }))
            .then((response) => {
                const success = response?.success === true;
                window.electronAPI?.log?.(
                    `[CommandRouter] desktop fallback result command=type source=${source} ` +
                    `success=${success} reason=${response?.reason || 'none'}`
                );
                emitCommandExecution({
                    command: 'type',
                    source,
                    normalized,
                    handled: success,
                    reason: success ? null : (response?.reason || 'desktop_type_failed')
                });
                if (success) {
                    const ts = Date.now();
                    lastRoutedPhraseCommand = { phrase: normalized, timestamp: ts };
                    updateAutomationContext({
                        intent: 'type_text',
                        target: 'focused_input'
                    });
                    statusTextEl.innerText = 'Typed text';
                    setTimeout(() => {
                        statusTextEl.innerText = 'Listening (Deepgram Nova-3)';
                    }, 1200);
                } else if (response?.permissionRequired) {
                    statusTextEl.innerText = 'Desktop typing unavailable';
                    setTimeout(() => {
                        statusTextEl.innerText = 'Listening (Deepgram Nova-3)';
                    }, 1600);
                } else if (response?.reason === 'type_timeout') {
                    blindMode.speak('Typing timed out. I could not control the target app.');
                    statusTextEl.innerText = 'Typing timed out';
                    setTimeout(() => {
                        statusTextEl.innerText = 'Listening (Deepgram Nova-3)';
                    }, 1600);
                } else if (response?.reason === 'no_focused_target') {
                    statusTextEl.innerText = 'Focus a text field, then try again';
                    setTimeout(() => {
                        statusTextEl.innerText = 'Listening (Deepgram Nova-3)';
                    }, 1600);
                }
            })
            .catch((error) => {
                emitCommandExecution({
                    command: 'type',
                    source,
                    normalized,
                    handled: false,
                    reason: 'desktop_type_error'
                });
                window.electronAPI?.log?.(`[CommandRouter] desktop fallback error command=type error="${error?.message || error}"`);
            });
        return true;
    }

    const navigateMatch = normalized.match(/^navigate to\s+(.+)$/);
    const clickMatch = normalized.match(/^click(?: on)?\s+(.+)$/);
    const command = navigateMatch ? 'navigate' : (clickMatch ? 'click' : null);
    if (!command) return false;

    const target = String((navigateMatch ? navigateMatch[1] : clickMatch[1]) || '').trim();
    if (!target) return false;
    if (/\b(then|and then|send|call|play|type|search|youtube)\b/.test(target)) {
        return false;
    }

    window.electronAPI?.log?.(
        `[CommandRouter] desktop fallback invoke command=${command} source=${source} target="${target}" phrase="${normalized}"`
    );

    const invoke = command === 'navigate'
        ? window.electronAPI.desktopNavigateTarget(target)
        : window.electronAPI.desktopClickTarget(target);

    Promise.resolve(invoke)
        .then((response) => {
            const success = response?.success === true;
            window.electronAPI?.log?.(
                `[CommandRouter] desktop fallback result command=${command} source=${source} target="${target}" ` +
                `success=${success} reason=${response?.reason || 'none'} app="${response?.app || ''}" source_tag=${response?.source || 'none'}`
            );
            emitCommandExecution({
                command,
                source,
                normalized,
                handled: success,
                reason: success ? null : (response?.reason || 'desktop_target_not_found')
            });

            if (success) {
                const ts = Date.now();
                lastRoutedPhraseCommand = { phrase: normalized, timestamp: ts };
                const appLabel = String(response?.app || target).trim();
                updateAutomationContext({
                    app: appLabel,
                    target,
                    intent: command
                });
                statusTextEl.innerText = `Focused ${appLabel}`;
                setTimeout(() => {
                    statusTextEl.innerText = 'Listening (Deepgram Nova-3)';
                }, 1400);
            } else if (response?.permissionRequired) {
                statusTextEl.innerText = 'Desktop control unavailable';
                setTimeout(() => {
                    statusTextEl.innerText = 'Listening (Deepgram Nova-3)';
                }, 1600);
            }
        })
        .catch((error) => {
            emitCommandExecution({
                command,
                source,
                normalized,
                handled: false,
                reason: 'desktop_error'
            });
            window.electronAPI?.log?.(`[CommandRouter] desktop fallback error command=${command} target="${target}" error="${error?.message || error}"`);
        });

    return true;
}

function handleCommandPhrase(rawText, {
    source = 'event',
    preNormalized = '',
    wakeMatched = null,
    wakePhrase = ''
} = {}) {
    if (!shouldRouteVoiceCommands()) return false;

    const normalized = preNormalized || canonicalizeCommandPhrase(normalizeSignPhrase(rawText));
    if (!normalized) return false;

    if (source === 'deepgram' && shouldIgnoreDeepgramPhrase(normalized)) {
        window.electronAPI?.log?.(`[CommandRouter] ignore deepgram phrase="${normalized}"`);
        return false;
    }

    if (/^type\s+/.test(normalized) && normalized !== 'type to speak') {
        const delegatedType = maybeHandleDesktopTargetFallback({ normalized, source, rawText });
        if (delegatedType) {
            return true;
        }
    }
    if (
        /^press(?:\s+on)?\s+/.test(normalized) ||
        /^open\s+(?:a\s+|the\s+)?new\s+tab$/.test(normalized) ||
        normalized === 'new tab'
    ) {
        const delegatedPress = maybeHandleDesktopTargetFallback({ normalized, source, rawText });
        if (delegatedPress) {
            return true;
        }
    }

    if (handlePendingAutomationConfirmation(normalized, source)) {
        return true;
    }

    if (
        (normalized === 'navigate' || normalized === 'click' || normalized === 'type' || normalized === 'press') &&
        source !== 'gesture-input'
    ) {
        emitCommandExecution({
            command: normalized,
            source,
            normalized,
            handled: false,
            reason: 'target_required',
            wakeMatched,
            wakePhrase,
            routingStage: 'command_validate'
        });
        if (source === 'deepgram' || source === 'speech-recognition') {
            statusTextEl.innerText = 'Say "navigate to", "click on", "press ...", or "type ..."';
            setTimeout(() => {
                statusTextEl.innerText = 'Listening (Deepgram Nova-3)';
            }, 1600);
        }
        return false;
    }

    const now = Date.now();
    if (normalized === lastRoutedPhraseCommand.phrase && (now - lastRoutedPhraseCommand.timestamp) < commandRouterState.cooldownMs) {
        return false;
    }

    const words = normalized.split(' ').filter(Boolean);
    if (source === 'deepgram' && words.length > commandRouterState.maxWords) {
        emitCommandExecution({
            source,
            normalized,
            handled: false,
            reason: 'too_many_words',
            wakeMatched,
            wakePhrase,
            routingStage: 'command_validate'
        });
        return false;
    }

    // Delegate command parsing to BlindMode's canonical voice-command library.
    const disabledCommands = appSettings.accessibilityMode === 'blind'
        ? ['transcript', 'transcripts']
        : [];
    const result = blindMode.processVoiceCommand?.(normalized, {
        source,
        emitEvent: false,
        disabledCommands,
        autocorrect: source === 'deepgram' ? false : undefined
    }) || { handled: false };
    window.electronAPI?.log?.(
        `[CommandRouter] candidate source=${source} phrase="${normalized}" ` +
        `handled=${result === true || result?.handled === true} command=${typeof result === 'object' ? (result.command || 'unknown') : 'unknown'} ` +
        `reason=${typeof result === 'object' ? (result.reason || 'none') : 'none'}`
    );
    const handled = result === true || result?.handled === true;
    const command = typeof result === 'object' ? (result.command || null) : null;

    if (!handled) {
        const shouldDelegateDesktop = (
            result?.reason === 'target_not_found' ||
            /^(navigate to\s+|click(?: on)?\s+|type(?::|\s+).+|press(?: on)?\s+.+)/.test(normalized) ||
            /^open\s+(?:a\s+|the\s+)?new\s+tab$/.test(normalized) ||
            normalized === 'new tab'
        );
        if (shouldDelegateDesktop) {
            const delegated = maybeHandleDesktopTargetFallback({ normalized, source, rawText });
            if (delegated) {
                return true;
            }
        }
    }

    emitCommandExecution({
        command,
        source,
        normalized,
        handled,
        reason: handled ? null : 'no_match',
        wakeMatched,
        wakePhrase,
        routingStage: 'deterministic'
    });
    if (handled) {
        lastRoutedPhraseCommand = { phrase: normalized, timestamp: now };
        const navigateMatch = normalized.match(/^navigate to\s+(.+)$/);
        const clickMatch = normalized.match(/^click(?: on)?\s+(.+)$/);
        updateAutomationContext({
            intent: command || '',
            target: navigateMatch ? navigateMatch[1] : (clickMatch ? clickMatch[1] : automationState.context.target)
        });
        console.log('[CommandRouter] Handled', { command, source, normalized });
    }
    return handled;
}

function isImmediateStopCandidate(rawPhrase) {
    const raw = String(rawPhrase || '').trim();
    if (!raw) return false;
    const normalized = canonicalizeCommandPhrase(normalizeSignPhrase(raw));
    if (normalized === 'stop') return true;
    const stripped = stripWakePrefixFromText(raw);
    if (!stripped.matched) return false;
    return canonicalizeCommandPhrase(normalizeSignPhrase(stripped.text)) === 'stop';
}

function shouldTriggerImmediateStop(rawText, source) {
    if (!WAKE_REQUIRED_SOURCES.has(source)) return false;
    const chunks = String(rawText || '')
        .split(/[\n\r.!?;]+/)
        .map((part) => part.trim())
        .filter(Boolean);
    if (chunks.length === 0) return false;
    return chunks.some((chunk) => isImmediateStopCandidate(chunk));
}

function triggerImmediateStop(source) {
    const now = Date.now();
    if ((now - immediateStopState.lastTs) < 450) {
        return true;
    }
    immediateStopState.lastTs = now;
    clearPendingPartialVoiceCommand();
    clearCompoundCapture();
    clearWakeContinuation();
    if (typeof blindMode?.stopCurrentAction === 'function') {
        blindMode.stopCurrentAction();
    } else {
        handleAction('stop-all', { source: `${source}:immediate_stop` });
    }
    emitCommandExecution({
        command: 'stop',
        source,
        normalized: 'stop',
        handled: true,
        reason: 'immediate_stop',
        wakeMatched: false,
        wakePhrase: '',
        routingStage: 'immediate_stop'
    });
    window.electronAPI?.log?.(`[CommandRouter] immediate-stop source=${source}`);
    return true;
}

function routeCommandInput(rawText, source = 'unknown', options = {}) {
    const skipCompoundJoin = options?.skipCompoundJoin === true;
    const trimmedRaw = String(rawText || '').trim();
    if (shouldTriggerImmediateStop(trimmedRaw, source)) {
        return triggerImmediateStop(source);
    }
    if (
        source === 'deepgram' &&
        !skipCompoundJoin &&
        partialVoiceCommandState.command &&
        partialVoiceCommandState.source === source &&
        Date.now() <= partialVoiceCommandState.expiresAt &&
        !extractWakeQualifiedSegment(trimmedRaw)
    ) {
        const continuationNormalized = canonicalizeCommandPhrase(normalizeSignPhrase(trimmedRaw));
        if (continuationNormalized) {
            const merged = `${partialVoiceCommandState.command} ${continuationNormalized}`.trim();
            window.electronAPI?.log?.(
                `[CommandRouter] partial-join source=${source} merged="${merged}"`
            );
            clearPendingPartialVoiceCommand();
            return routeCommandInput(merged, source, { skipCompoundJoin: true });
        }
    }

    if (
        source === 'deepgram' &&
        !skipCompoundJoin &&
        compoundCaptureState.pendingRaw &&
        Date.now() <= compoundCaptureState.expiresAt &&
        !extractWakeQualifiedSegment(rawText) &&
        isLikelyCompoundContinuation(rawText)
    ) {
        const merged = `${compoundCaptureState.pendingRaw} ${String(rawText || '').trim()}`.trim();
        window.electronAPI?.log?.(
            `[CommandRouter] compound-join source=${source} merged="${merged}"`
        );
        clearCompoundCapture();
        return routeCommandInput(merged, source, { skipCompoundJoin: true });
    }

    const candidates = splitCommandCandidates(rawText, source);
    window.electronAPI?.log?.(
        `[CommandRouter] route source=${source} raw="${String(rawText || '').trim()}" candidates=${JSON.stringify(candidates)}`
    );
    const queue = candidates.length > 0 ? candidates : [String(rawText || '').trim()];

    let handledAny = false;
    let unmatchedWakePrompt = '';
    let unmatchedWakeMeta = null;
    let wakeContinuationUnlocked = (
        WAKE_REQUIRED_SOURCES.has(source) &&
        wakeContinuationState.source === source &&
        Date.now() <= wakeContinuationState.expiresAt
    );
    queue.forEach((candidate) => {
        let candidateHandled = false;
        let gate = gateCandidateForWakePhrase(candidate, source);
        if (
            !gate.allowed &&
            gate.reason === 'wake_required' &&
            wakeContinuationUnlocked &&
            WAKE_REQUIRED_SOURCES.has(source)
        ) {
            const continuationRaw = String(candidate || '').trim();
            const continuationNormalized = canonicalizeCommandPhrase(normalizeSignPhrase(continuationRaw));
            gate = {
                allowed: Boolean(continuationRaw && continuationNormalized),
                raw: continuationRaw,
                normalized: continuationNormalized,
                wakeMatched: true,
                wakePhrase: wakeContinuationState.phrase || 'continuation',
                reason: continuationRaw && continuationNormalized ? null : 'empty_phrase'
            };
        }
        if (!gate.allowed) {
            if (gate.wakeMatched && gate.reason === 'wake_only' && WAKE_REQUIRED_SOURCES.has(source)) {
                wakeContinuationUnlocked = true;
                wakeContinuationState.source = source;
                wakeContinuationState.phrase = gate.wakePhrase || 'continuation';
                wakeContinuationState.expiresAt = Date.now() + 2600;
                return;
            }
            if (gate.reason !== 'empty_phrase' && gate.reason !== 'not_command_phrase') {
                window.electronAPI?.log?.(
                    `[CommandRouter] gate source=${source} phrase="${gate.normalized}" reason=${gate.reason}`
                );
                emitCommandExecution({
                    source,
                    normalized: gate.normalized,
                    handled: false,
                    reason: gate.reason,
                    wakeMatched: gate.wakeMatched,
                    wakePhrase: gate.wakePhrase,
                    routingStage: 'wake_gate'
                });
            }
            return;
        }
        if (gate.wakeMatched) {
            clearCompoundCapture();
            clearWakeContinuation();
            window.electronAPI?.log?.(
                `[CommandRouter] wake source=${source} phrase="${gate.wakePhrase || 'matched'}" normalized="${gate.normalized}"`
            );
            wakeContinuationUnlocked = true;
        }

        if (source === 'deepgram' && shouldIgnoreDeepgramPhrase(gate.normalized)) {
            window.electronAPI?.log?.(`[CommandRouter] ignore deepgram phrase="${gate.normalized}"`);
            return;
        }

        if (shouldDeduplicateRoutedPhrase(gate.normalized, source)) {
            window.electronAPI?.log?.(
                `[CommandRouter] dedupe source=${source} phrase="${gate.normalized}" reason=duplicate_phrase`
            );
            emitCommandExecution({
                source,
                normalized: gate.normalized,
                handled: false,
                reason: 'duplicate_phrase',
                wakeMatched: gate.wakeMatched,
                wakePhrase: gate.wakePhrase,
                routingStage: 'dedupe'
            });
            return;
        }

        const prioritizePremium = isPremiumFirstPhrase(gate.normalized);
        if (prioritizePremium) {
            if (
                source === 'deepgram' &&
                gate.wakeMatched &&
                isLikelyTruncatedPremiumPhrase(gate.normalized)
            ) {
                clearCompoundCapture();
                compoundCaptureState.pendingRaw = String(candidate || '').trim();
                compoundCaptureState.pendingSource = source;
                compoundCaptureState.expiresAt = Date.now() + 2200;
                compoundCaptureState.timerId = setTimeout(() => {
                    if (!compoundCaptureState.pendingRaw) return;
                    const fallbackRaw = compoundCaptureState.pendingRaw;
                    clearCompoundCapture();
                    window.electronAPI?.log?.(
                        `[CommandRouter] compound-timeout source=${source} raw="${fallbackRaw}"`
                    );
                    routeCommandInput(fallbackRaw, source, { skipCompoundJoin: true });
                }, 900);
                window.electronAPI?.log?.(
                    `[CommandRouter] compound-buffer source=${source} normalized="${gate.normalized}"`
                );
                handledAny = true;
                candidateHandled = true;
                return;
            }
            const routedPremium = maybeRoutePremiumAutomation(gate.raw, source, gate.normalized, {
                wakeMatched: gate.wakeMatched,
                wakePhrase: gate.wakePhrase,
                fallback: /^click(?: on)?\s+/.test(gate.normalized)
                    ? () => {
                        handleCommandPhrase(gate.raw, {
                            source,
                            preNormalized: gate.normalized,
                            wakeMatched: gate.wakeMatched,
                            wakePhrase: gate.wakePhrase
                        });
                    }
                    : null
            });
            handledAny = handledAny || routedPremium;
            candidateHandled = candidateHandled || routedPremium;
            if (routedPremium) {
                clearPendingPartialVoiceCommand();
                clearWakeContinuation();
                return;
            }
        }

        if (source === 'deepgram' && /^(click|type|press)$/.test(gate.normalized)) {
            setPendingPartialVoiceCommand(gate.normalized, source);
            window.electronAPI?.log?.(
                `[CommandRouter] partial-buffer source=${source} command="${gate.normalized}"`
            );
            handledAny = true;
            candidateHandled = true;
            return;
        }

        const handled = handleCommandPhrase(gate.raw, {
            source,
            preNormalized: gate.normalized,
            wakeMatched: gate.wakeMatched,
            wakePhrase: gate.wakePhrase
        });
        handledAny = handledAny || handled;
        candidateHandled = candidateHandled || handled;
        if (!handled) {
            const routedPremium = maybeRoutePremiumAutomation(gate.raw, source, gate.normalized, {
                wakeMatched: gate.wakeMatched,
                wakePhrase: gate.wakePhrase
            });
            handledAny = handledAny || routedPremium;
            candidateHandled = candidateHandled || routedPremium;
            if (routedPremium) {
                clearPendingPartialVoiceCommand();
                clearWakeContinuation();
            }
        } else {
            clearPendingPartialVoiceCommand();
            clearWakeContinuation();
        }

        if (
            !candidateHandled &&
            gate.wakeMatched &&
            WAKE_REQUIRED_SOURCES.has(source) &&
            !shouldSkipContextualWakeFallback(gate.normalized)
        ) {
            const fallbackPrompt = String(gate.raw || candidate || '').trim();
            if (fallbackPrompt && fallbackPrompt.length >= 8) {
                if (!unmatchedWakePrompt || fallbackPrompt.length > unmatchedWakePrompt.length) {
                    unmatchedWakePrompt = fallbackPrompt;
                    unmatchedWakeMeta = {
                        wakeMatched: gate.wakeMatched,
                        wakePhrase: gate.wakePhrase
                    };
                }
            }
        }
    });

    if (!handledAny) {
        const gatedRaw = gateCandidateForWakePhrase(rawText, source);
        if (gatedRaw.allowed) {
            const routedPremium = maybeRoutePremiumAutomation(gatedRaw.raw, source, gatedRaw.normalized, {
                wakeMatched: gatedRaw.wakeMatched,
                wakePhrase: gatedRaw.wakePhrase
            });
            handledAny = handledAny || routedPremium;
        }
        if (
            !handledAny &&
            unmatchedWakePrompt &&
            WAKE_REQUIRED_SOURCES.has(source)
        ) {
            void runContextualWakeFallback(unmatchedWakePrompt, source, unmatchedWakeMeta || {
                wakeMatched: true,
                wakePhrase: ''
            });
            handledAny = true;
        }
    }
    return handledAny;
}

window.__relayRouteCommandInput = routeCommandInput;
window.__relayCommandRouterReady = true;

// ============================================
// INITIALIZATION
// ============================================
(async function init() {
    await loadSettings();

    // Accessibility command-router defaults.
    try {
        if (appSettings.voiceCommandsMode !== 'global') {
            appSettings.voiceCommandsMode = 'global';
            window.electronAPI?.setSettings?.('voiceCommandsMode', 'global');
        }
        if (!Number.isFinite(appSettings.voiceCommandCooldownMs) || appSettings.voiceCommandCooldownMs < 500) {
            appSettings.voiceCommandCooldownMs = 1800;
            window.electronAPI?.setSettings?.('voiceCommandCooldownMs', 1800);
        }
        if (!Number.isFinite(appSettings.voiceCommandMaxWords) || appSettings.voiceCommandMaxWords < 2) {
            appSettings.voiceCommandMaxWords = 8;
            window.electronAPI?.setSettings?.('voiceCommandMaxWords', 8);
        }
        if (appSettings.wakePhraseEnabled !== true) {
            appSettings.wakePhraseEnabled = true;
            window.electronAPI?.setSettings?.('wakePhraseEnabled', true);
        }
        const normalizedWakePhrase = canonicalizeCommandPhrase(
            normalizeSignPhrase(appSettings.wakePhrase || 'hey relay')
        ) || 'hey relay';
        if (normalizedWakePhrase !== canonicalizeCommandPhrase(normalizeSignPhrase(appSettings.wakePhrase || ''))) {
            appSettings.wakePhrase = normalizedWakePhrase;
            window.electronAPI?.setSettings?.('wakePhrase', normalizedWakePhrase);
        }
        const configuredWakeAliases = Array.isArray(appSettings.wakePhraseAliases)
            ? appSettings.wakePhraseAliases
            : [];
        const normalizedWakeAliases = [...new Set(
            configuredWakeAliases
                .map((item) => canonicalizeCommandPhrase(normalizeSignPhrase(item)))
                .filter(Boolean)
                .concat([normalizedWakePhrase])
        )];
        if (
            !Array.isArray(appSettings.wakePhraseAliases) ||
            normalizedWakeAliases.length !== configuredWakeAliases.length ||
            normalizedWakeAliases.some((value, index) => value !== configuredWakeAliases[index])
        ) {
            appSettings.wakePhraseAliases = normalizedWakeAliases;
            window.electronAPI?.setSettings?.('wakePhraseAliases', normalizedWakeAliases);
        }
        if (appSettings.wakePhraseStrict !== true) {
            appSettings.wakePhraseStrict = true;
            window.electronAPI?.setSettings?.('wakePhraseStrict', true);
        }
        if (appSettings.wakePhraseAllowStopWithoutWake !== true) {
            appSettings.wakePhraseAllowStopWithoutWake = true;
            window.electronAPI?.setSettings?.('wakePhraseAllowStopWithoutWake', true);
        }
        if (appSettings.premiumAutomationEnabled !== false) {
            appSettings.premiumAutomationEnabled = false;
            window.electronAPI?.setSettings?.('premiumAutomationEnabled', false);
        }
        if (!Number.isFinite(appSettings.automationContextTtlMs) || appSettings.automationContextTtlMs < 10000) {
            appSettings.automationContextTtlMs = 45000;
            window.electronAPI?.setSettings?.('automationContextTtlMs', 45000);
        }
        if (appSettings.automationRequireHighRiskConfirmation !== true) {
            appSettings.automationRequireHighRiskConfirmation = true;
            window.electronAPI?.setSettings?.('automationRequireHighRiskConfirmation', true);
        }
        if (appSettings.automationVisionFallback !== true) {
            appSettings.automationVisionFallback = true;
            window.electronAPI?.setSettings?.('automationVisionFallback', true);
        }
        const normalizedAutomationModel = String(appSettings.automationModel || '').trim().toLowerCase();
        // gpt-4.1-nano was retired on 2026-10-23; GPT-6 Luna replaces the older small models.
        if (!normalizedAutomationModel || ['gpt-4o-mini', 'gpt-4.1-nano', 'gpt-5.6-luna'].includes(normalizedAutomationModel)) {
            appSettings.automationModel = 'gpt-6-luna';
            window.electronAPI?.setSettings?.('automationModel', 'gpt-6-luna');
        }
        if (appSettings.accessibilityMode === 'combined') {
            appSettings.accessibilityMode = 'deaf';
            window.electronAPI?.setSettings?.('accessibilityMode', 'deaf');
        } else if (!['deaf', 'blind'].includes(appSettings.accessibilityMode)) {
            appSettings.accessibilityMode = 'deaf';
            window.electronAPI?.setSettings?.('accessibilityMode', 'deaf');
        }

        refreshAutomationContext();
    } catch (error) {
        console.warn('Unable to apply startup defaults:', error?.message || error);
    }
    syncCommandRouterSettings();

    // Apply settings to modules
    captionRenderer.updateSettings(appSettings);
    if (appSettings.userNames) {
        captionRenderer.setNameWords(appSettings.userNames);
        confusionDetector.setUserNames(appSettings.userNames);
    }
    if (appSettings.alertCategories) {
        alertSystem.setEnabledCategories(appSettings.alertCategories);
    }
    confusionDetector.setMeetingActive(false);

    // Clean up old transcripts per retention policy
    if (appSettings.storeTranscripts && appSettings.transcriptRetentionHours) {
        transcriptStore.clearOlderThan(appSettings.transcriptRetentionHours);
    }

    // Setup listeners
    setupDeepgramListeners();

    if (appSettings.premiumAutomationEnabled === true && window.electronAPI?.desktopAutomationStatus) {
        window.electronAPI.desktopAutomationStatus()
            .then((status) => {
                if (!status?.success) return;
                if (status?.context) {
                    automationState.context = normalizeAutomationContext(status.context);
                }
                if (status?.degraded && Array.isArray(status?.missing) && status.missing.length > 0) {
                    window.electronAPI?.log?.(
                        `[Automation] status degraded missing=${status.missing.join(',')}`
                    );
                }
            })
            .catch((error) => {
                window.electronAPI?.log?.(`[Automation] status check failed ${error?.message || error}`);
            });
    }
    if (appSettings.premiumAutomationEnabled === true && window.electronAPI?.onAutomationPreflight) {
        window.electronAPI.onAutomationPreflight((status) => {
            if (status?.degraded) {
                window.electronAPI?.log?.(
                    `[Automation] preflight degraded missing=${Array.isArray(status?.missing) ? status.missing.join(',') : 'unknown'}`
                );
            }
        });
    }

    // Initialize new accessibility modules
    // Sound feedback for all interactions
    soundFeedback.resume();

    // Setup gesture-input callback (MediaPipe on-device recognizer).
    window.addEventListener('gesture-input', (event) => {
        const detail = event?.detail || {};
        const candidate = detail.selectedCommandCandidate || null;
        const spokenCommand = resolveSpokenGestureCommand(detail, candidate);
        if (spokenCommand) {
            speakRoutedGestureCommand(spokenCommand);
        }
        if (!candidate?.command) return;

        const normalizedCommand = canonicalizeCommandPhrase(normalizeSignPhrase(candidate.command));
        if (!normalizedCommand) return;
        if (!ROUTABLE_GESTURE_COMMANDS.has(normalizedCommand)) {
            return;
        }

        const now = Date.now();
        if (
            gestureCommandRoutingState.lastCommand === normalizedCommand &&
            (now - gestureCommandRoutingState.lastTs) < 1400
        ) {
            return;
        }

        gestureCommandRoutingState.lastCommand = normalizedCommand;
        gestureCommandRoutingState.lastTs = now;

        window.electronAPI?.log?.(
            `[GestureInput] route command=${normalizedCommand} ` +
            `gesture=${candidate.gesture || 'unknown'} confidence=${Number(candidate.confidence || 0).toFixed(3)}`
        );
        routeCommandInput(normalizedCommand, 'gesture-input', { skipCompoundJoin: true });
    });

    window.addEventListener('voice-command-input', (event) => {
        const phraseText = event?.detail?.text;
        const source = event?.detail?.source || 'event';
        routeCommandInput(phraseText, source);
    });

    // Setup mode indicator click handler - DIRECT like other buttons
    const modeIndicator = document.getElementById('mode-indicator');
    if (modeIndicator) {
        modeIndicator.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            modeSwitcher.showDropdown();
        });
        modeIndicator.style.display = 'flex';
    }


    // Initialize mode from settings and sync the mode switcher state.
    const savedMode = ['deaf', 'blind'].includes(appSettings.accessibilityMode)
        ? appSettings.accessibilityMode
        : 'deaf';
    const modeToUse = savedMode;
    modeSwitcher.currentMode = modeToUse;
    modeSwitcher.saveMode(modeToUse);
    modeSwitcher.updateIndicator();
    syncGestureWidgetControls();

    // Dispatch initial mode
    window.dispatchEvent(new CustomEvent('mode-changed', {
        detail: { mode: modeToUse, previousMode: null }
    }));

    // Auto-start
    window.electronAPI.log("Starting Relay with Deepgram Nova-3 streaming...");
    startRecording('mic');
    refreshSources();
})();
