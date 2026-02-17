// FILE: background.js
// VERSION: v7.7 (Privacy & Security Improvements)

// Import centralized config
importScripts('config.js');

// Conditional logging - only log in development mode
function debugLog(...args) {
    if (typeof IS_DEV !== 'undefined' && IS_DEV) {
        console.log(...args);
    }
}

const blockedPageUrl = chrome.runtime.getURL('blocked.html');
const backendUrlBase = BEACON_CONFIG.BACKEND_URL;

let tabState = {};

// --- TAB LOCKING (Prevents race conditions) ---
const tabLocks = new Map(); // Map<tabId, Promise>

// --- IN-FLIGHT REQUEST TRACKING ---
// Prevents duplicate API calls for the same URL
const pendingRequests = new Map(); // Map<normalizedUrl, Promise>

// --- COOLDOWN-BASED DEDUPLICATION ---
// Prevents re-checking the same URL within a short time window
const recentlyProcessed = new Map(); // Map<normalizedUrl, timestamp>
const PROCESSING_COOLDOWN_MS = 3000; // 3 second cooldown between checks of same URL

// --- PAGE DATA ENCRYPTION ---
// Encrypts page data before sending to backend (AES-256-GCM, same scheme as prompt encryption)
const CRYPTO_SALT = 'BeaconBlockerPresetSalt_v1';
const CRYPTO_ITERATIONS = 100000;
const CRYPTO_KEY_LENGTH = 256; // bits
const CRYPTO_IV_LENGTH = 12; // bytes

// Extract userId from Supabase JWT (sub claim)
function getUserIdFromToken(token) {
    try {
        const payload = token.split('.')[1];
        const decoded = JSON.parse(atob(payload));
        return decoded.sub || null;
    } catch (e) {
        return null;
    }
}

// Derive AES-256 key from userId using PBKDF2 (matches server-side cryptoUtils.js)
async function deriveEncryptionKey(userId) {
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        encoder.encode(userId),
        { name: 'PBKDF2' },
        false,
        ['deriveKey']
    );
    return crypto.subtle.deriveKey(
        {
            name: 'PBKDF2',
            salt: encoder.encode(CRYPTO_SALT),
            iterations: CRYPTO_ITERATIONS,
            hash: 'SHA-256'
        },
        keyMaterial,
        { name: 'AES-GCM', length: CRYPTO_KEY_LENGTH },
        false,
        ['encrypt']
    );
}

// Encrypt a string using AES-256-GCM, returns "ENC:" + base64
async function encryptString(plaintext, userId) {
    if (!plaintext || !userId) return plaintext;
    try {
        const key = await deriveEncryptionKey(userId);
        const encoder = new TextEncoder();
        const iv = crypto.getRandomValues(new Uint8Array(CRYPTO_IV_LENGTH));
        const encrypted = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv },
            key,
            encoder.encode(plaintext)
        );
        // Combine IV + ciphertext (auth tag is appended by WebCrypto)
        const combined = new Uint8Array(iv.length + encrypted.byteLength);
        combined.set(iv);
        combined.set(new Uint8Array(encrypted), iv.length);
        return 'ENC:' + btoa(String.fromCharCode(...combined));
    } catch (e) {
        debugLog('[ENCRYPT] Failed:', e.message);
        return plaintext; // Fallback to unencrypted
    }
}

// --- ENGAGEMENT EVENT TRACKING ---
// Send engagement events to backend for weekly reports (pause, unpause, strict mode, etc.)
async function sendEngagementEvent(eventType, metadata = {}) {
    try {
        const { authToken } = await chrome.storage.local.get('authToken');
        if (!authToken) {
            debugLog('[ENGAGEMENT] No auth token, skipping event:', eventType);
            return;
        }

        const response = await fetch(`${backendUrlBase}/api/engagement-event`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${authToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ event_type: eventType, metadata })
        });

        if (response.ok) {
            debugLog('[ENGAGEMENT] Event sent:', eventType);
        } else {
            console.warn('[ENGAGEMENT] Failed to send event:', eventType, response.status);
        }
    } catch (err) {
        // Fire and forget - don't break functionality if tracking fails
        console.warn('[ENGAGEMENT] Error sending event:', eventType, err.message);
    }
}

// --- API RETRY LOGIC WITH TIMEOUT ---
const API_TIMEOUT_MS = 10000; // 10 second timeout
const API_MAX_RETRIES = 2;

async function fetchWithTimeout(url, options, timeoutMs = API_TIMEOUT_MS) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
        debugLog(`[FETCH DEBUG] Aborting after ${timeoutMs}ms timeout`);
        controller.abort();
    }, timeoutMs);

    try {
        const bodySize = options?.body ? options.body.length : 0;
        debugLog(`[FETCH DEBUG] Starting fetch to ${url} (body: ${bodySize} bytes)`);
        const fetchStart = Date.now();
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        debugLog(`[FETCH DEBUG] Response received in ${Date.now() - fetchStart}ms, status: ${response.status}`);
        clearTimeout(timeoutId);
        return response;
    } catch (error) {
        clearTimeout(timeoutId);
        debugLog(`[FETCH DEBUG] Fetch error: ${error.name} - ${error.message}`);
        if (error.name === 'AbortError') {
            throw new Error('Request timeout');
        }
        throw error;
    }
}

async function fetchWithRetry(url, options, maxRetries = API_MAX_RETRIES) {
    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const response = await fetchWithTimeout(url, options);
            return response;
        } catch (error) {
            lastError = error;
            debugLog(`[API] Attempt ${attempt + 1} failed:`, error.message);

            // Don't retry on auth errors or if we're out of retries
            if (attempt >= maxRetries) break;

            // Exponential backoff: 1s, 2s, 4s...
            await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
        }
    }

    throw lastError;
}

// --- 1. ROBUST CACHING (VERSION-BASED INVALIDATION) ---
// Cache persists indefinitely until user changes their rules (triggers cacheVersion increment)
// This reduces API calls significantly while ensuring rule changes take effect immediately
const MAX_CACHE_SIZE = 200; // ~40KB - plenty for frequently visited sites

