const { app, BrowserWindow, screen, ipcMain, Tray, Menu, session, desktopCapturer, shell, dialog, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

// Local development may use provider keys from ../.env. Packaged builds ship
// without secrets and reach AI services through the Relay API proxy.
if (!app.isPackaged) {
    try {
        require('dotenv').config({ path: path.join(__dirname, '../.env') });
    } catch {
        // dotenv is a dev dependency; ignore when unavailable.
    }
}

// Import new modules
const { MobileBridge } = require('./mobile-bridge');
const settings = require('./settings-manager');

const { registerShortcuts, unregisterAll } = require('./shortcut-manager');
const haptics = require('./haptic-manager');
const { SoundClassifier } = require('./sound-classifier');
const {
    AUTOMATION_PLAN_V1_SCHEMA,
    normalizeAutomationPlan,
    validateAutomationPlanV1
} = require('./automation-plan-schema');

// ML sound classifier – loads model in background on startup
let soundClassifier = null;
const FAST_TEXT_MODEL = String(process.env.RELAY_FAST_TEXT_MODEL || 'gpt-6-luna').trim() || 'gpt-6-luna';
const FAST_VISION_MODEL = String(process.env.RELAY_FAST_VISION_MODEL || 'gpt-6-luna').trim() || 'gpt-6-luna';
const CONTEXT_CAPTURE_DIR_NAME = 'Relay Context Captures';
const recentRecipients = [];
let lastAutomationContext = {
    app: '',
    target: '',
    recipient: '',
    intent: '',
    timestamp: 0
};
let lastDesktopTarget = {
    app: '',
    target: '',
    source: '',
    timestamp: 0
};

const DESTRUCTIVE_INTENTS = new Set([
    'delete',
    'remove',
    'purchase',
    'payment',
    'terminal_exec',
    'file_delete',
    'system_settings_write',
    'factory_reset',
    'sign_out_all'
]);

const ASSISTIVE_INTENTS = new Set([
    'navigate',
    'click',
    'open_app',
    'open_url',
    'send_message',
    'call_contact',
    'play_media',
    'type_text',
    'search',
    'scroll',
    'focus',
    'press_keys',
    'describe_image',
    'read'
]);

const IMAGE_ANALYSIS_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['description', 'objects', 'text', 'confidence'],
    properties: {
        description: { type: 'string', minLength: 1, maxLength: 4000 },
        objects: {
            type: 'array',
            maxItems: 12,
            items: { type: 'string', minLength: 1, maxLength: 80 }
        },
        text: { type: 'string', maxLength: 2000 },
        confidence: { type: 'number', minimum: 0, maximum: 1 }
    }
};

// Setup completion flag
const setupFlagPath = path.join(app.getPath('userData'), 'setup_complete.flag');

function isSetupComplete() {
    return fs.existsSync(setupFlagPath);
}

function markSetupComplete() {
    fs.writeFileSync(setupFlagPath, 'true');
}

const activeWindow = require('active-win');
const { LiveTranscriptionEvents } = require('@deepgram/sdk');
const { getOpenAIClient, getDeepgramClient, getAIMode, toUploadFile, resolveModel, CHAT_TEXT_MODEL, SPEECH_MODEL, TRANSCRIBE_MODEL } = require('./ai-clients');

// Initialize settings
settings.init();

// Polling interval for active window
let contextInterval;
let lastContextApp = "";

