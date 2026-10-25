const Store = require('electron-store');

const DEFAULTS = {
    // General
    launchAtLogin: false,
    showInMenuBar: true,
    language: 'en-US',
    accessibilityMode: 'deaf',

    // Captions
    captionEnabled: true,
    captionFontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", sans-serif',
    captionFontSize: 24,
    captionFontWeight: 'medium',
    captionTextColor: '#f5f5f7',
    captionBackgroundColor: 'rgba(29, 29, 31, 0.85)',
    captionBackgroundOpacity: 85,
    captionPosition: 'bottom',
    captionMaxLines: 3,
    showSpeakerNames: true,
    showEmotions: false,
    showTimestamps: false,
    showConfidenceShading: true,
    showFillerWords: true,
    fillerWordOpacity: 50,
    autoHideDelay: 0,
    customKeywords: [],

    // Sound Alerts
    soundAlertsEnabled: true,
    alertCategories: {
        emergency: true,
        attention: true,
        communication: true,
        appliance: true,
        environmental: true,
        media: false,
    },

    // AI Assistant
    aiProactivityLevel: 'balanced',
    aiExplanationDetail: 'normal',
    guideModeEnabled: true,

    // Meeting
    meetingAutoDetect: true,
    meetingAutoSummary: true,

    // Privacy
    forceOfflineTranscription: false,
    storeTranscripts: false,
    transcriptRetentionHours: 24,

    // Name Detection
    userNames: [],

    // Voice Command Router
    voiceCommandsMode: 'global',
    voiceCommandCooldownMs: 1800,
    voiceCommandMaxWords: 8,
    wakePhraseEnabled: true,
    wakePhrase: 'hey relay',
    wakePhraseAliases: ['hey relay'],
    wakePhraseStrict: true,
    wakePhraseAllowStopWithoutWake: true,
    premiumAutomationEnabled: false,
    automationContextTtlMs: 45000,
    automationAdvancedControlUnlocked: false,
    automationRequireHighRiskConfirmation: true,
    automationVisionFallback: true,
    automationModel: 'gpt-6-luna',

    // Advanced
    debugLogging: false,
    performanceMode: false,

    // Window position (persisted)
    overlayBounds: null,
};

let store;

function init() {
    store = new Store({
        name: 'relay-settings',
        defaults: DEFAULTS,
    });
    return store;
}

function getAll() {
    if (!store) init();
    return store.store;
}

function get(key) {
    if (!store) init();
    return store.get(key);
}

function set(key, value) {
    if (!store) init();
    store.set(key, value);
}

function reset() {
    if (!store) init();
    store.clear();
}

module.exports = { init, getAll, get, set, reset, DEFAULTS };