// Local Safe List - NEVER send these to the AI
const SAFE_LIST = [
    'chase.com', 'bankofamerica.com', 'wellsfargo.com', 'americanexpress.com', // Banking
    'google.com', 'gmail.com', 'docs.google.com', // Productivity
    'github.com', 'stackoverflow.com', // Dev
    'localhost', '127.0.0.1', '0.0.0.0', 'ai-dashboard',
    'vercel.app', 'netlify.app', // Dashboards
    'beaconblocker.com', // Custom domain (dashboard.beaconblocker.com, api.beaconblocker.com)
    chrome.runtime.id // Extension pages (blocked.html)
];

// Normalize URLs to be used as cache keys.
function normalizeUrl(url) {
    try {
        const urlObj = new URL(url);
        const hostname = urlObj.hostname.startsWith('www.') ? urlObj.hostname.substring(4) : urlObj.hostname;

        // YouTube Optimization: Only keep 'v' parameter for videos
        if (hostname === 'youtube.com' && urlObj.pathname === '/watch') {
            const v = urlObj.searchParams.get('v');
            return v ? `${hostname}${urlObj.pathname}?v=${v}` : `${hostname}${urlObj.pathname}`;
        }

        // Default: Strip query parameters to ensure stable caching for most sites (Netflix, etc.)
        return `${hostname}${urlObj.pathname}`.replace(/\/$/, '');
    } catch (e) {
        return url;
    }
}

async function getCache(url) {
    const key = normalizeUrl(url);
    try {
        const result = await chrome.storage.local.get(key);
        return result[key];
    } catch (e) {
        console.error("Cache get error:", e);
        return null;
    }
}

async function setCache(url, data) {
    const key = normalizeUrl(url);
    const { cacheVersion } = await chrome.storage.local.get('cacheVersion');
    const entry = { ...data, timestamp: Date.now(), cacheVersion: cacheVersion || null };
    try {
        await chrome.storage.local.set({ [key]: entry });
    } catch (e) {
        console.error("Cache set error:", e);
    }
}

// Cleanup old cache entries to stay under MAX_CACHE_SIZE
async function cleanupCache() {
    try {
        const items = await chrome.storage.local.get(null);
        const reservedKeys = ['authToken', 'userEmail', 'cacheVersion', 'theme', BLOCK_LOG_KEY];

        // Get all cache entries (normalized URLs start with http)
        const cacheEntries = Object.entries(items)
            .filter(([key]) => key.startsWith('http') && !reservedKeys.includes(key))
            .map(([key, value]) => ({ key, timestamp: value.timestamp || 0 }));

        if (cacheEntries.length > MAX_CACHE_SIZE) {
            // Sort by timestamp (oldest first) and remove excess
            cacheEntries.sort((a, b) => a.timestamp - b.timestamp);
            const toRemove = cacheEntries.slice(0, cacheEntries.length - MAX_CACHE_SIZE);
            await chrome.storage.local.remove(toRemove.map(e => e.key));
        }
    } catch (e) {
        console.error("Cache cleanup error:", e);
    }
}

// Run cleanup on extension startup
cleanupCache();

// Periodic cache cleanup (every 5 minutes) - prevents unbounded growth
setInterval(() => {
    cleanupCache();
    debugLog('[CLEANUP] Periodic cache cleanup completed');
}, 5 * 60 * 1000);

// Periodic cleanup of recentlyProcessed and pendingRequests maps (every minute)
setInterval(() => {
    const now = Date.now();
    let recentCleared = 0;
    let pendingCleared = 0;

    // Clean up recentlyProcessed entries older than 30 seconds
    for (const [key, timestamp] of recentlyProcessed) {
        if (now - timestamp > PROCESSING_COOLDOWN_MS * 10) {
            recentlyProcessed.delete(key);
            recentCleared++;
        }
    }

    // Clean up stale pendingRequests (should be resolved within 15 seconds)
    // Note: We can't easily track age, but we can limit the size
    if (pendingRequests.size > 50) {
        // If too many pending, something is wrong - clear old ones
        debugLog('[CLEANUP] pendingRequests size exceeded 50, clearing all');
        pendingRequests.clear();
        pendingCleared = pendingRequests.size;
    }

    if (recentCleared > 0 || pendingCleared > 0) {
        debugLog(`[CLEANUP] Cleared ${recentCleared} recentlyProcessed, ${pendingCleared} pendingRequests`);
    }
}, 60 * 1000);

// === STARTUP DIAGNOSTICS ===
// Log block log status to help debug persistence issues (dev mode only)
chrome.storage.local.get(['localBlockLog', 'authToken'], (result) => {
    debugLog('[BEACON STARTUP] Block log entries:', result.localBlockLog?.length || 0);
    debugLog('[BEACON STARTUP] Auth token present:', !!result.authToken);
    if (result.localBlockLog && result.localBlockLog.length > 0) {
        debugLog('[BEACON STARTUP] Most recent block:', result.localBlockLog[0]?.domain);
    }
});

// --- LOCAL BLOCK LOG (Privacy-First) ---
// Stores recent blocks locally - NEVER sent to server
// Auto-delete is user-configurable (off by default)
const MAX_BLOCK_LOG_SIZE = 1000; // ~500KB - reasonable memory footprint
const BLOCK_LOG_KEY = 'localBlockLog';
const DEFAULT_LOG_RETENTION_DAYS = 7;

// Get the user's configured retention period (or Infinity if disabled)
async function getLogRetentionMs() {
    const { autoDeleteActivityLog, activityLogRetention } = await chrome.storage.local.get([
        'autoDeleteActivityLog',
        'activityLogRetention'
    ]);

    // If auto-delete is disabled (or not set), return Infinity (never delete)
    if (autoDeleteActivityLog !== true) {
        return Infinity;
    }

    // Use stored retention or default to 7 days
    const days = activityLogRetention ?? DEFAULT_LOG_RETENTION_DAYS;
    return days * 24 * 60 * 60 * 1000;
}