function extractMessageJson(message) {
    if (!message) return null;
    if (message.parsed && typeof message.parsed === 'object') return message.parsed;

    let content = message.content;
    if (Array.isArray(content)) {
        content = content
            .map((part) => {
                if (typeof part === 'string') return part;
                if (part && typeof part.text === 'string') return part.text;
                return '';
            })
            .join('\n');
    }

    if (typeof content !== 'string') return null;

    const cleaned = content
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/\s*```$/, '')
        .trim();

    if (!cleaned) return null;
    return JSON.parse(cleaned);
}

function clampConfidence(value, fallback = 0.5) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(1, n));
}

function estimateDataUrlBytes(dataUrl) {
    const source = String(dataUrl || '');
    const commaIndex = source.indexOf(',');
    if (commaIndex < 0) return 0;
    const b64 = source.slice(commaIndex + 1);
    const padding = b64.endsWith('==') ? 2 : (b64.endsWith('=') ? 1 : 0);
    return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
}

// Vision models downscale to 2048px anyway, and the Relay API proxy rejects
// request bodies over 4.5 MB, so large images are re-encoded as JPEG first.
const MAX_UPLOAD_IMAGE_WIDTH = 2048;
const MAX_UPLOAD_IMAGE_BYTES = 2.5 * 1024 * 1024;

function encodeImageForUpload(image) {
    const { width } = image.getSize();
    const resized = width > MAX_UPLOAD_IMAGE_WIDTH ? image.resize({ width: MAX_UPLOAD_IMAGE_WIDTH, quality: 'good' }) : image;
    return `data:image/jpeg;base64,${resized.toJPEG(80).toString('base64')}`;
}

function normalizeImageForUpload(dataUrl) {
    const source = String(dataUrl || '');
    if (!source.startsWith('data:image/') || estimateDataUrlBytes(source) <= MAX_UPLOAD_IMAGE_BYTES) {
        return source;
    }
    const image = nativeImage.createFromDataURL(source);
    return image.isEmpty() ? source : encodeImageForUpload(image);
}

function decodeImageDataUrl(dataUrl) {
    const source = String(dataUrl || '').trim();
    const match = /^data:image\/([a-zA-Z0-9.+-]+);base64,([\s\S]+)$/i.exec(source);
    if (!match) return null;
    const subtype = String(match[1] || '').toLowerCase();
    const base64Payload = String(match[2] || '');
    if (!base64Payload) return null;
    const buffer = Buffer.from(base64Payload, 'base64');
    if (!buffer || buffer.length === 0) return null;
    const extMap = {
        'jpeg': 'jpg',
        'jpg': 'jpg',
        'png': 'png',
        'webp': 'webp',
        'gif': 'gif',
        'bmp': 'bmp'
    };
    const ext = extMap[subtype] || 'img';
    return { buffer, ext, subtype };
}

function sanitizeFileToken(value, maxLength = 48) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, maxLength) || 'capture';
}

function writeContextAssistCaptures({
    prompt = '',
    appName = '',
    screenshotDataUrl = '',
    cameraDataUrl = '',
    cameraMeta = {}
} = {}) {
    const desktopDir = app.getPath('desktop');
    const captureDir = path.join(desktopDir, CONTEXT_CAPTURE_DIR_NAME);
    fs.mkdirSync(captureDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const promptToken = sanitizeFileToken(prompt, 40);
    const captureId = `${timestamp}_${promptToken}`;
    const saved = {
        directory: captureDir,
        captureId,
        screenImagePath: '',
        cameraImagePath: '',
        metaPath: ''
    };

    const screenshotDecoded = decodeImageDataUrl(screenshotDataUrl);
    if (screenshotDecoded) {
        const filePath = path.join(captureDir, `${captureId}_screen.${screenshotDecoded.ext}`);
        fs.writeFileSync(filePath, screenshotDecoded.buffer);
        saved.screenImagePath = filePath;
    }

    const cameraDecoded = decodeImageDataUrl(cameraDataUrl);
    if (cameraDecoded) {
        const filePath = path.join(captureDir, `${captureId}_camera.${cameraDecoded.ext}`);
        fs.writeFileSync(filePath, cameraDecoded.buffer);
        saved.cameraImagePath = filePath;
    }

    const metaPath = path.join(captureDir, `${captureId}_meta.json`);
    fs.writeFileSync(metaPath, JSON.stringify({
        createdAt: new Date().toISOString(),
        appName: String(appName || ''),
        prompt: String(prompt || ''),
        screenBytes: estimateDataUrlBytes(screenshotDataUrl),
        cameraBytes: estimateDataUrlBytes(cameraDataUrl),
        cameraMeta: {
            source: String(cameraMeta?.source || ''),
            width: Number(cameraMeta?.width || 0),
            height: Number(cameraMeta?.height || 0),
            avgLuma: Number(cameraMeta?.avgLuma || 0),
            bytes: Number(cameraMeta?.bytes || 0),
            error: String(cameraMeta?.error || '')
        },
        screenImagePath: saved.screenImagePath,
        cameraImagePath: saved.cameraImagePath
    }, null, 2));
    saved.metaPath = metaPath;

    return saved;
}

function escapeAppleScriptString(value) {
    return String(value || '')
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"');
}

function normalizeDesktopText(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeText(value, max = 240) {
    return String(value || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
}

function tokenizeDesktopText(value) {
    return normalizeDesktopText(value).split(/\s+/).filter(Boolean);
}

function parseAppleScriptList(raw) {
    return String(raw || '')
        .split(',')
        .map((item) => String(item || '').trim())
        .filter(Boolean);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function runAppleScript(script) {
    return new Promise((resolve, reject) => {
        const child = spawn('osascript', ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
        child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) {
                resolve(stdout.trim());
            } else {
                reject(new Error((stderr || stdout || `osascript exited ${code}`).trim()));
            }
        });
    });
}

function getExpectedScriptLanguage(platform = process.platform) {
    if (platform === 'darwin') return 'applescript';
    if (platform === 'win32') return 'powershell';
    return 'bash';
}

function resolvePowerShellBinary() {
    if (process.platform !== 'win32') return null;
    return 'powershell.exe';
}

function runShellCommand(command, args = [], { input = '' } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
        child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
        child.on('error', reject);
        child.on('close', (code) => {
            resolve({
                success: code === 0,
                code,
                stdout: stdout.trim(),
                stderr: stderr.trim()
            });
        });

        if (input) {
            child.stdin.write(input);
        }
        child.stdin.end();
    });
}

async function canExecuteCommand(command, args = ['--version']) {
    try {
        const result = await runShellCommand(command, args);
        return result.success || result.code === 0;
    } catch {
        return false;
    }
}

async function runAutomationScript(language, script) {
    const code = String(script || '').trim();
    if (!code) {
        return { success: false, reason: 'empty_script', error: 'Script content is empty' };
    }

    if (language === 'applescript') {
        if (process.platform !== 'darwin') {
            return { success: false, reason: 'unsupported_platform', error: 'AppleScript is only supported on macOS' };
        }
        try {
            const stdout = await runAppleScript(code);
            return { success: true, stdout, language };
        } catch (error) {
            return {
                success: false,
                reason: isDesktopPermissionError(error?.message) ? 'permission_required' : 'script_error',
                permissionRequired: isDesktopPermissionError(error?.message),
                error: error?.message || 'AppleScript execution failed',
                language
            };
        }
    }

    if (language === 'powershell') {
        if (process.platform !== 'win32') {
            return { success: false, reason: 'unsupported_platform', error: 'PowerShell automation is only supported on Windows' };
        }
        const bin = resolvePowerShellBinary();
        if (!bin) {
            return { success: false, reason: 'missing_dependency', error: 'PowerShell is unavailable' };
        }
        const result = await runShellCommand(bin, ['-NoProfile', '-NonInteractive', '-Command', code]);
        return {
            ...result,
            language,
            reason: result.success ? null : 'script_error',
            error: result.success ? null : (result.stderr || result.stdout || 'PowerShell execution failed')
        };
    }

    if (language === 'bash') {
        if (process.platform === 'win32') {
            return { success: false, reason: 'unsupported_platform', error: 'Bash automation is not supported on Windows' };
        }
        const result = await runShellCommand('/bin/bash', ['-lc', code]);
        return {
            ...result,
            language,
            reason: result.success ? null : 'script_error',
            error: result.success ? null : (result.stderr || result.stdout || 'Bash execution failed')
        };
    }

    return { success: false, reason: 'unsupported_language', error: `Unsupported script language: ${language}` };
}

async function runDesktopTypeText(text, options = {}) {
    const value = String(text || '')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/[.!?]+$/g, '');
    if (!value.trim()) {
        return { success: false, reason: 'empty_text', error: 'No text provided' };
    }
    const pressEnter = options?.pressEnter === true;

    if (process.platform === 'darwin') {
        let activeAppName = await getActiveAppNameSafe();
        const recentTarget = getRecentDesktopTarget();
        const candidateApps = [...new Set([
            String(options?.targetApp || '').trim(),
            String(options?.app || '').trim(),
            String(recentTarget?.app || '').trim(),
            String(lastAutomationContext?.app || '').trim()
        ].filter((appName) => appName && !isRelayAppName(appName)))];

        const needsFocusRestore = !activeAppName || activeAppName === 'Unknown App' || isRelayAppName(activeAppName);
        if (needsFocusRestore && candidateApps.length > 0) {
            for (const candidateApp of candidateApps) {
                try {
                    await activateDesktopApp(candidateApp);
                    await sleep(140);
                    activeAppName = await getActiveAppNameSafe();
                    if (activeAppName && activeAppName !== 'Unknown App' && !isRelayAppName(activeAppName)) {
                        break;
                    }
                } catch (error) {
                    console.warn('[DesktopType] app restore failed:', error?.message || error);
                }
            }
        }
        const unresolvedFocus = !activeAppName || activeAppName === 'Unknown App' || isRelayAppName(activeAppName);
        if (unresolvedFocus && candidateApps.length > 0) {
            activeAppName = candidateApps[0];
        }
        const escaped = escapeAppleScriptString(value);
        const script = `
            tell application "System Events"
                keystroke "${escaped}"
                ${pressEnter ? 'key code 36' : ''}
            end tell
        `;
        try {
            await Promise.race([
                runAppleScript(script),
                sleep(3500).then(() => {
                    throw new Error('desktop_type_timeout');
                })
            ]);
            return {
                success: true,
                platform: 'darwin',
                app: activeAppName || '',
                focusAssumed: unresolvedFocus
            };
        } catch (error) {
            return {
                success: false,
                reason: String(error?.message || '').includes('desktop_type_timeout')
                    ? 'type_timeout'
                    : (isDesktopPermissionError(error?.message) ? 'permission_required' : 'type_failed'),
                permissionRequired: isDesktopPermissionError(error?.message),
                error: error?.message || 'Failed to type text'
            };
        }
    }

    if (process.platform === 'win32') {
        const escaped = value.replace(/"/g, '""');
        const enterLine = pressEnter ? '$wshell.SendKeys("~")' : '';
        const script = `
            $wshell = New-Object -ComObject WScript.Shell
            $wshell.SendKeys("${escaped}")
            ${enterLine}
        `;
        const result = await runShellCommand(resolvePowerShellBinary() || 'powershell.exe', [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            script
        ]);
        return {
            success: result.success,
            platform: 'win32',
            reason: result.success ? null : 'type_failed',
            error: result.success ? null : (result.stderr || result.stdout || 'Failed to type text on Windows')
        };
    }

    const hasXdotool = await canExecuteCommand('xdotool', ['--version']);
    if (!hasXdotool) {
        return {
            success: false,
            reason: 'missing_dependency',
            error: 'xdotool is required for Linux text typing'
        };
    }

    const escaped = value.replace(/"/g, '\\"');
    const enterCmd = pressEnter ? ' && xdotool key Return' : '';
    const result = await runShellCommand('/bin/bash', ['-lc', `xdotool type --delay 1 -- "${escaped}"${enterCmd}`]);
    return {
        success: result.success,
        platform: 'linux',
        reason: result.success ? null : 'type_failed',
        error: result.success ? null : (result.stderr || result.stdout || 'Failed to type text on Linux')
    };
}

const MAC_FUNCTION_KEYCODES = {
    f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97,
    f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111
};

const MAC_KEYCODES = {
    enter: 36,
    return: 36,
    tab: 48,
    escape: 53,
    esc: 53,
    space: 49,
    spacebar: 49,
    backspace: 51,
    delete: 117,
    up: 126,
    down: 125,
    left: 123,
    right: 124,
    home: 115,
    end: 119,
    'page up': 116,
    'page down': 121
};

function parseDesktopPressIntent(rawPhrase, activeAppName = '') {
    const normalized = normalizeDesktopText(rawPhrase)
        .replace(/^press(?: on)?\s+/, '')
        .replace(/^(the|a|an)\s+/, '')
        .trim();
    if (!normalized) {
        return { error: 'empty_key' };
    }

    const tokens = normalized.split(/\s+/).filter(Boolean);
    const modifiers = [];
    const remainder = [];
    tokens.forEach((token) => {
        if (token === 'command' || token === 'cmd' || token === 'meta') {
            if (!modifiers.includes('command down')) modifiers.push('command down');
            return;
        }
        if (token === 'shift') {
            if (!modifiers.includes('shift down')) modifiers.push('shift down');
            return;
        }
        if (token === 'option' || token === 'alt') {
            if (!modifiers.includes('option down')) modifiers.push('option down');
            return;
        }
        if (token === 'control' || token === 'ctrl') {
            if (!modifiers.includes('control down')) modifiers.push('control down');
            return;
        }
        if (token === 'key' || token === 'button' || token === 'on') {
            return;
        }
        remainder.push(token);
    });

    let keyPhrase = remainder.join(' ').trim();
    if (!keyPhrase) {
        return { error: 'empty_key' };
    }

    const browserShortcut = /\b(new tab|plus button|plus icon|\+)\b/.test(keyPhrase);
    if (browserShortcut) {
        if (!modifiers.includes('command down')) modifiers.push('command down');
        keyPhrase = 't';
    }

    if (MAC_FUNCTION_KEYCODES[keyPhrase] != null) {
        return { keyCode: MAC_FUNCTION_KEYCODES[keyPhrase], modifiers, keyLabel: keyPhrase };
    }
    if (MAC_KEYCODES[keyPhrase] != null) {
        return { keyCode: MAC_KEYCODES[keyPhrase], modifiers, keyLabel: keyPhrase };
    }

    const symbolMap = {
        plus: '+',
        minus: '-',
        period: '.',
        dot: '.',
        comma: ',',
        slash: '/',
        backslash: '\\',
        quote: "'"
    };
    if (symbolMap[keyPhrase]) {
        return { keyChar: symbolMap[keyPhrase], modifiers, keyLabel: keyPhrase };
    }

    if (keyPhrase.length === 1) {
        return { keyChar: keyPhrase, modifiers, keyLabel: keyPhrase };
    }

    // Handle phrases like "command t" where key token arrives as trailing word.
    if (tokens.length > 0) {
        const lastToken = tokens[tokens.length - 1];
        if (lastToken && lastToken.length === 1) {
            return { keyChar: lastToken, modifiers, keyLabel: lastToken };
        }
    }

    if (isLikelyBrowserApp(activeAppName) && keyPhrase.includes('plus')) {
        if (!modifiers.includes('command down')) modifiers.push('command down');
        return { keyChar: 't', modifiers, keyLabel: 'new_tab' };
    }

    return { error: 'unknown_key', keyLabel: keyPhrase };
}

async function runDesktopPressKey(rawPhrase, options = {}) {
    const phrase = String(rawPhrase || '').trim();
    if (!phrase) {
        return { success: false, reason: 'empty_key', error: 'No key provided' };
    }

    if (process.platform !== 'darwin') {
        return { success: false, reason: 'unsupported_platform', error: 'Keyboard press automation is currently macOS-only' };
    }

    let activeAppName = await getActiveAppNameSafe();
    const recentTarget = getRecentDesktopTarget();
    const candidateApps = [...new Set([
        String(options?.targetApp || '').trim(),
        String(recentTarget?.app || '').trim(),
        String(lastAutomationContext?.app || '').trim()
    ].filter((appName) => appName && !isRelayAppName(appName)))];

    if ((!activeAppName || activeAppName === 'Unknown App' || isRelayAppName(activeAppName)) && candidateApps.length > 0) {
        try {
            await activateDesktopApp(candidateApps[0]);
            await sleep(120);
            activeAppName = candidateApps[0];
        } catch {
            activeAppName = candidateApps[0];
        }
    }

    const parsed = parseDesktopPressIntent(phrase, activeAppName);
    if (parsed.error) {
        return {
            success: false,
            reason: parsed.error,
            error: parsed.error === 'unknown_key'
                ? `Unsupported key phrase "${parsed.keyLabel || phrase}"`
                : 'No key provided'
        };
    }

    const usingClause = parsed.modifiers?.length
        ? ` using {${parsed.modifiers.join(', ')}}`
        : '';
    const keyAction = parsed.keyCode != null
        ? `key code ${parsed.keyCode}${usingClause}`
        : `keystroke "${escapeAppleScriptString(parsed.keyChar)}"${usingClause}`;

    const script = `
        tell application "System Events"
            ${keyAction}
        end tell
    `;
    try {
        await runAppleScript(script);
        return {
            success: true,
            app: activeAppName || '',
            key: parsed.keyLabel || parsed.keyChar || String(parsed.keyCode || ''),
            modifiers: parsed.modifiers || []
        };
    } catch (error) {
        return {
            success: false,
            reason: isDesktopPermissionError(error?.message) ? 'permission_required' : 'press_failed',
            permissionRequired: isDesktopPermissionError(error?.message),
            error: error?.message || 'Failed to press key'
        };
    }
}

function parseContactListOutput(raw) {
    return String(raw || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
            const [namePart, valuePart] = line.split('|');
            return {
                name: String(namePart || '').trim(),
                value: String(valuePart || '').trim()
            };
        })
        .filter((entry) => entry.name || entry.value);
}

async function getMacContacts() {
    if (process.platform !== 'darwin') return [];
    const script = `
        tell application "Contacts"
            set outputLines to {}
            repeat with p in (every person)
                set personName to name of p as text
                set selectedValue to ""
                if (count of emails of p) > 0 then
                    set selectedValue to value of first email of p as text
                else if (count of phones of p) > 0 then
                    set selectedValue to value of first phone of p as text
                end if
                if personName is not "" then
                    copy (personName & "|" & selectedValue) to end of outputLines
                end if
            end repeat
            return outputLines as text
        end tell
    `;
    try {
        const raw = await runAppleScript(script);
        return parseContactListOutput(raw).slice(0, 500);
    } catch {
        return [];
    }
}

function addRecentRecipient(value) {
    const normalized = String(value || '').trim();
    if (!normalized) return;
    const deduped = recentRecipients.filter((entry) => entry.toLowerCase() !== normalized.toLowerCase());
    deduped.unshift(normalized);
    while (deduped.length > 12) deduped.pop();
    recentRecipients.splice(0, recentRecipients.length, ...deduped);
}

function isPronounOnlyRequest(text) {
    const normalized = normalizeDesktopText(text);
    if (!normalized) return false;
    return /\b(him|her|them|that person|that contact)\b/.test(normalized);
}

function matchRecipientFromRecentOrContacts(target, contacts = []) {
    const normalizedTarget = normalizeDesktopText(target);
    if (!normalizedTarget) return '';

    const recentsHit = recentRecipients.find((entry) => normalizeDesktopText(entry).includes(normalizedTarget));
    if (recentsHit) return recentsHit;

    let best = '';
    let score = 0;
    contacts.forEach((contact) => {
        const name = normalizeDesktopText(contact.name);
        if (!name) return;
        const hit = name.includes(normalizedTarget) || normalizedTarget.includes(name);
        if (!hit) return;
        const currentScore = name === normalizedTarget ? 2 : 1;
        if (currentScore > score) {
            score = currentScore;
            best = contact.name;
        }
    });
    return best;
}

function normalizeAutomationContext(context = {}, ttlMs = 45000) {
    const now = Date.now();
    const maxAge = Math.max(5000, Number(ttlMs) || 45000);
    const contextTimestamp = Number(context?.timestamp || 0);
    const isFresh = now - contextTimestamp <= maxAge;

    if (!isFresh) {
        return { app: '', target: '', recipient: '', intent: '', timestamp: now };
    }

    return {
        app: String(context?.app || '').trim().slice(0, 120),
        target: String(context?.target || '').trim().slice(0, 240),
        recipient: String(context?.recipient || '').trim().slice(0, 120),
        intent: String(context?.intent || '').trim().slice(0, 80),
        timestamp: contextTimestamp || now
    };
}

function updateAutomationContext(next = {}) {
    lastAutomationContext = {
        app: String(next.app || lastAutomationContext.app || '').trim().slice(0, 120),
        target: String(next.target || lastAutomationContext.target || '').trim().slice(0, 240),
        recipient: String(next.recipient || lastAutomationContext.recipient || '').trim().slice(0, 120),
        intent: String(next.intent || lastAutomationContext.intent || '').trim().slice(0, 80),
        timestamp: Date.now()
    };
    if (lastAutomationContext.recipient) {
        addRecentRecipient(lastAutomationContext.recipient);
    }
}

function updateLastDesktopTarget(next = {}) {
    const target = String(next.target || '').trim().slice(0, 240);
    if (!target) return;
    lastDesktopTarget = {
        app: String(next.app || lastDesktopTarget.app || '').trim().slice(0, 120),
        target,
        source: String(next.source || '').trim().slice(0, 80),
        timestamp: Date.now()
    };
}

function getRecentDesktopTarget(maxAgeMs = 45000) {
    const maxAge = Math.max(5000, Number(maxAgeMs) || 45000);
    if (!lastDesktopTarget.timestamp) return null;
    if (Date.now() - lastDesktopTarget.timestamp > maxAge) return null;
    if (!lastDesktopTarget.target) return null;
    return { ...lastDesktopTarget };
}

async function probeAutomationCapabilities() {
    const platform = process.platform;
    const expectedLanguage = getExpectedScriptLanguage(platform);
    const capabilities = {
        platform,
        expectedLanguage,
        setupComplete: isSetupComplete(),
        permissions: {
            microphone: true,
            screen: 'unknown',
            accessibility: 'unknown',
            automation: 'unknown'
        },
        runners: {
            applescript: false,
            powershell: false,
            bash: false
        },
        degraded: false,
        missing: [],
        remediation: []
    };

    capabilities.runners.applescript = platform === 'darwin' && await canExecuteCommand('osascript', ['-e', 'return 1']);
    capabilities.runners.powershell = platform === 'win32' && await canExecuteCommand(resolvePowerShellBinary() || 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion']);
    capabilities.runners.bash = platform !== 'win32' && await canExecuteCommand('/bin/bash', ['-lc', 'echo ok']);

    if (!capabilities.runners[expectedLanguage]) {
        capabilities.missing.push(`${expectedLanguage}-runner`);
        capabilities.remediation.push({
            key: `${expectedLanguage}-runner`,
            title: `Install or enable ${expectedLanguage}`,
            systemSettings: 'default'
        });
    }

    if (platform === 'darwin') {
        try {
            const sources = await desktopCapturer.getSources({
                types: ['screen'],
                thumbnailSize: { width: 16, height: 16 }
            });
            capabilities.permissions.screen = Array.isArray(sources) && sources.length > 0;
        } catch {
            capabilities.permissions.screen = false;
            capabilities.missing.push('screen-recording');
            capabilities.remediation.push({
                key: 'screen-recording',
                title: 'Enable Screen Recording',
                systemSettings: 'screen-recording'
            });
        }

        try {
            await activeWindow();
            capabilities.permissions.accessibility = true;
            capabilities.permissions.automation = true;
        } catch {
            capabilities.permissions.accessibility = false;
            capabilities.permissions.automation = false;
            capabilities.missing.push('accessibility');
            capabilities.remediation.push({
                key: 'accessibility',
                title: 'Enable Accessibility',
                systemSettings: 'accessibility'
            });
        }
    }

    capabilities.degraded = capabilities.missing.length > 0;
    return capabilities;
}

function isDestructiveAutomationIntent(plan) {
    const intent = String(plan?.intent || '').toLowerCase();
    if (DESTRUCTIVE_INTENTS.has(intent)) return true;
    return Array.isArray(plan?.steps) && plan.steps.some((step) => {
        const action = String(step?.action || '').toLowerCase();
        return DESTRUCTIVE_INTENTS.has(action) || /delete|remove|purchase|payment|erase|wipe/.test(action);
    });
}

function isAssistiveAutomationPlan(plan) {
    const intent = String(plan?.intent || '').toLowerCase();
    if (ASSISTIVE_INTENTS.has(intent)) return true;
    if (!Array.isArray(plan?.steps) || plan.steps.length === 0) return false;
    return plan.steps.every((step) => {
        const action = String(step?.action || '').toLowerCase();
        if (!action) return false;
        return ASSISTIVE_INTENTS.has(action) || action.startsWith('wait_') || action.startsWith('assert_');
    });
}

function planRequiresConfirmation(plan, settingsState = {}) {
    const risk = String(plan?.risk || 'medium').toLowerCase();
    if (Boolean(plan?.requires_confirmation)) return true;
    if (risk === 'high' || risk === 'critical') return true;
    if (settingsState.automationRequireHighRiskConfirmation !== false && risk === 'medium' && isDestructiveAutomationIntent(plan)) {
        return true;
    }
    return false;
}

async function resolveVisionFallbackTarget(targetPhrase, activeAppName = 'Unknown App') {
    const phrase = String(targetPhrase || '').trim();
    if (!phrase) return null;

    const screenshot = await getPrimaryScreenScreenshotDataUrl();
    const openai = getOpenAIClient();
    const schema = {
        type: 'object',
        additionalProperties: false,
        required: ['found', 'app_hint', 'url_hint', 'reason'],
        properties: {
            found: { type: 'boolean' },
            app_hint: { type: 'string', maxLength: 120 },
            url_hint: { type: 'string', maxLength: 400 },
            reason: { type: 'string', maxLength: 260 }
        }
    };

    const completion = await openai.chat.completions.create({
        model: FAST_VISION_MODEL,
        temperature: 0,
        stream: false,
        max_tokens: 220,
        response_format: {
            type: 'json_schema',
            json_schema: {
                name: 'vision_target_hint_v1',
                strict: true,
                schema
            }
        },
        messages: [
            {
                role: 'system',
                content: `Given a screenshot and user target phrase, provide one app hint or one URL hint that would best satisfy navigation/click automation.
Return strict JSON only.
Do not include coordinates.`
            },
            {
                role: 'user',
                content: [
                    {
                        type: 'text',
                        text: `Target phrase: "${phrase}". Active app: "${activeAppName}".`
                    },
                    { type: 'image_url', image_url: { url: screenshot } }
                ]
            }
        ]
    });

    const parsed = extractMessageJson(completion.choices?.[0]?.message);
    if (!parsed || parsed.found !== true) return null;
    return {
        app: String(parsed.app_hint || '').trim(),
        url: String(parsed.url_hint || '').trim(),
        reason: String(parsed.reason || '').trim()
    };
}

async function resolveVisionClickScript(targetPhrase, activeAppName = 'Unknown App') {
    const phrase = String(targetPhrase || '').trim();
    if (!phrase) return null;

    const screenshot = await getPrimaryScreenScreenshotDataUrl();
    const display = screen.getPrimaryDisplay();
    const size = display?.size || { width: 0, height: 0 };
    const openai = getOpenAIClient();
    const schema = {
        type: 'object',
        additionalProperties: false,
        required: ['found', 'reason', 'script'],
        properties: {
            found: { type: 'boolean' },
            reason: { type: 'string', maxLength: 320 },
            script: { type: 'string', maxLength: 8000 }
        }
    };

    const completion = await openai.chat.completions.create({
        model: FAST_VISION_MODEL,
        temperature: 0,
        stream: false,
        max_tokens: 700,
        response_format: {
            type: 'json_schema',
            json_schema: {
                name: 'vision_click_script_v1',
                strict: true,
                schema
            }
        },
        messages: [
            {
                role: 'system',
                content: `You generate a macOS AppleScript action to click/focus a requested UI target.
Return strict JSON only.
Rules:
- Output script ONLY for AppleScript.
- Prefer System Events keystrokes and AX interactions.
- Keep script short and executable.
- If target cannot be determined reliably, set found=false and leave script empty.`
            },
            {
                role: 'user',
                content: [
                    {
                        type: 'text',
                        text: `Target="${phrase}" ActiveApp="${activeAppName}" Resolution=${size.width}x${size.height}. Build one AppleScript to activate/focus/click that target.`
                    },
                    { type: 'image_url', image_url: { url: screenshot } }
                ]
            }
        ]
    });

    const parsed = extractMessageJson(completion.choices?.[0]?.message);
    if (!parsed || parsed.found !== true) return null;
    const script = String(parsed.script || '').trim();
    if (!script) return null;
    return {
        script,
        reason: String(parsed.reason || '').trim()
    };
}

function runOpenApplication(appName) {
    return new Promise((resolve) => {
        const child = spawn('open', ['-a', appName], { stdio: 'ignore' });
        child.on('error', () => resolve(false));
        child.on('close', (code) => resolve(code === 0));
    });
}

async function getForegroundAppNames() {
    if (process.platform !== 'darwin') return [];
    const raw = await runAppleScript(
        'tell application "System Events" to get name of (every process whose background only is false)'
    );
    return parseAppleScriptList(raw);
}

function scoreDesktopAppMatch(appName, targetPhrase) {
    const appNorm = normalizeDesktopText(appName);
    const targetNorm = normalizeDesktopText(targetPhrase);
    if (!appNorm || !targetNorm) return 0;
    if (appNorm === targetNorm) return 10;
    if (appNorm.includes(targetNorm)) return 8;
    if (targetNorm.includes(appNorm)) return 7;

    const appTokens = new Set(tokenizeDesktopText(appName));
    const targetTokens = tokenizeDesktopText(targetPhrase);
    if (targetTokens.length === 0) return 0;

    let score = 0;
    targetTokens.forEach((token) => {
        if (appTokens.has(token)) {
            score += 1.8;
            return;
        }
        const partial = [...appTokens].some((appToken) => appToken.includes(token) || token.includes(appToken));
        if (partial) score += 0.7;
    });

    return score;
}

function expandDesktopTargetCandidates(targetPhrase) {
    const normalized = normalizeDesktopText(targetPhrase);
    const candidates = new Set([targetPhrase, normalized]);

    const aliasMap = new Map([
        ['chrome', 'Google Chrome'],
        ['google', 'Google Chrome'],
        ['safari', 'Safari'],
        ['finder', 'Finder'],
        ['messages', 'Messages'],
        ['message', 'Messages'],
        ['system settings', 'System Settings'],
        ['settings', 'System Settings'],
        ['terminal', 'Terminal'],
        ['slack', 'Slack'],
        ['discord', 'Discord'],
        ['zoom', 'zoom.us'],
        ['facetime', 'FaceTime'],
        ['mail', 'Mail'],
        ['notes', 'Notes']
    ]);

    for (const [alias, appName] of aliasMap.entries()) {
        if (normalized.includes(alias)) {
            candidates.add(appName);
        }
    }

    return [...candidates].filter(Boolean);
}

async function activateDesktopApp(appName) {
    const escaped = escapeAppleScriptString(appName);
    await runAppleScript(`tell application "${escaped}" to activate`);
}

function isDesktopPermissionError(errorMessage = '') {
    const msg = String(errorMessage || '').toLowerCase();
    return (
        msg.includes('not authorized') ||
        msg.includes('not permitted') ||
        msg.includes('accessibility') ||
        msg.includes('assistive') ||
        msg.includes('apple events')
    );
}

async function resolveDesktopTarget(targetPhrase, { allowOpen = true } = {}) {
    if (process.platform !== 'darwin') {
        return { success: false, reason: 'unsupported_platform', error: 'Desktop automation is only available on macOS.' };
    }

    const runningApps = await getForegroundAppNames();
    const candidates = expandDesktopTargetCandidates(targetPhrase);
    console.log(
        `[DesktopTarget] resolve target="${targetPhrase}" candidates=${JSON.stringify(candidates)} running_count=${runningApps.length} allowOpen=${allowOpen}`
    );

    let best = null;
    let bestScore = 0;
    for (const app of runningApps) {
        for (const candidate of candidates) {
            const score = scoreDesktopAppMatch(app, candidate);
            if (score > bestScore) {
                bestScore = score;
                best = app;
            }
        }
    }

    if (best && bestScore >= 1.8) {
        await activateDesktopApp(best);
        console.log(`[DesktopTarget] matched running app="${best}" score=${Number(bestScore.toFixed(2))}`);
        return { success: true, app: best, score: Number(bestScore.toFixed(2)), source: 'running_app' };
    }

    if (allowOpen) {
        for (const candidate of candidates) {
            console.log(`[DesktopTarget] trying open candidate="${candidate}"`);
            const opened = await runOpenApplication(candidate);
            if (opened) {
                try {
                    await activateDesktopApp(candidate);
                } catch {
                    // app may still be launching; activation can race.
                }
                console.log(`[DesktopTarget] opened app="${candidate}" source=open_app`);
                return { success: true, app: candidate, score: 0, source: 'open_app' };
            }
        }
    }

    console.log(`[DesktopTarget] miss target="${targetPhrase}" best="${best || ''}" score=${Number(bestScore.toFixed(2))}`);
    return { success: false, reason: 'target_not_found', error: `No app matched "${targetPhrase}"` };
}

function isLikelyBrowserApp(appName) {
    const normalized = normalizeDesktopText(appName);
    return (
        normalized.includes('chrome') ||
        normalized.includes('safari') ||
        normalized.includes('firefox') ||
        normalized.includes('edge') ||
        normalized.includes('brave') ||
        normalized.includes('arc') ||
        normalized.includes('opera') ||
        normalized.includes('vivaldi')
    );
}

function isRelayAppName(appName) {
    const normalized = normalizeDesktopText(appName);
    return normalized === 'relay' || normalized === 'electron' || normalized.includes('relay');
}

function sanitizeDesktopTargetPhrase(value) {
    return String(value || '')
        .trim()
        .replace(/^(the|a|an)\s+/i, '')
        .replace(/\s+/g, ' ')
        .trim();
}

async function tryMacAxClickTarget(targetPhrase) {
    if (process.platform !== 'darwin') {
        return { success: false, reason: 'unsupported_platform' };
    }

    const target = String(targetPhrase || '').trim();
    if (!target) {
        return { success: false, reason: 'target_not_found' };
    }

    const escaped = escapeAppleScriptString(target);
    const script = `
        set targetText to "${escaped}"
        tell application "System Events"
            set frontProc to first application process whose frontmost is true
            set targetWindow to missing value
            try
                set targetWindow to first window of frontProc whose value of attribute "AXMain" is true
            on error
                try
                    set targetWindow to first window of frontProc
                end try
            end try

            ignoring case
                if targetWindow is not missing value then
                    try
                        set hitButton to first button of targetWindow whose name contains targetText
                        perform action "AXPress" of hitButton
                        return "window_button"
                    end try
                    try
                        set hitElement to first UI element of targetWindow whose name contains targetText
                        if exists action "AXPress" of hitElement then
                            perform action "AXPress" of hitElement
                            return "window_element"
                        end if
                    end try
                end if

                try
                    set allElements to entire contents of frontProc
                    repeat with hitElement in allElements
                        try
                            set elementName to name of hitElement as text
                            if elementName is not "" and elementName contains targetText then
                                if exists action "AXPress" of hitElement then
                                    perform action "AXPress" of hitElement
                                    return "process_element"
                                end if
                            end if
                        end try
                    end repeat
                end try
            end ignoring
        end tell
        return "miss"
    `;

    try {
        const output = String(await runAppleScript(script)).trim();
        if (!output || output === 'miss') {
            return { success: false, reason: 'target_not_found' };
        }
        return { success: true, source: 'ax_press', axPath: output };
    } catch (error) {
        return {
            success: false,
            reason: isDesktopPermissionError(error?.message) ? 'permission_required' : 'click_failed',
            permissionRequired: isDesktopPermissionError(error?.message),
            error: error?.message || 'AX click failed'
        };
    }
}

async function runMacShortcutAdapter(targetPhrase, activeAppName = '') {
    if (process.platform !== 'darwin') {
        return { success: false, reason: 'unsupported_platform' };
    }

    const normalized = normalizeDesktopText(targetPhrase);
    if (!normalized) {
        return { success: false, reason: 'target_not_found' };
    }

    const adapters = [
        {
            key: 'new_tab',
            test: /(?:\bnew tab\b|\bplus button\b|\bplus icon\b|\bplus\b|\+)/,
            requiresBrowser: true,
            script: 'tell application "System Events" to keystroke "t" using {command down}'
        },
        {
            key: 'reload',
            test: /\b(reload|refresh)\b/,
            requiresBrowser: true,
            script: 'tell application "System Events" to keystroke "r" using {command down}'
        },
        {
            key: 'back',
            test: /^back$|go back|navigate back/,
            requiresBrowser: true,
            script: 'tell application "System Events" to keystroke "[" using {command down}'
        },
        {
            key: 'forward',
            test: /^forward$|go forward|navigate forward/,
            requiresBrowser: true,
            script: 'tell application "System Events" to keystroke "]" using {command down}'
        },
        {
            key: 'address_bar',
            test: /\b(address bar|url bar|search bar|omnibox)\b/,
            requiresBrowser: true,
            script: 'tell application "System Events" to keystroke "l" using {command down}'
        },
        {
            key: 'send',
            test: /\bsend\b/,
            requiresBrowser: false,
            script: 'tell application "System Events" to key code 36'
        }
    ];

    const adapter = adapters.find((entry) => entry.test.test(normalized));
    if (!adapter) {
        return { success: false, reason: 'target_not_found' };
    }
    if (adapter.requiresBrowser && !isLikelyBrowserApp(activeAppName)) {
        const recentTarget = getRecentDesktopTarget();
        if (!isLikelyBrowserApp(recentTarget?.app || '')) {
            return { success: false, reason: 'target_not_found' };
        }
        try {
            await activateDesktopApp(recentTarget.app);
            await sleep(120);
        } catch {
            // best effort activation; continue with shortcut attempt
        }
    }

    try {
        await runAppleScript(adapter.script);
        return {
            success: true,
            source: 'shortcut_adapter',
            adapter: adapter.key
        };
    } catch (error) {
        return {
            success: false,
            reason: isDesktopPermissionError(error?.message) ? 'permission_required' : 'click_failed',
            permissionRequired: isDesktopPermissionError(error?.message),
            error: error?.message || 'Shortcut adapter failed'
        };
    }
}

async function tryMessagesConversationTarget(targetPhrase, activeAppName = '') {
    if (process.platform !== 'darwin') {
        return { success: false, reason: 'unsupported_platform' };
    }
    if (!normalizeDesktopText(activeAppName).includes('messages')) {
        return { success: false, reason: 'target_not_found' };
    }

    const target = String(targetPhrase || '').trim();
    if (!target || target.length < 2) {
        return { success: false, reason: 'target_not_found' };
    }

    const escaped = escapeAppleScriptString(target);
    const script = `
        tell application "Messages" to activate
        delay 0.2
        tell application "System Events"
            keystroke "f" using {command down}
            delay 0.2
            keystroke "${escaped}"
            delay 0.3
            key code 36
        end tell
    `;
    try {
        await runAppleScript(script);
        return { success: true, source: 'messages_search', adapter: 'messages_search' };
    } catch (error) {
        return {
            success: false,
            reason: isDesktopPermissionError(error?.message) ? 'permission_required' : 'click_failed',
            permissionRequired: isDesktopPermissionError(error?.message),
            error: error?.message || 'Messages conversation focus failed'
        };
    }
}

async function performDesktopClickTarget(targetPhrase, options = {}) {
    const target = sanitizeDesktopTargetPhrase(targetPhrase);
    if (!target) {
        return { success: false, reason: 'target_not_found', error: 'No click target provided' };
    }

    let activeAppName = await getActiveAppNameSafe();
    const recentTarget = getRecentDesktopTarget();
    if ((!activeAppName || activeAppName === 'Unknown App' || isRelayAppName(activeAppName)) && recentTarget?.app) {
        try {
            await activateDesktopApp(recentTarget.app);
            await sleep(120);
            activeAppName = recentTarget.app;
        } catch {
            activeAppName = recentTarget.app;
        }
    }
    const axResult = await tryMacAxClickTarget(target);
    if (axResult.success) {
        return {
            success: true,
            app: activeAppName,
            source: axResult.source,
            clickFallback: 'ax_press',
            target
        };
    }
    if (axResult.permissionRequired) {
        return axResult;
    }

    const shortcutResult = await runMacShortcutAdapter(target, activeAppName);
    if (shortcutResult.success) {
        return {
            success: true,
            app: activeAppName,
            source: shortcutResult.source,
            clickFallback: shortcutResult.adapter || 'shortcut_adapter',
            target
        };
    }
    if (shortcutResult.permissionRequired) {
        return shortcutResult;
    }

    const messagesResult = await tryMessagesConversationTarget(target, activeAppName);
    if (messagesResult.success) {
        return {
            success: true,
            app: activeAppName,
            source: messagesResult.source,
            clickFallback: messagesResult.adapter || 'messages_search',
            target
        };
    }
    if (messagesResult.permissionRequired) {
        return messagesResult;
    }

    const resolved = await resolveDesktopTarget(target, { allowOpen: options.allowOpen !== false });
    if (resolved.success) {
        return { ...resolved, clickFallback: 'activate_app', target };
    }
    return resolved;
}

async function getPrimaryScreenScreenshotDataUrl() {
    const primaryDisplay = screen.getPrimaryDisplay();
    const displaySize = primaryDisplay?.size || { width: 1920, height: 1080 };
    const scaleFactor = Math.max(1, Number(primaryDisplay?.scaleFactor || 1));
    const captureWidth = Math.max(1280, Math.min(3840, Math.round(Number(displaySize.width || 1920) * scaleFactor)));
    const captureHeight = Math.max(720, Math.min(2160, Math.round(Number(displaySize.height || 1080) * scaleFactor)));

    const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: captureWidth, height: captureHeight }
    });

    if (!Array.isArray(sources) || sources.length === 0) {
        throw new Error('No screen sources available. Enable Screen Recording permission.');
    }

    const primaryDisplayId = String(primaryDisplay?.id || '');
    const selectedSource = sources.find((source) => String(source?.display_id || '') === primaryDisplayId) || sources[0];
    if (!selectedSource?.thumbnail) {
        throw new Error('No screen thumbnail available. Enable Screen Recording permission.');
    }
    return encodeImageForUpload(selectedSource.thumbnail);
}

async function getActiveAppNameSafe() {
    try {
        const windowInfo = await activeWindow();
        return windowInfo?.owner?.name || 'Unknown App';
    } catch {
        return 'Unknown App';
    }
}

async function analyzeImageWithOpenAI({
    imageDataUrl,
    mode = 'screen',
    appName = 'Unknown App',
    prompt = '',
    detail = 'high'
}) {
    if (!imageDataUrl || typeof imageDataUrl !== 'string') {
        throw new Error('Invalid image payload');
    }

    const openai = getOpenAIClient();
    const modeLabel = String(mode || 'screen').toLowerCase();
    const detailLabel = String(detail || 'high').toLowerCase();
    const isScreenMode = modeLabel !== 'image';

    const activeLang = settings.get('language') || 'en-US';
    const basePrompt = isScreenMode
        ? `Describe the full screen for accessibility use. Active app: "${appName}". You MUST respond completely in the language corresponding to this ISO tag: ${activeLang}.`
        : `Describe only the image content for accessibility use. Ignore app UI and overlays. You MUST respond completely in the language corresponding to this ISO tag: ${activeLang}.`;
    const isBrief = detailLabel === 'brief' || detailLabel === 'low' || detailLabel === 'fast';
    const imageDetail = isBrief ? 'low' : 'high';

    const instruction = [
        basePrompt,
        prompt ? `Focus: ${String(prompt).trim()}` : '',
        isBrief
            ? 'Keep it brief (1-3 short sentences).'
            : 'Be specific and concise. Focus only on meaningful content.'
    ].filter(Boolean).join('\n');

    const completion = await openai.chat.completions.create({
        model: FAST_VISION_MODEL,
        temperature: isBrief ? 0 : 0.1,
        stream: false,
        max_tokens: isBrief ? 220 : 380,
        response_format: {
            type: 'json_schema',
            json_schema: {
                name: 'image_analysis_v1',
                strict: true,
                schema: IMAGE_ANALYSIS_SCHEMA
            }
        },
        messages: [
            {
                role: 'system',
                    content: `You are an accessibility vision assistant.
Return strict JSON matching the schema.
For "description", provide a clear natural-language summary.
For "objects", list notable entities or UI elements.
For "text", include important readable text seen in the image.
Confidence should be calibrated 0-1.
Ignore any Relay overlay/toolbars/captions, window chrome, chat bubbles, and self-referential app UI unless explicitly asked.
Do not mention the assistant or app itself in the description. Focus only on the visual image content.`
                },
            {
                role: 'user',
                content: [
                    { type: 'text', text: instruction },
                    { type: 'image_url', image_url: { url: imageDataUrl, detail: imageDetail } }
                ]
            }
        ]
    });

    const parsed = extractMessageJson(completion.choices?.[0]?.message);
    if (!parsed || typeof parsed !== 'object') {
        throw new Error('Vision response parsing failed');
    }

    const objects = Array.isArray(parsed.objects)
        ? parsed.objects.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 12)
        : [];

    return {
        description: String(parsed.description || '').trim(),
        objects,
        text: String(parsed.text || '').trim(),
        confidence: clampConfidence(parsed.confidence, 0.72)
    };
}

async function resolveRecipientForPlanning(utterance, incomingContext = {}) {
    const text = String(utterance || '').trim();
    const explicitTarget = String(incomingContext?.recipient || '').trim();
    if (explicitTarget) {
        const contacts = await getMacContacts();
        const matched = matchRecipientFromRecentOrContacts(explicitTarget, contacts);
        return matched || explicitTarget;
    }

    if (!isPronounOnlyRequest(text)) return '';

    const ttlMs = Number(settings.get('automationContextTtlMs') || 45000);
    const normalizedCtx = normalizeAutomationContext(lastAutomationContext, ttlMs);
    if (normalizedCtx.recipient) return normalizedCtx.recipient;

    if (recentRecipients.length > 0) return recentRecipients[0];
    return '';
}

function buildAutomationPlannerMessages({
    utterance,
    platform,
    scriptLanguage,
    activeApp,
    displayInfo,
    context,
    recipientHint,
    capabilities
}) {
    const capabilitySummary = {
        platform: capabilities.platform,
        runners: capabilities.runners,
        degraded: capabilities.degraded,
        missing: capabilities.missing
    };
    return [
        {
            role: 'system',
            content: `You are Relay Premium Automation planner.
Return strict JSON matching the provided schema.
Platform: ${platform}
Script language: ${scriptLanguage}

Rules:
- Produce concise, executable assistive automation for the user's request.
- Respect platform and emit script only in "${scriptLanguage}".
- Do not emit destructive/admin actions unless user explicitly asks.
- For simple in-app actions (navigate/click/type/send/call/play/open), prefer low or medium risk.
- If action is destructive, set risk high/critical and requires_confirmation=true.
- Fill post_context to improve next chained request resolution.
- Keep steps short and specific.`
        },
        {
            role: 'user',
            content: JSON.stringify({
                utterance,
                active_app: activeApp,
                recipient_hint: recipientHint || null,
                display: {
                    width: Number(displayInfo?.width || 0),
                    height: Number(displayInfo?.height || 0),
                    scale_factor: Number(displayInfo?.scaleFactor || 1)
                },
                device: {
                    platform: process.platform,
                    arch: process.arch,
                    release: os.release()
                },
                context: {
                    app: context.app || '',
                    target: context.target || '',
                    recipient: context.recipient || '',
                    intent: context.intent || ''
                },
                capabilities: capabilitySummary
            })
        }
    ];
}

function extractSendMessagePayload(utterance = '') {
    const raw = String(utterance || '').trim();
    if (!raw) return null;
    const normalized = normalizeDesktopText(raw);
    if (!/\bsend\b/.test(normalized) || !/\bmessage\b/.test(normalized)) {
        return null;
    }

    let recipient = '';
    let message = '';

    const messageMatch = raw.match(
        /send\s+(?:a\s+)?message(?:\s+to\s+(.+?))?\s+(?:saying|that says|saying that|with text|saying this)?\s*(.+)$/i
    );
    if (messageMatch) {
        recipient = String(messageMatch[1] || '').trim();
        message = String(messageMatch[2] || '').trim();
    } else {
        const fallbackMatch = raw.match(/send\s+(?:a\s+)?message(?:\s+to\s+(.+))?$/i);
        recipient = String(fallbackMatch?.[1] || '').trim();
    }

    if (!message) {
        const shortText = raw.match(/\b(?:saying|text)\s+(.+)$/i);
        message = String(shortText?.[1] || '').trim();
    }
    if (!message) {
        message = 'hi';
    }

    return { recipient, message };
}

function buildHeuristicAutomationPlan({
    utterance,
    platform,
    scriptLanguage,
    activeApp,
    context,
    recipientHint
}) {
    if (platform !== 'darwin' || scriptLanguage !== 'applescript') {
        return null;
    }

    const raw = String(utterance || '').trim();
    const normalized = normalizeDesktopText(raw);
    const sendPayload = extractSendMessagePayload(raw);
    if (!sendPayload) return null;

    const recipient = normalizeText(sendPayload.recipient || recipientHint || context.recipient || '', 120);
    const message = normalizeText(sendPayload.message || 'hi', 260) || 'hi';
    const recipientEscaped = escapeAppleScriptString(recipient);
    const messageEscaped = escapeAppleScriptString(message);

    const lines = [
        'tell application "Messages" to activate',
        'delay 0.25',
        'tell application "System Events"'
    ];
    if (recipient) {
        lines.push('    keystroke "f" using {command down}');
        lines.push('    delay 0.2');
        lines.push(`    keystroke "${recipientEscaped}"`);
        lines.push('    delay 0.35');
        lines.push('    key code 36');
        lines.push('    delay 0.25');
    }
    lines.push(`    keystroke "${messageEscaped}"`);
    lines.push('    key code 36');
    lines.push('end tell');

    return {
        version: '1.0',
        platform: 'darwin',
        intent: 'send_message',
        risk: 'medium',
        requires_confirmation: false,
        summary: recipient
            ? `Send message to ${recipient}`
            : 'Send message in current Messages chat',
        context_refs: {
            app: 'Messages',
            target: 'messages',
            recipient
        },
        steps: [
            { action: 'open_app', target: 'Messages', value: '', risk: 'low' },
            { action: 'focus', target: recipient || 'current conversation', value: recipient || '', risk: 'low' },
            { action: 'type_text', target: 'message input', value: message, risk: 'medium' }
        ],
        script: {
            language: 'applescript',
            content: lines.join('\n')
        },
        post_context: {
            app: 'Messages',
            target: 'messages',
            recipient
        }
    };
}

async function createDesktopAutomationPlan(payload = {}) {
    const settingsState = settings.getAll();
    const utterance = String(payload?.utterance || payload?.text || '').trim();
    if (!utterance) {
        return { success: false, reason: 'empty_utterance', error: 'Utterance is required' };
    }
    if (!isSetupComplete()) {
        return {
            success: false,
            reason: 'setup_incomplete',
            error: 'Run Relay setup to enable premium automation'
        };
    }

    if (settingsState.premiumAutomationEnabled === false) {
        return { success: false, reason: 'premium_disabled', error: 'Premium automation is disabled in settings' };
    }

    const platform = process.platform;
    const scriptLanguage = getExpectedScriptLanguage(platform);
    const expectedLanguage = scriptLanguage;
    const configuredModel = resolveModel(settingsState.automationModel) || CHAT_TEXT_MODEL;
    const modelCandidates = [...new Set([
        configuredModel,
        CHAT_TEXT_MODEL,
        'gpt-5.6-luna'
    ])];
    const ttlMs = Number(settingsState.automationContextTtlMs || 45000);
    const activeApp = await getActiveAppNameSafe();
    const primaryDisplay = screen.getPrimaryDisplay();
    const displayInfo = {
        width: Number(primaryDisplay?.size?.width || 0),
        height: Number(primaryDisplay?.size?.height || 0),
        scaleFactor: Number(primaryDisplay?.scaleFactor || 1)
    };
    const resolvedContext = normalizeAutomationContext({
        ...lastAutomationContext,
        ...(payload?.context || {})
    }, ttlMs);
    const recipientHint = await resolveRecipientForPlanning(utterance, payload?.context || {});
    const capabilities = await probeAutomationCapabilities();
    console.log(
        `[AutomationPlan] request utterance="${utterance}" platform=${platform} model=${configuredModel} ` +
        `context_app="${resolvedContext.app}" context_target="${resolvedContext.target}" context_recipient="${resolvedContext.recipient}"`
    );
    const openai = getOpenAIClient();
    const fallbackPlan = buildHeuristicAutomationPlan({
        utterance,
        platform,
        scriptLanguage,
        activeApp,
        context: resolvedContext,
        recipientHint
    });

    let completion;
    let usedModel = configuredModel;
    let plannerError = null;
    for (const candidateModel of modelCandidates) {
        try {
            completion = await Promise.race([
                openai.chat.completions.create({
                    model: candidateModel,
                    temperature: 0,
                    stream: false,
                    max_tokens: 900,
                    response_format: {
                        type: 'json_schema',
                        json_schema: {
                            name: 'automation_plan_v1',
                            strict: true,
                            schema: AUTOMATION_PLAN_V1_SCHEMA
                        }
                    },
                    messages: buildAutomationPlannerMessages({
                        utterance,
                        platform,
                        scriptLanguage,
                        activeApp,
                        displayInfo,
                        context: resolvedContext,
                        recipientHint,
                        capabilities
                    })
                }),
                sleep(12000).then(() => {
                    throw new Error(`planner_timeout:${candidateModel}`);
                })
            ]);
            usedModel = candidateModel;
            plannerError = null;
            break;
        } catch (error) {
            plannerError = error;
            console.warn(`[AutomationPlan] model=${candidateModel} error:`, error?.message || error);
        }
    }

    if (!completion) {
        if (fallbackPlan) {
            const requiresConfirmation = planRequiresConfirmation(fallbackPlan, settingsState);
            console.log('[AutomationPlan] fallback=heuristic reason=openai_error intent=send_message');
            return {
                success: true,
                model: `${configuredModel}:heuristic-fallback`,
                plan: {
                    ...fallbackPlan,
                    requires_confirmation: requiresConfirmation
                },
                safety: {
                    destructive: false,
                    requiresConfirmation,
                    advancedUnlocked: settingsState.automationAdvancedControlUnlocked === true
                },
                capabilities
            };
        }
        throw plannerError || new Error('OpenAI planning failed');
    }

    const parsed = extractMessageJson(completion.choices?.[0]?.message);
    const normalized = normalizeAutomationPlan(parsed);
    const validation = validateAutomationPlanV1(normalized, { expectedLanguage });
    if (!normalized || !validation.valid) {
        console.warn(`[AutomationPlan] invalid schema error=${validation.error || 'unknown'}`);
        if (fallbackPlan) {
            const requiresConfirmation = planRequiresConfirmation(fallbackPlan, settingsState);
            console.log('[AutomationPlan] fallback=heuristic reason=schema_invalid intent=send_message');
            return {
                success: true,
                model: `${usedModel}:heuristic-fallback`,
                plan: {
                    ...fallbackPlan,
                    requires_confirmation: requiresConfirmation
                },
                safety: {
                    destructive: false,
                    requiresConfirmation,
                    advancedUnlocked: settingsState.automationAdvancedControlUnlocked === true
                },
                capabilities
            };
        }
        return {
            success: false,
            reason: 'schema_invalid',
            error: validation.error || 'Automation plan schema validation failed'
        };
    }

    if (normalized.platform !== platform) {
        normalized.platform = platform;
    }
    if (recipientHint && !normalized.context_refs.recipient) {
        normalized.context_refs.recipient = recipientHint;
    }

    const destructive = isDestructiveAutomationIntent(normalized);
    const requiresConfirmation = planRequiresConfirmation(normalized, settingsState);
    console.log(
        `[AutomationPlan] success intent=${normalized.intent} risk=${normalized.risk} ` +
        `requires_confirmation=${requiresConfirmation} steps=${normalized.steps.length} script_language=${normalized.script.language}`
    );
    return {
        success: true,
        model: usedModel,
        plan: {
            ...normalized,
            requires_confirmation: requiresConfirmation
        },
        safety: {
            destructive,
            requiresConfirmation,
            advancedUnlocked: settingsState.automationAdvancedControlUnlocked === true
        },
        capabilities
    };
}

async function executeDesktopAutomationPlan(planPayload = {}) {
    const settingsState = settings.getAll();
    const ttlMs = Number(settingsState.automationContextTtlMs || 45000);
    const plan = normalizeAutomationPlan(planPayload);
    const expectedLanguage = getExpectedScriptLanguage(process.platform);
    const validation = validateAutomationPlanV1(plan, { expectedLanguage });
    if (!validation.valid) {
        console.warn(`[AutomationExec] invalid plan error=${validation.error || 'unknown'}`);
        return { success: false, reason: 'invalid_plan', error: validation.error };
    }

    const destructive = isDestructiveAutomationIntent(plan);
    const assistiveAllowed = isAssistiveAutomationPlan(plan);
    if (!assistiveAllowed && settingsState.automationAdvancedControlUnlocked !== true) {
        return {
            success: false,
            reason: 'allowlist_blocked',
            error: 'Action is outside assistive allowlist. Enable advanced control to run it.'
        };
    }
    if (destructive && settingsState.automationAdvancedControlUnlocked !== true) {
        return {
            success: false,
            reason: 'advanced_unlock_required',
            error: 'Destructive automation requires advanced control unlock'
        };
    }

    console.log(
        `[AutomationExec] start intent=${plan.intent} risk=${plan.risk} script_language=${plan.script.language} ` +
        `requires_confirmation=${plan.requires_confirmation === true} steps=${plan.steps.length}`
    );
    const execution = await runAutomationScript(plan.script.language, plan.script.content);
    const success = execution?.success === true;
    const now = Date.now();
    if (success) {
        const postCtx = plan.post_context || {};
        updateAutomationContext({
            app: postCtx.app || plan.context_refs?.app || '',
            target: postCtx.target || plan.context_refs?.target || '',
            recipient: postCtx.recipient || plan.context_refs?.recipient || '',
            intent: plan.intent
        });
    } else {
        // Vision fallback retry for target misses when enabled
        const shouldTryVisionFallback = settingsState.automationVisionFallback !== false &&
            (execution?.reason === 'script_error' || execution?.reason === 'permission_required');
        if (shouldTryVisionFallback && plan.context_refs?.target) {
            try {
                const activeApp = await getActiveAppNameSafe();
                const hint = await resolveVisionFallbackTarget(plan.context_refs.target, activeApp);
                if (hint?.app) {
                    await resolveDesktopTarget(hint.app, { allowOpen: true });
                } else if (hint?.url) {
                    await shell.openExternal(hint.url);
                }
            } catch (error) {
                console.warn('[Automation] Vision fallback retry failed:', error?.message || error);
            }
        }
    }

    return {
        success,
        reason: success ? null : (execution?.reason || 'execution_failed'),
        error: success ? null : execution?.error,
        stdout: execution?.stdout || '',
        stderr: execution?.stderr || '',
        risk: plan.risk,
        intent: plan.intent,
        confirmed: plan.requires_confirmation !== true,
        context: normalizeAutomationContext(lastAutomationContext, ttlMs),
        timestamp: now
    };
}

function startContextPolling() {
    const pollRate = settings.get('meetingAutoDetect') ? 2000 : 2000;
    contextInterval = setInterval(async () => {
        try {
            const windowInfo = await activeWindow();
            if (windowInfo && windowInfo.owner) {
                const appName = windowInfo.owner.name;
                if (appName !== lastContextApp) {
                    lastContextApp = appName;
                    if (overlayWindow) {
                        overlayWindow.webContents.send('context-update', appName);
                    }
                }
            }
        } catch (error) {
            // Silent error as it might fail for some system windows
        }
    }, pollRate);
}

let overlayWindow;
let settingsWindow;
let setupWindow;
let transcriptWindow;
let tray;
const OVERLAY_BOTTOM_INSET = 10;
let overlayPreExpandBounds = null;

function getPrimaryWorkAreaBounds() {
    const display = screen.getPrimaryDisplay();
    const workArea = display?.workArea;
    if (workArea && Number.isFinite(workArea.width) && Number.isFinite(workArea.height)) {
        return {
            x: Number(workArea.x || 0),
            y: Number(workArea.y || 0),
            width: Number(workArea.width || 0),
            height: Number(workArea.height || 0)
        };
    }
    const size = display?.workAreaSize || display?.size || { width: 1280, height: 720 };
    return {
        x: 0,
        y: 0,
        width: Number(size.width || 1280),
        height: Number(size.height || 720)
    };
}

function getPrimaryDisplayBounds() {
    const display = screen.getPrimaryDisplay();
    const bounds = display?.bounds;
    if (bounds && Number.isFinite(bounds.width) && Number.isFinite(bounds.height)) {
        return {
            x: Number(bounds.x || 0),
            y: Number(bounds.y || 0),
            width: Number(bounds.width || 0),
            height: Number(bounds.height || 0)
        };
    }
    const size = display?.size || display?.workAreaSize || { width: 1280, height: 720 };
    return {
        x: 0,
        y: 0,
        width: Number(size.width || 1280),
        height: Number(size.height || 720)
    };
}

function clampOverlayHeightToWorkArea(requestedHeight, workArea = getPrimaryWorkAreaBounds()) {
    const areaHeight = Math.max(200, Number(workArea?.height || 200));
    const minHeight = Math.min(180, areaHeight);
    const target = Math.floor(Number(requestedHeight) || minHeight);
    return Math.max(minHeight, Math.min(target, areaHeight));
}

function getOverlayBoundsForHeight(requestedHeight) {
    const workArea = getPrimaryWorkAreaBounds();
    return {
        x: workArea.x,
        y: workArea.y,
        width: workArea.width,
        height: workArea.height
    };
}

function getAdaptiveOverlayHeight(mode = 'blind', workArea = getPrimaryWorkAreaBounds()) {
    const areaHeight = Math.max(240, Number(workArea?.height || 240));
    if (String(mode || '').toLowerCase() === 'blind') {
        const blindTarget = Math.round(areaHeight * 0.28);
        return Math.max(180, Math.min(blindTarget, 360, areaHeight));
    }
    const deafTarget = Math.round(areaHeight * 0.74);
    const deafMax = Math.max(520, areaHeight - 24);
    return Math.max(460, Math.min(deafTarget, deafMax, areaHeight));
}

function applyOverlayHeight(requestedHeight) {
    if (!overlayWindow || overlayWindow.isDestroyed()) return false;
    overlayWindow.setBounds(getOverlayBoundsForHeight(requestedHeight));
    return true;
}

function syncOverlayBoundsToWorkArea() {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    const currentBounds = overlayWindow.getBounds();
    applyOverlayHeight(currentBounds?.height || getAdaptiveOverlayHeight('blind'));
}

function createSetupWindow() {
    setupWindow = new BrowserWindow({
        width: 800,
        height: 700,
        title: "Relay Setup",
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
        },
        titleBarStyle: 'hiddenInset',
    });

    setupWindow.loadFile(path.join(__dirname, '../renderer/setup.html'));

    setupWindow.on('closed', () => {
        setupWindow = null;
    });
}


function createSettingsWindow() {
    if (settingsWindow) {
        settingsWindow.show();
        return;
    }

    settingsWindow = new BrowserWindow({
        width: 800,
        height: 600,
        title: "Relay Settings",
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
        },
        titleBarStyle: 'hiddenInset',
    });

    settingsWindow.loadFile(path.join(__dirname, '../renderer/settings.html'));

    settingsWindow.on('closed', () => {
        settingsWindow = null;
    });
}

function createTray() {
    if (tray && !tray.isDestroyed?.()) {
        return tray;
    }
    const iconPath = path.join(__dirname, '../assets/icons/icon.png');
    tray = new Tray(iconPath);

    const contextMenu = Menu.buildFromTemplate([
        { label: 'Relay: Active', enabled: false },
        { type: 'separator' },
        { label: 'Settings...', click: createSettingsWindow },
        { label: 'Transcript History...', click: createTranscriptWindow },
        { label: 'Show/Hide Overlay', click: toggleOverlay },
        { label: 'Run Setup Wizard...', click: runSetupWizard },
        { type: 'separator' },
        { label: 'Quit', click: () => app.quit() }
    ]);

    tray.setToolTip('Relay Accessibility');
    tray.setContextMenu(contextMenu);
    return tray;
}

function toggleOverlay() {
    if (overlayWindow) {
        if (overlayWindow.isVisible()) {
            overlayWindow.hide();
        } else {
            overlayWindow.show();
        }
    }
}

function runSetupWizard() {
    if (fs.existsSync(setupFlagPath)) {
        fs.unlinkSync(setupFlagPath);
    }
    if (setupWindow) {
        setupWindow.close();
    }
    if (overlayWindow) {
        overlayWindow.hide();
    }
    createSetupWindow();
    registerShortcuts(null, createSettingsWindow);
}


function createOverlayWindow() {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
        return overlayWindow;
    }
    const workArea = getPrimaryWorkAreaBounds();
    const defaultHeight = getAdaptiveOverlayHeight('deaf', workArea);
    const initialBounds = getOverlayBoundsForHeight(defaultHeight);

    overlayWindow = new BrowserWindow({
        width: initialBounds.width,
        height: initialBounds.height,
        x: initialBounds.x,
        y: initialBounds.y,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        hasShadow: false,
        resizable: false,
        movable: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
        },
    });

    overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    // Keep overlay interactive on startup so toolbar drag works immediately.
    // Renderer manages click-through transitions once loaded.
    overlayWindow.setIgnoreMouseEvents(false);

    overlayWindow.loadFile(path.join(__dirname, '../renderer/overlay.html'));
    return overlayWindow;
}

function ensurePrimaryRuntimeWindows() {
    createOverlayWindow();
    createTray();
    registerShortcuts(overlayWindow, createSettingsWindow);
    if (soundClassifier?.isReady && overlayWindow && !overlayWindow.isDestroyed()) {
        const pushReady = () => {
            if (overlayWindow && !overlayWindow.isDestroyed()) {
                overlayWindow.webContents.send('classifier-ready', soundClassifier.modelName);
            }
        };
        if (overlayWindow.webContents.isLoading()) {
            overlayWindow.webContents.once('did-finish-load', pushReady);
        } else {
            pushReady();
        }
    }
}

function setOverlayHeight(requestedHeight) {
    return applyOverlayHeight(requestedHeight);
}

function createTranscriptWindow() {
    if (transcriptWindow) {
        transcriptWindow.show();
        return;
    }

    transcriptWindow = new BrowserWindow({
        width: 900,
        height: 700,
        title: "Relay Transcript History",
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
        },
        titleBarStyle: 'hiddenInset',
    });

    transcriptWindow.loadFile(path.join(__dirname, '../renderer/transcript-viewer.html'));

    transcriptWindow.on('closed', () => {
        transcriptWindow = null;
    });
}

// LAN bridge to the Relay mobile app (pairing, alerts, captions, Remote Mic).
let mobileBridge = null;

function broadcastToWindows(channel, payload) {
    for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(channel, payload);
    }
}

ipcMain.handle('broadcast-alert', async (_event, payload = {}) => {
    if (!mobileBridge) return;
    mobileBridge.broadcast({
        type: 'ALERT',
        message: String(payload.message || 'Sound detected').slice(0, 200),
        severity: payload.severity === 'high' ? 'high' : 'normal'
    });
});

ipcMain.handle('mobile-pairing-info', async () => {
    if (!mobileBridge) return { running: false, error: 'Phone bridge is starting' };
    return mobileBridge.getPairingInfo();
});

ipcMain.handle('mobile-pairing-regenerate', async () => {
    if (!mobileBridge) return { running: false, error: 'Phone bridge is starting' };
    return mobileBridge.regenerateToken();
});

app.whenReady().then(() => {
    mobileBridge = new MobileBridge({
        hooks: {
            onAudioStart: handleRemoteMicStart,
            onAudioFrame: handleRemoteMicFrame,
            onAudioStop: handleRemoteMicStop
        }
    });
    mobileBridge.on('status', (status) => broadcastToWindows('mobile-bridge-status', status));
    mobileBridge.start().catch((error) => {
        console.error('[MobileBridge] Failed to start:', error?.message || error);
    });

    // Grant microphone permission automatically for this app
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
        if (permission === 'media') {
            return callback(true);
        }
        callback(false);
    });

    // Check if setup was already completed
    if (isSetupComplete()) {
        ensurePrimaryRuntimeWindows();
    } else {
        createSetupWindow();
    }

    // Register settings shortcut even before setup completes.
    if (!isSetupComplete()) {
        registerShortcuts(null, createSettingsWindow);
    }

    // Start ML sound classifier in background
    soundClassifier = new SoundClassifier(app.getPath('userData'));
    soundClassifier.init().then(() => {
        if (soundClassifier.isReady && overlayWindow && !overlayWindow.isDestroyed()) {
            overlayWindow.webContents.send('classifier-ready', soundClassifier.modelName);
        }
    });

    // Ensure app shows in Dock on macOS
    if (process.platform === 'darwin' && app.dock) {
        app.setName("Relay");
        try {
            const iconPath = path.join(__dirname, '../assets/icons/icon.png');
            app.dock.setIcon(iconPath);
        } catch (e) {
            console.error("Failed to set dock icon", e);
        }
        app.dock.show();
    }

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            if (isSetupComplete()) {
                ensurePrimaryRuntimeWindows();
            } else {
                createSetupWindow();
            }
        } else if (overlayWindow) {
            overlayWindow.show();
        }
    });

    screen.on('display-metrics-changed', () => {
        syncOverlayBoundsToWorkArea();
    });
    screen.on('display-added', () => {
        syncOverlayBoundsToWorkArea();
    });
    screen.on('display-removed', () => {
        syncOverlayBoundsToWorkArea();
    });

    startContextPolling();

    // Premium automation preflight check on launch.
    probeAutomationCapabilities()
        .then((status) => {
            if (!status.degraded) {
                console.log(`[Automation] Preflight ready platform=${status.platform} runner=${status.expectedLanguage}`);
                return;
            }
            console.warn(`[Automation] Preflight degraded missing=${status.missing.join(',')}`);
            if (overlayWindow && !overlayWindow.isDestroyed()) {
                overlayWindow.webContents.send('automation-preflight', status);
            }
        })
        .catch((error) => {
            console.warn('[Automation] Preflight check failed:', error?.message || error);
        });
});

app.on('will-quit', () => {
    unregisterAll();
    mobileBridge?.stop();
});

// ============================================
// IPC HANDLERS - Original
// ============================================

ipcMain.handle('open-settings', () => {
    createSettingsWindow();
});

ipcMain.on('set-ignore-mouse-events', (event, ignore, options) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
        win.setIgnoreMouseEvents(ignore, options);
    }
});

ipcMain.on('console-log', (event, message) => {
    console.log('[Renderer]', message);
});

ipcMain.on('quit-app', () => {
    app.quit();
});

ipcMain.on('minimize-app', () => {
    if (overlayWindow) {
        overlayWindow.hide();
    }
});

// Navigator panel expansion
ipcMain.on('expand-overlay', () => {
    if (overlayWindow) {
        if (!overlayPreExpandBounds) {
            overlayPreExpandBounds = overlayWindow.getBounds();
        }
        const workArea = getPrimaryWorkAreaBounds();
        overlayWindow.setBounds({
            x: workArea.x,
            y: workArea.y,
            width: workArea.width,
            height: workArea.height
        });
        overlayWindow.setAlwaysOnTop(true, 'floating');
        overlayWindow.setIgnoreMouseEvents(false);
    }
});

ipcMain.on('collapse-overlay', () => {
    if (overlayWindow) {
        if (overlayPreExpandBounds) {
            const workArea = getPrimaryWorkAreaBounds();
            const previous = overlayPreExpandBounds;
            overlayPreExpandBounds = null;
            const height = clampOverlayHeightToWorkArea(previous.height, workArea);
            const width = Math.max(480, Math.min(Number(previous.width || workArea.width), workArea.width));
            const minX = workArea.x;
            const maxX = workArea.x + workArea.width - width;
            const minY = workArea.y;
            const maxY = workArea.y + workArea.height - height;
            const x = Math.max(minX, Math.min(Number(previous.x || minX), maxX));
            const y = Math.max(minY, Math.min(Number(previous.y || minY), maxY));
            overlayWindow.setBounds({ x, y, width, height });
        } else {
            const targetHeight = getAdaptiveOverlayHeight('blind');
            applyOverlayHeight(targetHeight);
        }
        overlayWindow.setAlwaysOnTop(true, 'floating');
        overlayWindow.setIgnoreMouseEvents(false);
    }
});

ipcMain.handle('set-overlay-height', (event, overlayHeight) => {
    const success = setOverlayHeight(overlayHeight);
    return { success };
});

// === AI GUIDE: Dynamic instruction generation ===
ipcMain.handle('ai-generate-guide', async (event, userQuery) => {
    try {
        const openai = getOpenAIClient();
        const runtimeOs = process.platform === 'win32'
            ? 'Windows'
            : (process.platform === 'darwin' ? 'macOS' : 'Linux');
        const osSpecificRules = runtimeOs === 'Windows'
            ? `User is on Windows.
- Use Windows-specific instructions only (Start menu, taskbar, Settings, File Explorer).
- Use Windows shortcuts only (e.g., Win, Alt+Tab, Win+S), never Command-key shortcuts.
- expectedApp examples: "File Explorer", "Settings", "Google Chrome", "Microsoft Edge", "Taskbar", "Start menu".`
            : runtimeOs === 'macOS'
                ? `User is on macOS.
- Use macOS-specific instructions only (Dock, menu bar, Finder, System Settings, Spotlight).
- Use macOS shortcuts only (e.g., Command+Space), never Windows-key shortcuts.
- expectedApp examples: "Finder", "System Settings", "Safari", "Google Chrome", "Spotlight".`
                : `User is on Linux.
- Use Linux desktop terminology and avoid macOS/Windows-specific UI terms unless explicitly asked.
- expectedApp examples: "Files", "Settings", "Terminal", "Firefox".`;

        const completion = await openai.chat.completions.create({
            model: FAST_TEXT_MODEL,
            temperature: 0.1,
            stream: false,
            max_tokens: 320,
            messages: [
                {
                    role: 'system',
                    content: `You are an accessibility assistant helping users navigate their computer. Generate CLEAR step-by-step instructions.

RULES:
- Each step = ONE action (click, type, or press keys)
- Short sentences, simple words
- Be SPECIFIC: exactly what to click and where
- expectedApp = the app name that will be ACTIVE after this step completes
  Examples: "Safari", "Finder", "Google Chrome", "System Settings", "Mail", "Notes", "Spotlight"
  Use "any" only for keyboard-only steps that don't change apps
- visualHint = where to look on screen (helps user find the right spot)

RESPOND ONLY with valid JSON:
{
  "title": "Task title (3-5 words)",
  "steps": [
    {
      "instruction": "Action in 5-8 words",
      "detail": "What this does / what to look for",
      "icon": "emoji for this action",
      "expectedApp": "EXACT app name that opens (e.g. Safari, Finder, System Settings)",
      "visualHint": "dock | menubar | spotlight | center | top-left | top-right | bottom-left | bottom-right | none"
    }
  ]
}

IMPORTANT for expectedApp:
- "Open Safari" step → expectedApp: "Safari"
- "Open Finder" step → expectedApp: "Finder"
- "Open System Settings" step → expectedApp: "System Settings"
- "Press shortcut to search" step → expectedApp: "Spotlight" (macOS) or "Start menu" (Windows)
- "Click Chrome icon" step → expectedApp: "Google Chrome"
- Keyboard shortcut that doesn't open app → expectedApp: "any"

Keep it to 3-6 steps.

OS CONTEXT:
${osSpecificRules}`
                },
                {
                    role: 'user',
                    content: userQuery
                }
            ]
        });

        const content = completion.choices[0].message.content;
        const jsonStr = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const guide = JSON.parse(jsonStr);
        return { success: true, guide };
    } catch (error) {
        console.error('[AI Guide] Error generating guide:', error.message);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('get-active-window', async () => {
    try {
        const windowInfo = await activeWindow();
        if (windowInfo && windowInfo.owner) {
            return {
                success: true,
                app: windowInfo.owner.name,
                title: windowInfo.title,
                bounds: windowInfo.bounds
            };
        }
        return { success: false };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('desktop-navigate-target', async (_event, targetPhrase) => {
    try {
        const target = String(targetPhrase || '').trim();
        console.log(`[DesktopNavigate] request target="${target}"`);
        const resolved = await resolveDesktopTarget(target, { allowOpen: true });
        if (resolved.success || settings.get('automationVisionFallback') === false) {
            console.log(`[DesktopNavigate] result success=${resolved.success} reason=${resolved.reason || 'none'} app="${resolved.app || ''}"`);
            if (resolved.success) {
                updateLastDesktopTarget({
                    app: resolved.app || '',
                    target: target || resolved.app || '',
                    source: resolved.source || 'running_app'
                });
            }
            return resolved;
        }

        try {
            console.log(`[DesktopNavigate] trying vision fallback target="${target}"`);
            const hint = await resolveVisionFallbackTarget(target, await getActiveAppNameSafe());
            if (hint?.app) {
                const retried = await resolveDesktopTarget(hint.app, { allowOpen: true });
                if (retried.success) {
                    console.log(`[DesktopNavigate] vision app retry success app="${retried.app || hint.app}"`);
                    updateLastDesktopTarget({
                        app: retried.app || hint.app,
                        target: target || hint.app,
                        source: 'vision_app_retry'
                    });
                    return { ...retried, retried: true, retrySource: 'vision', retryHint: hint.reason || '' };
                }
            } else if (hint?.url) {
                await shell.openExternal(hint.url);
                console.log(`[DesktopNavigate] vision url retry success url="${hint.url}"`);
                updateLastDesktopTarget({
                    app: hint.url,
                    target: target || hint.url,
                    source: 'vision_url'
                });
                return {
                    success: true,
                    source: 'vision_url',
                    app: hint.url,
                    retried: true,
                    retrySource: 'vision'
                };
            }
        } catch (visionError) {
            console.warn('[DesktopNavigate] vision fallback failed:', visionError?.message || visionError);
        }
        console.log(`[DesktopNavigate] final miss target="${target}"`);
        return resolved;
    } catch (error) {
        return {
            success: false,
            reason: isDesktopPermissionError(error?.message) ? 'permission_required' : 'desktop_error',
            permissionRequired: isDesktopPermissionError(error?.message),
            error: error?.message || 'Failed desktop navigation'
        };
    }
});

ipcMain.handle('desktop-click-target', async (_event, targetPhrase) => {
    try {
        const target = sanitizeDesktopTargetPhrase(targetPhrase);
        console.log(`[DesktopClick] request target="${target}"`);

        let resolved = await performDesktopClickTarget(target, { allowOpen: true });
        if (resolved.success) {
            console.log(`[DesktopClick] result success=true app="${resolved.app || ''}" source=${resolved.source || 'none'} fallback=${resolved.clickFallback || 'none'}`);
            updateLastDesktopTarget({
                app: resolved.app || '',
                target,
                source: resolved.source || resolved.clickFallback || 'desktop_click'
            });
            return resolved;
        }
        if (resolved?.permissionRequired) {
            return resolved;
        }

        const recentTarget = getRecentDesktopTarget();
        const canRetryWithRecent = recentTarget &&
            normalizeDesktopText(recentTarget.target) !== normalizeDesktopText(target);
        if (canRetryWithRecent) {
            console.log(`[DesktopClick] retrying recent target="${recentTarget.target}"`);
            const retriedRecent = await performDesktopClickTarget(recentTarget.target, { allowOpen: false });
            if (retriedRecent.success) {
                updateLastDesktopTarget({
                    app: retriedRecent.app || recentTarget.app || '',
                    target: recentTarget.target,
                    source: 'recent_target'
                });
                return {
                    ...retriedRecent,
                    retried: true,
                    retrySource: 'recent_target',
                    retryHint: `Used recent target "${recentTarget.target}"`
                };
            }
            if (retriedRecent?.permissionRequired) {
                return retriedRecent;
            }
        }

        if (settings.get('automationVisionFallback') !== false) {
            try {
                console.log(`[DesktopClick] trying vision script target="${target}"`);
                const clickScriptPlan = await resolveVisionClickScript(target, await getActiveAppNameSafe());
                if (clickScriptPlan?.script) {
                    const executed = await runAutomationScript('applescript', clickScriptPlan.script);
                    if (executed?.success) {
                        updateLastDesktopTarget({
                            app: await getActiveAppNameSafe(),
                            target,
                            source: 'vision_script'
                        });
                        console.log(`[DesktopClick] vision script success reason="${clickScriptPlan.reason || 'none'}"`);
                        return {
                            success: true,
                            source: 'vision_script',
                            app: await getActiveAppNameSafe(),
                            clickFallback: 'vision_script',
                            retried: true,
                            retrySource: 'vision',
                            retryHint: clickScriptPlan.reason || ''
                        };
                    }
                    console.warn('[DesktopClick] vision script execution failed:', executed?.error || executed?.reason || 'unknown');
                }

                console.log(`[DesktopClick] trying vision fallback target="${target}"`);
                const hint = await resolveVisionFallbackTarget(target, await getActiveAppNameSafe());
                if (hint?.app) {
                    const retried = await performDesktopClickTarget(hint.app, { allowOpen: true });
                    if (retried.success) {
                        console.log(`[DesktopClick] vision retry success app="${retried.app || hint.app}"`);
                        updateLastDesktopTarget({
                            app: retried.app || hint.app,
                            target,
                            source: 'vision_app_retry'
                        });
                        return {
                            ...retried,
                            retried: true,
                            retrySource: 'vision',
                            retryHint: hint.reason || ''
                        };
                    }
                } else if (hint?.url) {
                    await shell.openExternal(hint.url);
                    console.log(`[DesktopClick] vision url retry success url="${hint.url}"`);
                    updateLastDesktopTarget({
                        app: hint.url,
                        target: target || hint.url,
                        source: 'vision_url'
                    });
                    return {
                        success: true,
                        source: 'vision_url',
                        app: hint.url,
                        clickFallback: 'open_url',
                        retried: true,
                        retrySource: 'vision'
                    };
                }
            } catch (visionError) {
                console.warn('[DesktopClick] vision fallback failed:', visionError?.message || visionError);
            }
        }

        console.log(`[DesktopClick] final miss target="${target}"`);
        return resolved;
    } catch (error) {
        return {
            success: false,
            reason: isDesktopPermissionError(error?.message) ? 'permission_required' : 'desktop_error',
            permissionRequired: isDesktopPermissionError(error?.message),
            error: error?.message || 'Failed desktop click'
        };
    }
});

ipcMain.handle('desktop-type-text', async (_event, payload = {}) => {
    try {
        const isObject = payload && typeof payload === 'object' && !Array.isArray(payload);
        const text = isObject ? payload.text : payload;
        const pressEnter = isObject ? payload.pressEnter === true : false;
        const targetApp = isObject ? String(payload.targetApp || '').trim() : '';
        console.log(
            `[DesktopType] request text_len=${String(text || '').length} pressEnter=${pressEnter} target_app="${targetApp}"`
        );
        const result = await runDesktopTypeText(text, { pressEnter, targetApp });
        console.log(
            `[DesktopType] result success=${result?.success === true} reason=${result?.reason || 'none'}`
        );
        if (result?.success) {
            updateLastDesktopTarget({
                app: result?.app || '',
                target: 'focused_input',
                source: 'desktop_type'
            });
        }
        return result;
    } catch (error) {
        return {
            success: false,
            reason: isDesktopPermissionError(error?.message) ? 'permission_required' : 'desktop_error',
            permissionRequired: isDesktopPermissionError(error?.message),
            error: error?.message || 'Failed desktop typing'
        };
    }
});

ipcMain.handle('desktop-press-key', async (_event, payload = {}) => {
    try {
        const isObject = payload && typeof payload === 'object' && !Array.isArray(payload);
        const phrase = isObject ? String(payload.phrase || '').trim() : String(payload || '').trim();
        const targetApp = isObject ? String(payload.targetApp || '').trim() : '';
        console.log(`[DesktopPress] request phrase="${phrase}" target_app="${targetApp}"`);
        const result = await runDesktopPressKey(phrase, { targetApp });
        console.log(
            `[DesktopPress] result success=${result?.success === true} reason=${result?.reason || 'none'} key="${result?.key || ''}"`
        );
        if (result?.success) {
            updateLastDesktopTarget({
                app: result?.app || targetApp || '',
                target: phrase,
                source: 'desktop_press'
            });
        }
        return result;
    } catch (error) {
        return {
            success: false,
            reason: isDesktopPermissionError(error?.message) ? 'permission_required' : 'desktop_error',
            permissionRequired: isDesktopPermissionError(error?.message),
            error: error?.message || 'Failed desktop key press'
        };
    }
});

ipcMain.handle('desktop-automation-status', async () => {
    try {
        const capabilities = await probeAutomationCapabilities();
        const settingsState = settings.getAll();
        return {
            success: true,
            ...capabilities,
            premiumEnabled: settingsState.premiumAutomationEnabled !== false,
            ttlMs: Number(settingsState.automationContextTtlMs || 45000),
            model: resolveModel(settingsState.automationModel) || CHAT_TEXT_MODEL,
            context: normalizeAutomationContext(lastAutomationContext, Number(settingsState.automationContextTtlMs || 45000)),
            recents: recentRecipients.slice(0, 8)
        };
    } catch (error) {
        return { success: false, error: error?.message || 'Failed to read automation status' };
    }
});

ipcMain.handle('desktop-automation-plan', async (_event, payload = {}) => {
    try {
        return await createDesktopAutomationPlan(payload);
    } catch (error) {
        console.warn('[AutomationPlan] fatal:', error?.message || error);
        return {
            success: false,
            reason: 'planning_failed',
            error: error?.message || 'Automation planning failed'
        };
    }
});

ipcMain.handle('desktop-automation-execute', async (_event, planPayload = {}) => {
    try {
        return await executeDesktopAutomationPlan(planPayload);
    } catch (error) {
        return {
            success: false,
            reason: 'execution_failed',
            error: error?.message || 'Automation execution failed'
        };
    }
});

ipcMain.handle('get-sources', async () => {
    try {
        const sources = await desktopCapturer.getSources({ types: ['window', 'screen'], fetchWindowIcons: true });
        return sources;
    } catch (error) {
        console.error('[Main] Failed to get sources:', error?.message || error);
        return [];
    }
});

// Setup wizard test handlers
ipcMain.handle('test-accessibility', async () => {
    try {
        const windowInfo = await activeWindow();
        if (windowInfo && windowInfo.owner) {
            return { success: true, app: windowInfo.owner.name };
        }
        return { success: false, error: "Could not get active window" };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('test-deepgram', async () => {
    try {
        const deepgram = await getDeepgramClient();
        const connection = deepgram.listen.live({
            model: 'nova-3',
            language: 'en-US',
            encoding: 'linear16',
            sample_rate: 16000,
        });

        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                try { connection.finish(); } catch (e) {}
                resolve({ success: false, error: "Connection timeout" });
            }, 5000);

            connection.on(LiveTranscriptionEvents.Open, () => {
                clearTimeout(timeout);
                connection.finish();
                resolve({ success: true });
            });

            connection.on(LiveTranscriptionEvents.Error, (error) => {
                clearTimeout(timeout);
                resolve({ success: false, error: error.message || "Connection error" });
            });
        });
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('test-tts', async () => {
    try {
        await getOpenAIClient().models.retrieve(SPEECH_MODEL);
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.on('open-system-settings', (event, type) => {
    if (process.platform === 'darwin') {
        const settingsUrls = {
            'screen-recording': 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
            'accessibility': 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
            'microphone': 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
            'camera': 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
            'bluetooth': 'x-apple.systempreferences:com.apple.preferences.Bluetooth',
            'sound': 'x-apple.systempreferences:com.apple.preference.sound',
            'notifications': 'x-apple.systempreferences:com.apple.preference.notifications',
            'default': 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
        };
        const url = settingsUrls[type] || settingsUrls.default;
        shell.openExternal(url);
        return;
    }

    if (process.platform === 'win32') {
        const windowsTargets = {
            'accessibility': 'ms-settings:easeofaccess-display',
            'microphone': 'ms-settings:privacy-microphone',
            'camera': 'ms-settings:privacy-webcam',
            'screen-recording': 'ms-settings:privacy-broadfilesystemaccess',
            'default': 'ms-settings:privacy'
        };
        const target = windowsTargets[type] || windowsTargets.default;
        shell.openExternal(target);
        return;
    }

    // Linux fallback opens generic settings app if available.
    const linuxCommands = [
        ['gnome-control-center'],
        ['kde5-systemsettings'],
        ['systemsettings']
    ];
    for (const [cmd] of linuxCommands) {
        try {
            const child = spawn(cmd, [], { stdio: 'ignore', detached: true });
            child.unref();
            return;
        } catch {
            // try next option
        }
    }
});

ipcMain.on('close-setup', () => {
    markSetupComplete();
    if (setupWindow) {
        setupWindow.close();
    }
    ensurePrimaryRuntimeWindows();
    if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.show();
    }
});

// ============================================
// DEEPGRAM REAL-TIME STREAMING
// ============================================

const DEFAULT_CAPTION_SAMPLE_RATE = 16000;
const DEEPGRAM_RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000, 30000];
const DEEPGRAM_KEEPALIVE_MS = 5000;
const CAPTION_INTERIM_BROADCAST_MS = 150;

let deepgramConnection = null;
let isDeepgramConnected = false;
let deepgramSampleRate = DEFAULT_CAPTION_SAMPLE_RATE;
let deepgramStartPromise = null;
let deepgramReconnectTimer = null;
let deepgramReconnectAttempt = 0;
let deepgramKeepAliveTimer = null;
let lastDeepgramAudioAt = 0;
let rendererCaptionsActive = false;
let remoteMicActive = false;
let remoteMicDevice = null;
let captionAudioSource = 'local';
let lastInterimBroadcastAt = 0;

function sendToOverlay(channel, payload) {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send(channel, payload);
    }
}

function isDeepgramWanted() {
    return rendererCaptionsActive || remoteMicActive;
}

// Classroom Broadcast: one request per final caption translates it into every
// language the connected phones asked for, so the proxy rate limit is not
// multiplied by the number of students.
async function translateCaptionForMobiles(text, languages) {
    const completion = await getOpenAIClient().chat.completions.create({
        model: CHAT_TEXT_MODEL,
        temperature: 0,
        max_tokens: 200 + 120 * languages.length,
        messages: [
            {
                role: 'system',
                content: 'Translate live classroom captions. Reply with a JSON object only, mapping each requested language name to the translation. ' +
                    'Keep it natural and short; captions may contain recognition errors.'
            },
            { role: 'user', content: JSON.stringify({ languages, text }) }
        ]
    });
    const raw = String(completion.choices?.[0]?.message?.content || '');
    const match = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : raw);
    const translations = {};
    for (const language of languages) {
        if (typeof parsed?.[language] === 'string' && parsed[language].trim()) translations[language] = parsed[language].trim();
    }
    return translations;
}

let captionTranslationChain = Promise.resolve();

function broadcastCaptionToMobiles(result) {
    if (!mobileBridge || !mobileBridge.connectedCount) return;
    if (!result.isFinal) {
        const now = Date.now();
        if (now - lastInterimBroadcastAt < CAPTION_INTERIM_BROADCAST_MS) return;
        lastInterimBroadcastAt = now;
    }
    const speakerValue = result.words.find((word) => Number.isInteger(word.speaker))?.speaker;
    const speaker = Number.isInteger(speakerValue) ? speakerValue : null;
    const message = { type: 'CAPTION', text: result.transcript, isFinal: result.isFinal, speaker };
    const languages = mobileBridge.captionLanguages;

    // Phones that want the spoken language get every caption right away.
    mobileBridge.broadcast(message, (ws) => !ws.captionLanguage);
    // Phones that want a translation get final captions only, in order.
    if (!result.isFinal || !languages.length) return;
    const text = result.transcript;
    captionTranslationChain = captionTranslationChain
        .then(() => translateCaptionForMobiles(text, languages))
        .catch((error) => {
            console.warn('[Classroom Broadcast] translation failed:', error.message);
            return {};
        })
        .then((translations) => {
            for (const language of languages) {
                mobileBridge?.broadcast(
                    { ...message, text: translations[language] || text, original: text, language },
                    (ws) => ws.captionLanguage === language
                );
            }
        });
}

function startDeepgramKeepAlive() {
    stopDeepgramKeepAlive();
    deepgramKeepAliveTimer = setInterval(() => {
        if (!deepgramConnection || !isDeepgramConnected) return;
        if (Date.now() - lastDeepgramAudioAt < DEEPGRAM_KEEPALIVE_MS) return;
        try {
            deepgramConnection.keepAlive();
        } catch (error) {
            console.warn('[Deepgram] keepAlive failed:', error?.message || error);
        }
    }, DEEPGRAM_KEEPALIVE_MS);
}

function stopDeepgramKeepAlive() {
    if (deepgramKeepAliveTimer) {
        clearInterval(deepgramKeepAliveTimer);
        deepgramKeepAliveTimer = null;
    }
}

function scheduleDeepgramReconnect() {
    if (!isDeepgramWanted() || deepgramReconnectTimer) return;
    const delay = DEEPGRAM_RECONNECT_DELAYS_MS[Math.min(deepgramReconnectAttempt, DEEPGRAM_RECONNECT_DELAYS_MS.length - 1)];
    deepgramReconnectAttempt += 1;
    console.log(`[Deepgram] Reconnecting in ${delay}ms`);
    deepgramReconnectTimer = setTimeout(() => {
        deepgramReconnectTimer = null;
        if (isDeepgramWanted()) startDeepgramStream();
    }, delay);
}

function clearDeepgramReconnect() {
    if (deepgramReconnectTimer) {
        clearTimeout(deepgramReconnectTimer);
        deepgramReconnectTimer = null;
    }
}

// Detach before closing so the Close handler does not schedule a reconnect.
async function closeDeepgramConnection() {
    const connection = deepgramConnection;
    deepgramConnection = null;
    isDeepgramConnected = false;
    stopDeepgramKeepAlive();
    if (connection) {
        try {
            await connection.finish();
        } catch (e) {
            console.error('[Deepgram] Error closing connection:', e);
        }
    }
}

async function openDeepgramStream(sampleRate) {
    let deepgram;
    try {
        deepgram = await getDeepgramClient();
    } catch (error) {
        console.error('[Deepgram] Could not get client:', error?.message || error);
        isDeepgramConnected = false;
        sendToOverlay('deepgram-status', { connected: false, error: error?.message || 'Speech service unavailable' });
        scheduleDeepgramReconnect();
        return false;
    }

    return new Promise((resolve) => {
        let settled = false;
        const settle = (value) => {
            if (!settled) {
                settled = true;
                resolve(value);
            }
        };

        try {
            console.log(`[Deepgram] Starting Nova-3 streaming connection (${sampleRate} Hz, ${getAIMode().deepgram})...`);

            const connection = deepgram.listen.live({
                model: 'nova-3',
                language: settings.get('language') || 'en-US',
                smart_format: true,
                punctuate: true,
                diarize: true,
                interim_results: true,
                utterance_end_ms: 1000,
                filler_words: true,
                encoding: 'linear16',
                sample_rate: sampleRate,
                mip_opt_out: true,
            });
            deepgramConnection = connection;
            deepgramSampleRate = sampleRate;

            const connectionTimeout = setTimeout(() => {
                console.error('[Deepgram] Connection timeout');
                if (deepgramConnection === connection) {
                    deepgramConnection = null;
                    isDeepgramConnected = false;
                }
                try { connection.finish(); } catch (e) {}
                scheduleDeepgramReconnect();
                settle(false);
            }, 10000);

            connection.on(LiveTranscriptionEvents.Open, () => {
                clearTimeout(connectionTimeout);
                if (deepgramConnection !== connection) {
                    try { connection.finish(); } catch (e) {}
                    settle(false);
                    return;
                }
                console.log('[Deepgram] WebSocket connected');
                isDeepgramConnected = true;
                deepgramReconnectAttempt = 0;
                lastDeepgramAudioAt = Date.now();
                startDeepgramKeepAlive();
                sendToOverlay('deepgram-status', { connected: true });
                settle(true);
            });

            connection.on(LiveTranscriptionEvents.Transcript, (data) => {
                const alternative = data.channel?.alternatives?.[0];
                if (alternative && alternative.transcript) {
                    const result = {
                        transcript: alternative.transcript,
                        isFinal: data.is_final || false,
                        speechFinal: data.speech_final || false,
                        words: (alternative.words || []).map(w => ({
                            word: w.word,
                            start: w.start,
                            end: w.end,
                            speaker: w.speaker,
                            confidence: w.confidence,
                            punctuated_word: w.punctuated_word,
                        })),
                        confidence: alternative.confidence || 0,
                    };

                    if (result.transcript.trim()) {
                        sendToOverlay('deepgram-transcript', result);
                        broadcastCaptionToMobiles(result);
                    }
                }
            });

            connection.on(LiveTranscriptionEvents.UtteranceEnd, () => {
                sendToOverlay('deepgram-utterance-end');
            });

            connection.on(LiveTranscriptionEvents.Error, (error) => {
                clearTimeout(connectionTimeout);
                console.error('[Deepgram] Streaming error:', error?.message || error);
                if (deepgramConnection === connection) {
                    isDeepgramConnected = false;
                    sendToOverlay('deepgram-status', { connected: false, error: error?.message || 'Connection error' });
                }
                settle(false);
            });

            connection.on(LiveTranscriptionEvents.Close, () => {
                clearTimeout(connectionTimeout);
                console.log('[Deepgram] WebSocket closed');
                if (deepgramConnection === connection) {
                    deepgramConnection = null;
                    isDeepgramConnected = false;
                    stopDeepgramKeepAlive();
                    sendToOverlay('deepgram-status', { connected: false });
                    scheduleDeepgramReconnect();
                }
                settle(false);
            });
        } catch (error) {
            console.error('[Deepgram] Failed to start streaming:', error);
            isDeepgramConnected = false;
            scheduleDeepgramReconnect();
            settle(false);
        }
    });
}

async function startDeepgramStream(options = {}) {
    const sampleRate = options.sampleRate || deepgramSampleRate;
    if (deepgramStartPromise) {
        await deepgramStartPromise;
    }
    if (deepgramConnection && isDeepgramConnected) {
        if (sampleRate === deepgramSampleRate) return true;
        await closeDeepgramConnection();
    }
    clearDeepgramReconnect();
    deepgramStartPromise = openDeepgramStream(sampleRate).finally(() => {
        deepgramStartPromise = null;
    });
    return deepgramStartPromise;
}

async function stopDeepgramStream() {
    clearDeepgramReconnect();
    deepgramReconnectAttempt = 0;
    await closeDeepgramConnection();
}

function sendDeepgramAudio(buffer) {
    if (!deepgramConnection || !isDeepgramConnected) return;
    try {
        deepgramConnection.send(buffer);
        lastDeepgramAudioAt = Date.now();
    } catch (error) {
        console.error('[Deepgram] Error sending audio:', error);
    }
}

function notifyCaptionSource() {
    sendToOverlay('caption-source-changed', {
        source: captionAudioSource,
        device: remoteMicDevice,
        remoteMicActive
    });
}

// Phone microphone (Remote Mic) routing. Local capture keeps running so sound
// alerts and the visualizer still work; only its caption frames are dropped.
async function handleRemoteMicStart({ sampleRate, deviceName }) {
    remoteMicActive = true;
    remoteMicDevice = deviceName || 'Phone';
    captionAudioSource = 'phone';
    notifyCaptionSource();
    const connected = await startDeepgramStream({ sampleRate });
    return connected ? { ok: true } : { ok: false, error: 'Captions service unavailable' };
}

function handleRemoteMicFrame(buffer) {
    if (captionAudioSource !== 'phone') return;
    sendDeepgramAudio(buffer);
}

function handleRemoteMicStop() {
    remoteMicActive = false;
    remoteMicDevice = null;
    captionAudioSource = 'local';
    notifyCaptionSource();
    if (!rendererCaptionsActive) {
        stopDeepgramStream();
    } else if (deepgramSampleRate !== DEFAULT_CAPTION_SAMPLE_RATE) {
        startDeepgramStream({ sampleRate: DEFAULT_CAPTION_SAMPLE_RATE });
    }
}

ipcMain.handle('deepgram-start', async () => {
    rendererCaptionsActive = true;
    const sampleRate = captionAudioSource === 'phone' ? deepgramSampleRate : DEFAULT_CAPTION_SAMPLE_RATE;
    const connected = await startDeepgramStream({ sampleRate });
    if (!connected) {
        // The renderer falls back to offline transcription and stops sending audio.
        rendererCaptionsActive = false;
        if (!remoteMicActive) await stopDeepgramStream();
    }
    return connected
        ? { success: true }
        : { success: false, error: 'Unable to connect to the captions service' };
});

ipcMain.handle('deepgram-stop', async () => {
    rendererCaptionsActive = false;
    if (!remoteMicActive) {
        await stopDeepgramStream();
    }
    return { success: true };
});

ipcMain.on('deepgram-audio', (event, audioData) => {
    if (captionAudioSource !== 'local') return;
    sendDeepgramAudio(Buffer.from(new Int16Array(audioData).buffer));
});

ipcMain.handle('set-caption-source', async (_event, source) => {
    captionAudioSource = source === 'phone' && remoteMicActive ? 'phone' : 'local';
    notifyCaptionSource();
    return { success: true, source: captionAudioSource };
});

// Legacy pre-recorded transcription
// ML sound classification
ipcMain.handle('classify-audio', async (_event, audioData, sampleRate) => {
    if (!soundClassifier || !soundClassifier.isReady) return null;

    const toFloat32 = (value) => {
        if (!value) return null;
        if (value instanceof Float32Array) return value;
        if (Array.isArray(value)) return Float32Array.from(value);
        if (ArrayBuffer.isView(value)) {
            return new Float32Array(
                value.buffer,
                value.byteOffset || 0,
                Math.floor((value.byteLength || 0) / Float32Array.BYTES_PER_ELEMENT)
            );
        }
        return null;
    };

    let normalizedAudio = null;
    if (audioData && typeof audioData === 'object' && !Array.isArray(audioData)) {
        const mono = toFloat32(audioData.mono);
        const left = toFloat32(audioData.left);
        const right = toFloat32(audioData.right);
        normalizedAudio = (mono || left || right) ? { mono, left, right } : toFloat32(audioData);
    } else {
        normalizedAudio = toFloat32(audioData);
    }

    if (!normalizedAudio) return null;
    return soundClassifier.classify(normalizedAudio, sampleRate);
});

ipcMain.handle('classifier-status', () => {
    if (soundClassifier && typeof soundClassifier.getStatus === 'function') {
        return soundClassifier.getStatus();
    }
    return {
        ready: soundClassifier ? soundClassifier.isReady : false,
        loading: soundClassifier ? soundClassifier.isLoading : false,
        model: soundClassifier ? soundClassifier.modelName : null,
    };
});

ipcMain.handle('transcribe-audio', async (event, audioBuffer) => {
    const wavBuffer = float32ToWav(audioBuffer, 16000);
    try {
        const deepgram = await getDeepgramClient();
        const { result, error } = await deepgram.listen.prerecorded.transcribeFile(
            wavBuffer,
            {
                model: 'nova-3',
                smart_format: true,
                language: 'en',
                punctuate: true,
                diarize: true,
                mimetype: 'audio/wav',
            }
        );

        if (error) throw error;
        const text = result.results?.channels[0]?.alternatives[0]?.transcript;
        return { success: true, text: text };
    } catch (error) {
        console.warn('[Fallback] Deepgram failed, routing to OpenAI Transcribe...', error.message);
        try {
            const openai = getOpenAIClient();
            const transcription = await openai.audio.transcriptions.create({
                file: await toUploadFile(wavBuffer, 'audio.wav'),
                model: TRANSCRIBE_MODEL,
                language: 'en'
            });

            return { success: true, text: transcription.text };
        } catch (fallbackErr) {
            console.error('[OpenAI Transcribe Failed]', fallbackErr);
            return { success: false, error: fallbackErr.message || "Unknown Error" };
        }
    }
});

// TTS
ipcMain.handle('tts-speak', async (event, text) => {
    try {
        const openai = getOpenAIClient();

        const tempPath = path.join(os.tmpdir(), `relay_tts_${Date.now()}.mp3`);

        const mp3 = await openai.audio.speech.create({
            model: SPEECH_MODEL,
            voice: "alloy",
            input: text,
        });

        const buffer = Buffer.from(await mp3.arrayBuffer());
        fs.writeFileSync(tempPath, buffer);

        return { success: true, path: tempPath };
    } catch (error) {
        console.error('[OpenAI] TTS error:', error.message);
        return { success: false, error: error.message };
    }
});

// ============================================
// NEW: SETTINGS IPC HANDLERS
// ============================================

ipcMain.handle('settings-get', (event, key) => {
    return settings.get(key);
});

ipcMain.handle('settings-set', (event, key, value) => {
    settings.set(key, value);
    // Broadcast to all windows
    BrowserWindow.getAllWindows().forEach(win => {
        if (!win.isDestroyed()) {
            win.webContents.send('settings-changed', key, value);
        }
    });
    return true;
});

ipcMain.handle('settings-get-all', () => {
    return settings.getAll();
});

ipcMain.handle('settings-reset', () => {
    settings.reset();
    BrowserWindow.getAllWindows().forEach(win => {
        if (!win.isDestroyed()) {
            win.webContents.send('settings-changed', null, null);
        }
    });
    return true;
});

// ============================================
// NEW: SCREEN EXPLANATION AI (GPT-4o Vision)
// ============================================

ipcMain.handle('explain-screen', async () => {
    try {
        const screenshot = await getPrimaryScreenScreenshotDataUrl();
        const appName = await getActiveAppNameSafe();
        const analysis = await analyzeImageWithOpenAI({
            imageDataUrl: screenshot,
            mode: 'screen',
            appName,
            prompt: 'Describe where the user is, main layout, key interactive elements, and next actions.',
            detail: 'high'
        });

        return {
            success: true,
            explanation: analysis.description,
            description: analysis.description,
            objects: analysis.objects,
            text: analysis.text,
            confidence: analysis.confidence,
            screenshot,
            appName
        };
    } catch (error) {
        console.error('[Screen Explain] Error:', error.message);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('capture-screen', async (_event, options = {}) => {
    try {
        const screenshot = await getPrimaryScreenScreenshotDataUrl();
        const appName = await getActiveAppNameSafe();
        const analysis = await analyzeImageWithOpenAI({
            imageDataUrl: screenshot,
            mode: options.mode || 'screen',
            appName,
            prompt: options.prompt || '',
            detail: options.detail || 'high'
        });

        return {
            success: true,
            description: analysis.description,
            explanation: analysis.description,
            objects: analysis.objects,
            text: analysis.text,
            confidence: analysis.confidence,
            screenshot,
            appName,
            timestamp: Date.now()
        };
    } catch (error) {
        console.error('[Capture Screen] Error:', error.message);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('analyze-image', async (_event, imageData, options = {}) => {
    try {
        const imageDataUrl = normalizeImageForUpload(String(imageData || '').trim());
        const isDataImage = imageDataUrl.startsWith('data:image/');
        const isRemoteImage = /^https?:\/\//i.test(imageDataUrl);
        if (!isDataImage && !isRemoteImage) {
            return { success: false, error: 'Invalid image data. Expected image data URL or https URL.' };
        }

        const appName = await getActiveAppNameSafe();
        const analysis = await analyzeImageWithOpenAI({
            imageDataUrl,
            mode: options.mode || 'image',
            appName,
            prompt: options.prompt || 'Describe only this image content for accessibility. Ignore app UI, overlays, and captions.',
            detail: options.detail || 'high'
        });

        return {
            success: true,
            description: analysis.description,
            objects: analysis.objects,
            text: analysis.text,
            confidence: analysis.confidence
        };
    } catch (error) {
        console.error('[Analyze Image] Error:', error.message);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('context-assist', async (_event, payload = {}) => {
    const startedAt = Date.now();
    try {
        const prompt = String(payload?.prompt || '').trim();
        if (!prompt) {
            return { success: false, error: 'Prompt is required' };
        }

        const includeScreen = payload?.includeScreen !== false;
        const includeCamera = payload?.includeCamera !== false;
        const cameraImageDataUrl = normalizeImageForUpload(String(payload?.cameraImageDataUrl || '').trim());
        const hasCameraImage = includeCamera && /^data:image\//i.test(cameraImageDataUrl);
        const cameraMeta = payload?.cameraMeta && typeof payload.cameraMeta === 'object'
            ? payload.cameraMeta
            : {};
        const cameraBytes = estimateDataUrlBytes(cameraImageDataUrl);
        console.log(
            `[ContextAssist] step=1 request_received prompt="${prompt}" include_screen=${includeScreen} include_camera=${includeCamera} ` +
            `camera_present=${hasCameraImage} camera_bytes=${cameraBytes} camera_meta=${JSON.stringify({
                source: String(cameraMeta?.source || ''),
                width: Number(cameraMeta?.width || 0),
                height: Number(cameraMeta?.height || 0),
                avgLuma: Number(cameraMeta?.avgLuma || 0),
                bytes: Number(cameraMeta?.bytes || 0),
                error: String(cameraMeta?.error || '')
            })}`
        );
        const promptLower = prompt.toLowerCase();
        const cameraCentricPrompt = /(what am i holding|holding|hold|fingers|finger|hand|object|showing you|this item)/i.test(promptLower);
        const screenCentricPrompt = /(error|dialog|popup|window|button|menu|screen|how do i|get out of)/i.test(promptLower);
        const cameraImageDetail = cameraCentricPrompt ? 'high' : 'low';
        const screenImageDetail = screenCentricPrompt ? 'high' : 'low';

        const [appName, screenshot] = await Promise.all([
            getActiveAppNameSafe(),
            includeScreen
                ? getPrimaryScreenScreenshotDataUrl().catch(() => '')
                : Promise.resolve('')
        ]);
        const screenshotBytes = estimateDataUrlBytes(screenshot);
        console.log(
            `[ContextAssist] step=2 visual_assets_ready app="${appName}" screen_present=${Boolean(screenshot)} ` +
            `screen_bytes=${screenshotBytes} camera_present=${hasCameraImage}`
        );
        let capturePaths = {
            directory: '',
            screenImagePath: '',
            cameraImagePath: '',
            metaPath: ''
        };
        try {
            capturePaths = writeContextAssistCaptures({
                prompt,
                appName,
                screenshotDataUrl: screenshot,
                cameraDataUrl: cameraImageDataUrl,
                cameraMeta
            });
            console.log(
                `[ContextAssist] step=2b captures_saved dir="${capturePaths.directory}" ` +
                `screen_path="${capturePaths.screenImagePath}" camera_path="${capturePaths.cameraImagePath}" ` +
                `meta_path="${capturePaths.metaPath}"`
            );
        } catch (captureError) {
            console.warn(`[ContextAssist] step=2b captures_save_failed error="${captureError?.message || captureError}"`);
        }

        const openai = getOpenAIClient();
        const userContent = [
            {
                type: 'text',
                text: [
                    `User request: ${prompt}`,
                    `Active app: ${appName}`,
                    'Use the visuals to answer directly and practically.',
                    'If asked about an object being held, prioritize camera evidence.',
                    'If asked about an app error, prioritize screenshot evidence.',
                    'Keep the answer short and direct.'
                ].join('\n')
            }
        ];

        if (screenshot) {
            userContent.push({
                type: 'text',
                text: 'Image 1: This is the user\'s full computer screen screenshot.'
            });
            userContent.push({
                type: 'image_url',
                image_url: { url: screenshot, detail: screenImageDetail }
            });
        }
        if (hasCameraImage) {
            userContent.push({
                type: 'text',
                text: 'Image 2: This is the user\'s camera image.'
            });
            userContent.push({
                type: 'image_url',
                image_url: { url: cameraImageDataUrl, detail: cameraImageDetail }
            });
        }
        console.log(
            `[ContextAssist] step=3 openai_request model=${FAST_VISION_MODEL} images=${(screenshot ? 1 : 0) + (hasCameraImage ? 1 : 0)} ` +
            `screen_detail=${screenImageDetail} camera_detail=${cameraImageDetail}`
        );

        const response = await openai.chat.completions.create({
            model: FAST_VISION_MODEL,
            temperature: 0,
            stream: false,
            max_tokens: 170,
            messages: [
                {
                    role: 'system',
                    content: `You are Relay, an accessibility assistant.
Answer the user using the provided screen and camera context.
Be concise and action-oriented.
Prefer one short sentence, at most two.
Do not mention hidden system internals.
If visual evidence is insufficient, say exactly what is missing in one short sentence.`
                },
                { role: 'user', content: userContent }
            ]
        });

        const answer = String(response?.choices?.[0]?.message?.content || '').trim();
        const elapsedMs = Date.now() - startedAt;
        console.log(
            `[ContextAssist] step=4 openai_response success=true latency_ms=${elapsedMs} answer_chars=${answer.length}`
        );
        return {
            success: true,
            answer: answer || 'I could not infer enough from the current screen and camera view.',
            appName,
            usedScreen: Boolean(screenshot),
            usedCamera: Boolean(hasCameraImage),
            debug: {
                latencyMs: elapsedMs,
                screenBytes: screenshotBytes,
                cameraBytes,
                screenDetail: screenImageDetail,
                cameraDetail: cameraImageDetail,
                captureDir: capturePaths.directory,
                screenImagePath: capturePaths.screenImagePath,
                cameraImagePath: capturePaths.cameraImagePath,
                metaPath: capturePaths.metaPath
            }
        };
    } catch (error) {
        console.error('[Context Assist] Error:', error.message);
        console.error(`[ContextAssist] step=error latency_ms=${Date.now() - startedAt} message="${error?.message || error}"`);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('ask-follow-up', async (event, question, conversationHistory) => {
    try {
        const openai = getOpenAIClient();

        const messages = [
            {
                role: 'system',
                content: 'You are Relay, a screen reader assistant for a deaf/hard-of-hearing user. Answer questions about what was on the screen based on your previous analysis. Be concise and helpful.'
            },
            ...(conversationHistory || []),
            { role: 'user', content: question }
        ];

        const response = await openai.chat.completions.create({
            model: FAST_TEXT_MODEL,
            temperature: 0.1,
            stream: false,
            messages,
            max_tokens: 220
        });

        return { success: true, answer: response.choices[0].message.content };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// ============================================
// NEW: COMMAND BAR (Natural Language Commands)
// ============================================

ipcMain.handle('execute-command', async (event, query) => {
    try {
        const openai = getOpenAIClient();

        const response = await openai.chat.completions.create({
            model: FAST_TEXT_MODEL,
            temperature: 0,
            stream: false,
            messages: [
                {
                    role: 'system',
                    content: `You are a command interpreter for Relay, an accessibility app. Parse the user's natural language command and return a JSON action.

Available actions:
- toggle-captions: Show or hide captions
- explain-screen: Describe what's on screen
- caption-larger: Increase caption size
- caption-smaller: Decrease caption size
- dismiss-alerts: Clear all alerts
- open-settings: Open settings panel
- request-guidance: Open AI guide
- meeting-summary: Generate meeting summary
- toggle-overlay: Show/hide Relay overlay
- show-transcripts: Open transcript history

Return ONLY valid JSON: {"action": "action-name", "params": {}}`
                },
                { role: 'user', content: query }
            ],
            max_tokens: 80
        });

        const content = response.choices[0].message.content;
        const jsonStr = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const parsed = JSON.parse(jsonStr);
        return { success: true, action: parsed.action, params: parsed.params || {} };
    } catch (error) {
        console.error('[Command Bar] Error:', error.message);
        return { success: false, error: error.message };
    }
});

// ============================================
// NEW: MEETING SUMMARY GENERATION
// ============================================

const MAX_SUMMARY_TRANSCRIPT_CHARS = 200_000;

ipcMain.handle('generate-meeting-summary', async (event, data) => {
    try {
        const openai = getOpenAIClient();
        const fullTranscript = String(data?.transcript || '');
        const transcript = fullTranscript.length > MAX_SUMMARY_TRANSCRIPT_CHARS
            ? `[Earlier part of the meeting omitted]\n${fullTranscript.slice(-MAX_SUMMARY_TRANSCRIPT_CHARS)}`
            : fullTranscript;

        const response = await openai.chat.completions.create({
            model: FAST_TEXT_MODEL,
            temperature: 0.1,
            stream: false,
            messages: [
                {
                    role: 'system',
                    content: `You are Relay, summarizing a meeting for a deaf/hard-of-hearing user. Create a clear, structured summary.

Format:
## Meeting Summary
**App:** [meeting app name]
**Duration:** [duration]
**Participants:** [number] speakers detected

### Key Discussion Points
- Point 1
- Point 2

### Action Items
- [ ] Action 1
- [ ] Action 2

### Decisions Made
- Decision 1

### Unanswered Questions
- Question 1

Be concise but don't miss important details.`
                },
                {
                    role: 'user',
                    content: `Meeting on ${data.app}, duration: ${Math.round(data.duration / 60000)} minutes, ${data.speakerCount} speakers.\n\nFull transcript:\n${transcript}`
                }
            ],
            max_tokens: 1000
        });

        return { success: true, summary: response.choices[0].message.content };
    } catch (error) {
        console.error('[Meeting Summary] Error:', error.message);
        return { success: false, error: error.message };
    }
});