async function addToLocalBlockLog(blockData) {
    // Check if we should log ALLOW decisions (off by default)
    const decision = blockData.decision || 'BLOCK';
    if (decision === 'ALLOW') {
        const { logAllowDecisions } = await chrome.storage.local.get('logAllowDecisions');
        debugLog('[ACTIVITY LOG] ALLOW decision - logAllowDecisions setting:', logAllowDecisions);
        if (!logAllowDecisions) {
            debugLog('[ACTIVITY LOG] Skipping ALLOW log (setting is off)');
            return; // Skip logging ALLOW if setting is off
        }
    }

    debugLog('[ACTIVITY LOG] Adding entry:', decision, blockData.url, blockData.reason);
    try {
        const result = await chrome.storage.local.get(BLOCK_LOG_KEY);
        let blockLog = result[BLOCK_LOG_KEY] || [];

        // Deduplication: Don't add if it's the exact same URL, reason, and decision as the last entry
        // This prevents spam from SPA mutations or rapid cache hits
        if (blockLog.length > 0) {
            const last = blockLog[0];
            const isSameUrl = last.url === blockData.url;
            const isSameReason = last.reason === blockData.reason;
            const isSameDecision = (last.decision || 'BLOCK') === decision;
            // Also allow a small time gap (e.g. 5 seconds) if the user manually reloads,
            // but for automatic triggers, let's just block identical back-to-back entries.
            if (isSameUrl && isSameReason && isSameDecision && (Date.now() - last.timestamp < 10000)) {
                return;
            }
        }

        // Add new entry at the beginning
        blockLog.unshift({
            url: blockData.url,
            domain: blockData.domain,
            reason: blockData.reason,
            decision: decision, // NEW: 'BLOCK' or 'ALLOW'
            pageTitle: blockData.pageTitle || '',
            activePrompt: blockData.activePrompt || null,
            timestamp: Date.now()
        });

        // Keep only last 1000
        if (blockLog.length > MAX_BLOCK_LOG_SIZE) {
            blockLog = blockLog.slice(0, MAX_BLOCK_LOG_SIZE);
        }

        await chrome.storage.local.set({ [BLOCK_LOG_KEY]: blockLog });
    } catch (e) {
        console.error('Error adding to activity log:', e);
    }
}

async function getLocalBlockLog() {
    try {
        const result = await chrome.storage.local.get(BLOCK_LOG_KEY);
        const logs = result[BLOCK_LOG_KEY] || [];

        // Get user's retention setting
        const retentionMs = await getLogRetentionMs();

        // If retention is Infinity (auto-delete disabled), return all logs
        if (retentionMs === Infinity) {
            return logs;
        }

        // Filter out expired entries based on user's retention setting
        const now = Date.now();
        const validLogs = logs.filter(log => (now - log.timestamp) < retentionMs);

        // If we filtered any, update storage
        if (validLogs.length < logs.length) {
            await chrome.storage.local.set({ [BLOCK_LOG_KEY]: validLogs });
            debugLog(`[BLOCK LOG] Cleaned ${logs.length - validLogs.length} expired entries`);
        }

        return validLogs;
    } catch (e) {
        console.error('Error getting block log:', e);
        return [];
    }
}

async function clearLocalBlockLog() {
    try {
        await chrome.storage.local.remove(BLOCK_LOG_KEY);
        // Notify dashboard to refresh logs
        notifyDashboard('BEACON_BLOCK_LOG_UPDATED');
    } catch (e) {
        console.error('Error clearing block log:', e);
    }
}

async function deleteSingleLog(timestamp) {
    try {
        const result = await chrome.storage.local.get(BLOCK_LOG_KEY);
        let blockLog = result[BLOCK_LOG_KEY] || [];
        blockLog = blockLog.filter(log => log.timestamp !== timestamp);
        await chrome.storage.local.set({ [BLOCK_LOG_KEY]: blockLog });
        notifyDashboard('BEACON_BLOCK_LOG_UPDATED');
    } catch (e) {
        console.error('Error deleting single log:', e);
    }
}


// --- SHARED MESSAGE HANDLER FOR BLOCK LOG OPERATIONS ---
// Used by both onMessage and onMessageExternal to avoid code duplication
async function handleBlockLogMessage(message, sendResponse) {
    switch (message.type) {
        case 'GET_BLOCK_LOG':
            const logs = await getLocalBlockLog();
            sendResponse({ success: true, logs });
            return true;

        case 'CLEAR_BLOCK_LOG':
            await clearLocalBlockLog();
            sendResponse({ success: true });
            return true;

        case 'DELETE_SINGLE_LOG':
            await deleteSingleLog(message.timestamp);
            sendResponse({ success: true });
            return true;

        default:
            return false;
    }
}

// --- DASHBOARD NOTIFICATION HELPER ---
// Sends a custom event to all open Dashboard tabs via the content script bridge
async function notifyDashboard(eventType, detail = {}) {
    const tabs = await chrome.tabs.query({});
    const dashboardUrls = BEACON_CONFIG.DASHBOARD_DOMAINS;

    for (const tab of tabs) {
        if (tab.url && dashboardUrls.some(domain => tab.url.includes(domain))) {
            try {
                // Use sendMessage directly to the tab's content script
                // The content script is already set up to bridge messages to CustomEvents
                chrome.tabs.sendMessage(tab.id, {
                    type: 'BRIDGE_EVENT',
                    eventType: eventType,
                    detail: detail
                }).catch(() => { /* Ignore errors for non-matching or dead tabs */ });
            } catch (e) {
                // Ignore errors
            }
        }
    }
}

// --- 2. AUTHENTICATION (JWT) ---
let authToken = null;
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

async function loadAuthToken() {
    try {
        const items = await chrome.storage.local.get(['authToken', 'authTokenExpiry']);

        // Check if token has expired
        if (items.authTokenExpiry && Date.now() > items.authTokenExpiry) {
            debugLog('[AUTH] Token expired, clearing');
            await chrome.storage.local.remove(['authToken', 'authTokenExpiry', 'userEmail']);
            authToken = null;
            return;
        }

        authToken = items.authToken;
        if (!authToken) {
            // Do NOT auto-open login. It's annoying.
        }
    } catch (error) { console.error("Error loading auth token:", error); }
}

function openLogin() {
    // Deprecated: login.html
    // Redirect to Dashboard instead
    chrome.tabs.create({ url: BEACON_CONFIG.DASHBOARD_URL });
}

chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local' && changes.authToken) {
        authToken = changes.authToken.newValue;
    }
});

async function initialize() {
    await loadAuthToken();
}
initialize();

// --- 3. CORE MESSAGE LISTENER ---
// Listen for messages from content scripts or popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    debugLog('[BEACON BG] Received message:', message.type);
    if (message.type === 'LOG') {
        return false;
    }
    if (message.type === 'AUTH_SUCCESS') {
        loadAuthToken();
        return false;
    }
    if (message.type === 'SYNC_AUTH') {
        chrome.storage.local.set({
            authToken: message.token,
            userEmail: message.email,
            authTokenExpiry: Date.now() + TOKEN_TTL_MS  // Token expires in 24 hours
        }, () => {
            loadAuthToken();
        });
        return false;
    }
    if (message.type === 'LOGOUT') {
        chrome.storage.local.remove(['authToken', 'userEmail', 'authTokenExpiry'], () => {
            loadAuthToken();
        });
        return false;
    }
    if (message.type === 'SYNC_THEME') {
        chrome.storage.local.set({ theme: message.theme });
        // Notify all other dashboard tabs and the extension popup
        notifyDashboard('BEACON_THEME_UPDATED', { theme: message.theme });
        return false;
    }
    if (message.type === 'SYNC_PAUSE') {
        debugLog('[BEACON] Sync pause received, paused:', message.paused, 'type:', typeof message.paused);
        chrome.storage.local.set({ blockingPaused: message.paused }, () => {
            // Verify storage was set correctly
            chrome.storage.local.get('blockingPaused', (result) => {
                debugLog('[BEACON] Storage verification - blockingPaused now:', result.blockingPaused);
            });
        });

        // Track engagement event for weekly reports
        sendEngagementEvent(message.paused ? 'pause' : 'unpause');

        if (message.paused) {
            // Clear cache when pausing so user gets fresh results on resume
            handleClearLocalCache(() => {
                debugLog('[BEACON] Cache cleared due to pause');
            });
        }
        // Notify popup and other tabs
        notifyDashboard('BEACON_PAUSE_UPDATED', { paused: message.paused });
        return false;
    }
    if (message.type === 'SYNC_ACTIVITY_LOG_SETTINGS') {
        chrome.storage.local.set({
            autoDeleteActivityLog: message.autoDelete,
            activityLogRetention: message.retentionDays,
            logAllowDecisions: message.logAllowDecisions
        }, () => {
            debugLog('[SETTINGS] Activity log settings updated:', message.autoDelete, message.retentionDays, 'logAllows:', message.logAllowDecisions);
            // Trigger immediate cleanup with new settings
            getLocalBlockLog();
        });
        return false;
    }


    if (!authToken) {
        // If we receive a message but have no token, ignore or prompt login
        // But don't block the message port if it's not relevant
        if (message.type === 'PAGE_STATE_UPDATE') {
            // Optionally open login here, but might be annoying
        }
        return false;
    }
    if (message.type === 'PAGE_STATE_UPDATE') {
        handlePageStateUpdate(message, sender);
        return false;
    }
    if (message.type === 'CLEAR_LOCAL_CACHE') {
        handleClearLocalCache(sendResponse);
        return true;
    }

    // --- BLOCK LOG HANDLERS (shared with onMessageExternal) ---
    if (['GET_BLOCK_LOG', 'CLEAR_BLOCK_LOG', 'DELETE_SINGLE_LOG'].includes(message.type)) {
        handleBlockLogMessage(message, sendResponse);
        return true;
    }

    // --- PAUSE STATE HANDLER (Dashboard reads current pause state) ---
    if (message.type === 'GET_PAUSE_STATE') {
        chrome.storage.local.get('blockingPaused', (result) => {
            sendResponse({ paused: result.blockingPaused ?? false });
        });
        return true; // Will respond asynchronously
    }

    // --- STORAGE USAGE HANDLER (for Dashboard Settings) ---
    if (message.type === 'GET_STORAGE_USAGE') {
        debugLog('[BEACON BG] Storage usage requested');
        chrome.storage.local.getBytesInUse(null, (bytesInUse) => {
            const maxBytes = 10485760; // 10 MB Chrome limit
            debugLog('[BEACON BG] Storage usage:', bytesInUse, '/', maxBytes);
            sendResponse({
                success: true,
                used: bytesInUse,
                max: maxBytes
            });
        });
        return true; // Will respond asynchronously
    }

    return false;
});

// --- EXTERNAL MESSAGE LISTENER (for Dashboard) ---
// Allows dashboard web page to request block logs from extension
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
    // --- SECURITY: Validate sender origin ---
    // Prevents malicious websites from controlling the extension
    const TRUSTED_ORIGINS = [
        'https://beaconblocker.vercel.app',
        'https://chrome-test-dashboard.vercel.app',
        ...(typeof IS_DEV !== 'undefined' && IS_DEV ? ['http://localhost:5173', 'http://localhost:3001'] : [])
    ];

    let senderOrigin = null;
    try {
        senderOrigin = sender.url ? new URL(sender.url).origin : null;
    } catch (e) {
        // Invalid URL
    }

    if (!senderOrigin || !TRUSTED_ORIGINS.includes(senderOrigin)) {
        console.warn('[SECURITY] Blocked external message from:', sender.url);
        sendResponse({ success: false, error: 'Unauthorized origin' });
        return false;
    }

    // --- BLOCK LOG HANDLERS (shared with onMessage) ---
    if (['GET_BLOCK_LOG', 'CLEAR_BLOCK_LOG', 'DELETE_SINGLE_LOG'].includes(message.type)) {
        handleBlockLogMessage(message, sendResponse);
        return true;
    }

    if (message.type === 'PING') {
        sendResponse({ success: true, version: '1.0' });
        return false;
    }

    // --- PAUSE STATE HANDLER (Dashboard reads current pause state) ---
    if (message.type === 'GET_PAUSE_STATE') {
        chrome.storage.local.get('blockingPaused', (result) => {
            sendResponse({ paused: result.blockingPaused ?? false });
        });
        return true;
    }

    // --- PAUSE SYNC FROM DASHBOARD (Direct External Message) ---
    if (message.type === 'SYNC_PAUSE') {
        debugLog('[BEACON EXT] External SYNC_PAUSE received, paused:', message.paused);
        chrome.storage.local.set({ blockingPaused: message.paused }, () => {
            debugLog('[BEACON EXT] blockingPaused stored:', message.paused);
            if (message.paused) {
                // Clear cache when pausing
                handleClearLocalCache(() => {
                    debugLog('[BEACON EXT] Cache cleared due to pause');
                });
            }
            sendResponse({ success: true, paused: message.paused });
        });
        return true; // Async response
    }

    return false;
});
async function handlePageStateUpdate(message, sender) {
    const tabId = sender.tab?.id;
    if (!tabId) { debugLog('[PSU] No tabId'); return; }

    // --- TAB LOCKING (Prevents race conditions) ---
    // Wait for any existing operation on this tab to complete
    if (tabLocks.has(tabId)) {
        try {
            await tabLocks.get(tabId);
        } catch (e) {
            // Previous operation failed, continue
        }
    }

    // Create lock for this operation
    const lockPromise = (async () => {
        const { url, title } = message.data;
        debugLog('[PSU] Processing:', url);

        // --- PAUSE CHECK ---
        // Skip all blocking if user has paused Beacon Blocker
        const { blockingPaused } = await chrome.storage.local.get('blockingPaused');
        if (blockingPaused) {
            debugLog('[PSU] Blocking paused, skipping');
            return;
        }

        // --- 0. Immediate Safe List Check (Prevent Logging/AI) ---
        try {
            const urlObj = new URL(url);
            const hostname = urlObj.hostname.toLowerCase();

            // Check Safe List (localhost, banks, google, etc.)
            const isSafe = SAFE_LIST.some(safe => hostname === safe || hostname.endsWith('.' + safe));

            if (isSafe) {
                debugLog('[PSU] SAFE_LIST skip:', hostname);
                return;
            }

            // Check for internal browser URLs
            if (url.startsWith('chrome://') || url.startsWith('about:') || url.startsWith('edge://')) {
                debugLog('[PSU] Browser URL skip');
                return;
            }

            // --- YouTube Optimization ---
            // Ignore navigation pages (Home, Search, Feed, History, Channel pages)
            // Only allow: /watch (Videos) or /shorts/ (Shorts)
            if (hostname.includes('youtube.com')) {
                const isContent = urlObj.pathname === '/watch' || urlObj.pathname.startsWith('/shorts/');
                if (!isContent) {
                    debugLog('[PSU] YouTube non-content skip');
                    return;
                }
            }
        } catch (e) {
            debugLog('[PSU] URL parse error:', e.message);
            return;
        }

        // Initialize tab state inside lock to prevent race
        if (!tabState[tabId]) {
            tabState[tabId] = { lastProcessedUrl: null, lastProcessedTitle: null };
        }
        const state = tabState[tabId];

        // Skip if same URL+title (inside lock to prevent race)
        if (!title || title === "YouTube") { debugLog('[PSU] Empty/YT title skip'); return; }
        if (url === state.lastProcessedUrl && title === state.lastProcessedTitle) {
            debugLog('[PSU] Same URL+title skip');
            return;
        }

        if (url !== state.lastProcessedUrl && title === state.lastProcessedTitle) {
            debugLog('[PSU] URL changed but title same - skip');
            return;
        }

        // Update state immediately inside lock
        state.lastProcessedUrl = url;
        state.lastProcessedTitle = title;

        // --- COOLDOWN CHECK (Prevent rapid duplicate API calls) ---
        const cacheKey = normalizeUrl(url);
        const lastProcessedTime = recentlyProcessed.get(cacheKey);
        if (lastProcessedTime && (Date.now() - lastProcessedTime < PROCESSING_COOLDOWN_MS)) {
            debugLog('[PSU] Cooldown skip');
            return;
        }
        recentlyProcessed.set(cacheKey, Date.now());
        debugLog('[PSU] Proceeding to check...');

        // Cleanup old entries periodically (prevent memory leak)
        if (recentlyProcessed.size > 100) {
            const now = Date.now();
            for (const [key, time] of recentlyProcessed) {
                if (now - time > PROCESSING_COOLDOWN_MS * 10) {
                    recentlyProcessed.delete(key);
                }
            }
        }

        // Extract scraped data (now includes bodySnippet for nuanced AI decisions)
        const { description, keywords, bodySnippet } = message.data;

        const pageData = {
            url,
            title,
            h1: title,
            description,
            keywords,
            bodySnippet: bodySnippet || "",  // 500 words of page content for AI context
            localTime: new Date().toLocaleString('en-US', { weekday: 'long', hour: 'numeric', minute: 'numeric', hour12: true })
        };

        const cached = await getCache(url);
        const { cacheVersion: currentVersion } = await chrome.storage.local.get('cacheVersion');

        // Cache is valid if it exists AND matches current cacheVersion (invalidated when user changes rules)
        const cacheValid = cached && (!currentVersion || cached.cacheVersion === currentVersion);

        if (cacheValid) {
            debugLog('[PSU] Cache HIT:', cached.decision);
            if (cached.decision === 'BLOCK') {
                // --- PER-TAB SUPPRESSION ---
                // If this tab is already officially blocked for this URL, don't log it again
                if (tabState[tabId] && tabState[tabId].blockedUrl === url) {
                    debugLog('[PSU] Tab already blocked for this URL, skipping log/redirect');
                    return;
                }

                const hostname = new URL(url).hostname.replace('www.', '');
                const cachedBlockReason = cached.reason ? `Cached decision · ${cached.reason}` : 'Cached decision';
                addToLocalBlockLog({
                    decision: 'BLOCK',
                    url: url,
                    domain: hostname,
                    reason: cachedBlockReason,
                    pageTitle: pageData.title || cached.title || '',
                    activePrompt: cached.activePrompt || null
                });
                blockPage(tabId, url);
            }
        } else {
            debugLog('[PSU] Cache MISS, calling handlePageCheck');
            handlePageCheck(pageData, tabId);
        }
        // Shorts tracking is now handled in chrome.tabs.onUpdated listener
    })();

    // Register the lock and wait for completion
    tabLocks.set(tabId, lockPromise);
    try {
        await lockPromise;
    } finally {
        tabLocks.delete(tabId);
    }
}