// ============================================
// NEW: TRANSCRIPT EXPORT
// ============================================

ipcMain.handle('open-transcript-viewer', () => {
    createTranscriptWindow();
});

ipcMain.handle('export-transcript', async (event, format, data) => {
    try {
        const ext = format === 'srt' ? 'srt' : format === 'vtt' ? 'vtt' : 'txt';
        const result = await dialog.showSaveDialog({
            title: 'Export Transcript',
            defaultPath: `relay-transcript.${ext}`,
            filters: [
                { name: `${format.toUpperCase()} Files`, extensions: [ext] },
                { name: 'All Files', extensions: ['*'] }
            ]
        });

        if (!result.canceled && result.filePath) {
            fs.writeFileSync(result.filePath, data, 'utf-8');
            return { success: true, path: result.filePath };
        }
        return { success: false, error: 'Export cancelled' };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// ============================================
// NEW: AUDIO DEVICE ENUMERATION
// ============================================

ipcMain.handle('enumerate-audio-devices', async () => {
    // This is handled in the renderer process via navigator.mediaDevices
    // Main process provides a fallback
    return [];
});

// ============================================
// NEW: HAPTIC FEEDBACK
// ============================================

ipcMain.on('trigger-haptic', (event, pattern) => {
    haptics.triggerHaptic(pattern);
});

// ============================================
// HELPER FUNCTIONS
// ============================================

function float32ToWav(samples, sampleRate) {
    const buffer = Buffer.alloc(44 + samples.length * 2);

    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + samples.length * 2, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(1, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * 2, 28);
    buffer.writeUInt16LE(2, 32);
    buffer.writeUInt16LE(16, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(samples.length * 2, 40);

    for (let i = 0; i < samples.length; i++) {
        const val = samples[i];
        const sample = Math.max(-1, Math.min(1, val));
        buffer.writeInt16LE(Math.round(sample * 32767), 44 + i * 2);
    }

    return buffer;
}

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