async function handleClearLocalCache(sendResponse) {
    try {
        const RESERVED_KEYS = ['authToken', 'userEmail', 'theme', BLOCK_LOG_KEY, 'cacheVersion', 'blockingPaused'];

        // 1. Capture critical data (Paranoid Snapshot)
        const diskState = await chrome.storage.local.get(RESERVED_KEYS);
        const allItems = await chrome.storage.local.get(null);

        // 2. Identify keys to remove (Everything EXCEPT reserved)
        const keysToRemove = Object.keys(allItems).filter(key =>
            !RESERVED_KEYS.includes(key)
        );

        // 3. Perform Removal
        if (keysToRemove.length > 0) {
            await chrome.storage.local.remove(keysToRemove);
        }

        // 4. PARANOID PRESERVATION: Restore if missing
        // Verify that critical keys still exist. If not, write them back from snapshot.
        const postClearState = await chrome.storage.local.get(RESERVED_KEYS);
        const recoveryPayload = {};

        if (diskState.theme && !postClearState.theme) recoveryPayload.theme = diskState.theme;
        if (diskState.userEmail && !postClearState.userEmail) recoveryPayload.userEmail = diskState.userEmail;
        if (diskState.authToken && !postClearState.authToken) recoveryPayload.authToken = diskState.authToken;
        if (diskState.localBlockLog && !postClearState.localBlockLog) recoveryPayload[BLOCK_LOG_KEY] = diskState.localBlockLog;
        if (diskState.cacheVersion && !postClearState.cacheVersion) recoveryPayload.cacheVersion = diskState.cacheVersion;

        if (Object.keys(recoveryPayload).length > 0) {
            await chrome.storage.local.set(recoveryPayload);
        }

        // 5. Reset in-memory dedup state so reloading a page after cache clear re-checks it
        for (const tabId of Object.keys(tabState)) {
            tabState[tabId] = { lastProcessedUrl: null, lastProcessedTitle: null, hasBeenChecked: false };
        }
        recentlyProcessed.clear();

        // Notify dashboard to refresh if open
        await notifyDashboard('BEACON_BLOCK_LOG_UPDATED');

        if (typeof sendResponse === 'function') sendResponse({ success: true });
    } catch (e) {
        console.error("Error clearing cache:", e);
        if (typeof sendResponse === 'function') sendResponse({ success: false, error: e.message });
    }
}

function isShortsUrl(url) {
    if (!url) return false;
    try {
        const urlObj = new URL(url);
        const path = urlObj.pathname;
        const hostname = urlObj.hostname;

        // Check for specific shorts/reels with an ID (not just the feed page)
        // YouTube: /shorts/ABC123
        // Instagram: /reels/ABC123 or /reel/ABC123
        const shortsMatch = path.match(/^\/shorts\/([^\/]+)/);
        const reelsMatch = path.match(/^\/reels\/([^\/]+)/);
        const reelMatch = path.match(/^\/reel\/([^\/]+)/);

        if (shortsMatch || reelsMatch || reelMatch) return true;

        // TikTok: Track entire domain (time-based, not count-based since URL doesn't change)
        if (hostname.includes('tiktok.com')) return true;

        return false;
    } catch (e) {
        return false;
    }
}
function getShortsPlatform(url) {
    if (!url) return "Short-form";
    if (url.includes('/shorts/')) return "Shorts";
    if (url.includes('/reels/') || url.includes('/reel/')) return "Reels";
    if (url.includes('tiktok.com')) return "TikTok";
    return "Short-form";
}
function formatDuration(totalSeconds) {
    if (totalSeconds < 60) return `${totalSeconds}s`;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

// --- IN-MEMORY SHORTS SESSION BUFFER ---
// Reduces chrome.storage writes by buffering in memory and persisting periodically
const shortsSessionBuffer = new Map(); // Map<sessionKey, session>

async function handleShortsViewed(tabId, url) {
    // Normalize URL by stripping query parameters (Instagram adds different params for same reel)
    let normalizedUrl;
    try {
        const urlObj = new URL(url);
        normalizedUrl = urlObj.origin + urlObj.pathname;
    } catch (e) {
        normalizedUrl = url;
    }

    const sessionKey = `shortsSession_${tabId}`;

    // Check in-memory buffer first
    let session = shortsSessionBuffer.get(sessionKey);

    // If not in buffer, try loading from storage
    if (!session) {
        const stored = await chrome.storage.local.get(sessionKey);
        if (stored[sessionKey]?.active) {
            session = {
                ...stored[sessionKey],
                visitedUrls: new Set(stored[sessionKey].visitedUrls || [])
            };
            shortsSessionBuffer.set(sessionKey, session);
        }
    }

    if (session?.active) {
        // Track unique normalized URLs only
        if (session.visitedUrls.has(normalizedUrl)) {
            return;
        }
        session.visitedUrls.add(normalizedUrl);
        session.count = session.visitedUrls.size;
        // No storage write here - batched in interval below
    } else {
        // Create new session in buffer
        const newSession = {
            active: true,
            count: 1,
            startTime: Date.now(),
            startUrl: url,
            visitedUrls: new Set([normalizedUrl]),
            platform: getShortsPlatform(url)
        };
        shortsSessionBuffer.set(sessionKey, newSession);
        // Immediately persist new session start
        await chrome.storage.local.set({
            [sessionKey]: {
                ...newSession,
                visitedUrls: Array.from(newSession.visitedUrls)
            }
        });
    }
}

// Persist buffered shorts sessions every 5 seconds
setInterval(async () => {
    for (const [sessionKey, session] of shortsSessionBuffer) {
        if (session.active) {
            await chrome.storage.local.set({
                [sessionKey]: {
                    ...session,
                    visitedUrls: Array.from(session.visitedUrls)
                }
            });
        }
    }
}, 5000);
async function endShortsSession(tabId) {
    const sessionKey = `shortsSession_${tabId}`;

    // Check buffer first, then storage
    let session = shortsSessionBuffer.get(sessionKey);
    if (!session) {
        const stored = await chrome.storage.local.get(sessionKey);
        session = stored[sessionKey];
    }

    if (session?.active) {
        // Clear from both buffer and storage
        shortsSessionBuffer.delete(sessionKey);
        await chrome.storage.local.remove(sessionKey);

        // Convert Set to size if needed (buffer uses Set, storage uses Array)
        const count = session.visitedUrls instanceof Set
            ? session.visitedUrls.size
            : (session.visitedUrls?.length || session.count || 1);

        const durationSeconds = Math.round((Date.now() - session.startTime) / 1000);
        const hostname = session.startUrl ? new URL(session.startUrl).hostname.replace('www.', '') : 'unknown';
        const duration = formatDuration(durationSeconds);

        // Title includes count and duration, reason is consistent category
        let pageTitle;

        if (session.platform === 'TikTok') {
            pageTitle = `TikTok Session (${duration})`;
        } else if (session.platform === 'Reels') {
            pageTitle = `Reels Session | ${count} reel${count === 1 ? '' : 's'} watched (${duration})`;
        } else if (session.platform === 'Shorts') {
            pageTitle = `Shorts Session | ${count} short${count === 1 ? '' : 's'} watched (${duration})`;
        } else {
            pageTitle = `${session.platform} Session | ${count} video${count === 1 ? '' : 's'} watched (${duration})`;
        }

        const reason = 'Short-form Content';

        // Log to local storage so it appears in Activity Log
        addToLocalBlockLog({
            decision: 'BLOCK',
            url: session.startUrl,
            domain: hostname,
            reason: reason,
            pageTitle: pageTitle
        });
    }
}

// --- 5. TAB & LIFECYCLE LISTENERS ---
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    // Clear block suppression if the URL has changed
    if (changeInfo.url && tabState[tabId]) {
        delete tabState[tabId].blockedUrl;
    }

    if (changeInfo.status === 'loading' && tab.url) {
        // Skip SAFE_LIST URLs entirely (dashboard, banks, etc.)
        try {
            const loadHostname = new URL(tab.url).hostname.toLowerCase();
            const isSafeUrl = SAFE_LIST.some(safe => loadHostname === safe || loadHostname.endsWith('.' + safe));
            if (isSafeUrl) {
                tabState[tabId] = { lastProcessedUrl: null, lastProcessedTitle: null, hasBeenChecked: false };
                return;
            }
        } catch (e) { /* invalid URL, continue */ }

        const cached = await getCache(tab.url);
        const { cacheVersion: currentVersion } = await chrome.storage.local.get('cacheVersion');

        // Cache is valid if it exists AND matches current cacheVersion
        const cacheValid = cached && (!currentVersion || cached.cacheVersion === currentVersion);

        if (cacheValid) {
            const logTitle = cached.title || tab.title || "Cached Page";
            if (cached.decision === 'BLOCK') {
                // --- PER-TAB SUPPRESSION ---
                if (tabState[tabId] && tabState[tabId].blockedUrl === tab.url) {
                    return;
                }

                // Log cache block to local log (privacy-first)
                const hostname = new URL(tab.url).hostname.replace('www.', '');
                const cachedReason = cached.reason ? `Cached decision · ${cached.reason}` : 'Cached decision';
                addToLocalBlockLog({
                    decision: 'BLOCK',
                    url: tab.url,
                    domain: hostname,
                    reason: cachedReason,
                    pageTitle: logTitle,
                    activePrompt: cached.activePrompt || null
                });
                blockPage(tabId, tab.url);
            } else if (cached.decision === 'ALLOW') {
                // Optionally log cached ALLOW (if setting is enabled, addToLocalBlockLog will handle)
                const hostname = new URL(tab.url).hostname.replace('www.', '');
                const cachedAllowReason = cached.reason ? `Cached decision · ${cached.reason}` : 'Cached decision';
                addToLocalBlockLog({
                    decision: 'ALLOW',
                    url: tab.url,
                    domain: hostname,
                    reason: cachedAllowReason,
                    pageTitle: logTitle,
                    activePrompt: cached.activePrompt || null
                });
            }
        }
        tabState[tabId] = { lastProcessedUrl: null, lastProcessedTitle: null, hasBeenChecked: false };
    }
    if (changeInfo.url && !isShortsUrl(changeInfo.url)) {
        endShortsSession(tabId);
    }
    // Start tracking when navigating TO a shorts URL
    if (changeInfo.url && isShortsUrl(changeInfo.url)) {
        debugLog('[SHORTS] Tab navigated to shorts URL:', changeInfo.url);
        handleShortsViewed(tabId, changeInfo.url);
    }
});
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
    endShortsSession(tabId);
    if (tabState[tabId]) {
        delete tabState[tabId];
    }
});

// --- 6. PAGE CHECK & BACKEND ---
async function blockPage(tabId, url) {
    // Check if blocking is paused - skip if so
    const { blockingPaused } = await chrome.storage.local.get('blockingPaused');
    debugLog('[BLOCK] blockingPaused check:', blockingPaused, 'url:', url);
    if (blockingPaused) {
        debugLog('[BLOCK] Blocking paused, not blocking:', url);
        return;
    }

    debugLog('[BLOCK] Blocking tab', tabId, 'URL:', url);

    // Mark this tab as blocked for this URL to prevent redundant logging
    if (tabState[tabId]) {
        tabState[tabId].blockedUrl = url;
    } else {
        tabState[tabId] = { blockedUrl: url };
    }

    if (isShortsUrl(url)) {
        await chrome.storage.local.remove(`shortsSession_${tabId}`);
    }
    // Actually block the page by redirecting to blocked.html
    try {
        await chrome.tabs.update(tabId, { url: blockedPageUrl + '?url=' + encodeURIComponent(url) });
    } catch (e) {
        console.error('[BLOCK] Error updating tab:', e);
    }
}
async function handlePageCheck(pageData, tabId) {
    debugLog('[HPC] handlePageCheck called');
    if (!tabId) { debugLog('[HPC] No tabId, returning'); return; }
    const targetUrl = pageData.url;
    if (targetUrl.startsWith(blockedPageUrl)) return;

    // 0. Local Safe List Check — skip silently (no cache, no log)
    const hostname = new URL(targetUrl).hostname;
    if (SAFE_LIST.some(safe => hostname === safe || hostname.endsWith('.' + safe))) {
        return;
    }

    // --- IN-FLIGHT GUARD: Prevent duplicate requests ---
    const cacheKey = normalizeUrl(targetUrl);
    if (pendingRequests.has(cacheKey)) {
        try {
            const existingResult = await pendingRequests.get(cacheKey);
            if (existingResult?.decision === 'BLOCK') {
                blockPage(tabId, targetUrl);
            }
            return;
        } catch (e) {
            // If the pending request failed, we'll try again
        }
    }

    // Create a promise for this request that others can await
    const requestPromise = (async () => {
        try {
            const fetchUrl = `${backendUrlBase}/check-url`;

            // Encrypt page data before sending to backend
            const userId = getUserIdFromToken(authToken);
            let bodyStr;
            if (userId) {
                const sensitiveData = JSON.stringify({
                    url: pageData.url,
                    title: pageData.title,
                    h1: pageData.h1,
                    description: pageData.description,
                    keywords: pageData.keywords,
                    bodySnippet: pageData.bodySnippet
                });
                const encryptedData = await encryptString(sensitiveData, userId);
                bodyStr = JSON.stringify({ encryptedData, localTime: pageData.localTime });
                debugLog('[API] Page data encrypted before sending');
            } else {
                bodyStr = JSON.stringify(pageData);
                debugLog('[API] No userId available, sending unencrypted');
            }

            debugLog('[API] Calling:', fetchUrl);
            debugLog('[API DEBUG] Auth token present:', !!authToken, 'Token length:', authToken?.length);
            const response = await fetchWithRetry(fetchUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
                body: bodyStr
            });
            debugLog('[API] Response status:', response.status);

            if (response.status === 401 || response.status === 403) {
                await chrome.storage.local.remove('authToken');
                authToken = null;
                // Don't auto-open login tab - just silently clear the token
                return null;
            }

            if (response.status === 402) {
                // Subscription expired — open dashboard once so user sees the SubscriptionGuard
                // Throttle: only open once per 10 minutes to avoid spamming tabs
                const { lastSubscriptionPrompt } = await chrome.storage.local.get('lastSubscriptionPrompt');
                const now = Date.now();
                if (!lastSubscriptionPrompt || now - lastSubscriptionPrompt > 10 * 60 * 1000) {
                    debugLog('[API] Subscription required (402) - opening dashboard');
                    await chrome.storage.local.set({ lastSubscriptionPrompt: now });
                    chrome.tabs.create({ url: BEACON_CONFIG.DASHBOARD_URL });
                }
                return null;
            }

            if (!response.ok) throw new Error(`Server error: ${response.status}`);
            const data = await response.json();
            debugLog('[API] Decision:', data.decision);

            // --- Cache Invalidation Check ---
            if (data.cacheVersion) {
                const { cacheVersion: localVersion } = await chrome.storage.local.get('cacheVersion');
                if (!localVersion || data.cacheVersion > localVersion) {
                    await handleClearLocalCache();
                    await chrome.storage.local.set({ cacheVersion: data.cacheVersion });
                }
            }

            // Skip caching for time-sensitive decisions (they contain time remaining info or clock times)
            // This ensures the AI/server is re-consulted when the timer/clock may have changed
            const reasonLower = data.reason ? data.reason.toLowerCase() : '';
            const isTimeSensitive = data.reason && (
                /\d+\s*(min|sec|hour)/i.test(data.reason) ||  // "30 minutes left"
                /\d{1,2}:\d{2}\s*(am|pm)/i.test(data.reason) || // "until 4:33 PM"
                /\d{1,2}\s*(am|pm)/i.test(data.reason) ||      // "until 5pm"
                reasonLower.includes('left)') ||
                reasonLower.includes('until') ||
                reasonLower.includes('till') ||
                reasonLower.includes('through') ||
                reasonLower.includes('before') ||
                reasonLower.includes('after') ||
                reasonLower.includes('starting') ||
                reasonLower.includes('noon') ||
                reasonLower.includes('midnight') ||
                reasonLower.includes('timer') ||
                reasonLower.includes('expired') ||
                reasonLower.includes('clock')
            );

            if (!isTimeSensitive) {
                await setCache(targetUrl, { decision: data.decision, title: pageData.title, reason: data.reason, activePrompt: data.activePrompt || null });
            } else {
                debugLog('[CACHE] Skipping cache for time-sensitive decision');
            }
            return data;
        } catch (error) {
            console.error('Error in handlePageCheck:', error);
            throw error;
        }
    })();

    // Register this request as pending
    pendingRequests.set(cacheKey, requestPromise);

    try {
        const data = await requestPromise;
        if (data?.decision === 'BLOCK') {
            // Log block locally (privacy-first - never sent to server)
            const hostname = new URL(targetUrl).hostname.replace('www.', '');
            addToLocalBlockLog({
                decision: 'BLOCK',
                url: targetUrl,
                domain: hostname,
                reason: data.reason || 'Blocked by Beacon',
                pageTitle: pageData.title || '',
                activePrompt: data.activePrompt || null
            });

            blockPage(tabId, targetUrl);
        } else if (data?.decision === 'ALLOW') {
            // Log allow locally if user has enabled this setting
            debugLog('[API] ALLOW decision - calling addToLocalBlockLog');
            const hostname = new URL(targetUrl).hostname.replace('www.', '');
            addToLocalBlockLog({
                decision: 'ALLOW',
                url: targetUrl,
                domain: hostname,
                reason: data.reason || 'Allowed',
                pageTitle: pageData.title || '',
                activePrompt: data.activePrompt || null
            });
        }
    } finally {
        // Clean up after request completes
        pendingRequests.delete(cacheKey);
    }
}
async function sendLogEvent(logData) {
    if (!authToken) return;
    try {
        await fetch(`${backendUrlBase}/log-event`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
            body: JSON.stringify(logData)
        });
    } catch (error) { console.error("Log error:", error); }
}
