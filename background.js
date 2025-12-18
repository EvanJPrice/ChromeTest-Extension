// FILE: background.js
// VERSION: v7.6 (Anti-Duplicate API Calls)

// Import centralized config
importScripts('config.js');

const blockedPageUrl = chrome.runtime.getURL('blocked.html');
const backendUrlBase = BEACON_CONFIG.BACKEND_URL;

let tabState = {};

// --- IN-FLIGHT REQUEST TRACKING ---
// Prevents duplicate API calls for the same URL
const pendingRequests = new Map(); // Map<normalizedUrl, Promise>

// --- COOLDOWN-BASED DEDUPLICATION ---
// Prevents re-checking the same URL within a short time window
const recentlyProcessed = new Map(); // Map<normalizedUrl, timestamp>
const PROCESSING_COOLDOWN_MS = 3000; // 3 second cooldown between checks of same URL

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

// --- LOCAL BLOCK LOG (Privacy-First) ---
// Stores recent blocks locally - NEVER sent to server
const MAX_BLOCK_LOG_SIZE = 5000; // ~2.5MB - makes full use of available storage
const BLOCK_LOG_KEY = 'localBlockLog';

async function addToLocalBlockLog(blockData) {
    try {
        const result = await chrome.storage.local.get(BLOCK_LOG_KEY);
        let blockLog = result[BLOCK_LOG_KEY] || [];

        // Deduplication: Don't add if it's the exact same URL and reason as the last entry
        // This prevents spam from SPA mutations or rapid cache hits
        if (blockLog.length > 0) {
            const last = blockLog[0];
            const isSameUrl = last.url === blockData.url;
            const isSameReason = last.reason === blockData.reason;
            // Also allow a small time gap (e.g. 5 seconds) if the user manually reloads, 
            // but for automatic triggers, let's just block identical back-to-back entries.
            if (isSameUrl && isSameReason && (Date.now() - last.timestamp < 10000)) {
                return;
            }
        }

        // Add new block at the beginning
        blockLog.unshift({
            url: blockData.url,
            domain: blockData.domain,
            reason: blockData.reason,
            pageTitle: blockData.pageTitle || '',
            activePrompt: blockData.activePrompt || null,
            timestamp: Date.now()
        });

        // Keep only last 50
        if (blockLog.length > MAX_BLOCK_LOG_SIZE) {
            blockLog = blockLog.slice(0, MAX_BLOCK_LOG_SIZE);
        }

        await chrome.storage.local.set({ [BLOCK_LOG_KEY]: blockLog });
    } catch (e) {
        console.error('Error adding to block log:', e);
    }
}

async function getLocalBlockLog() {
    try {
        const result = await chrome.storage.local.get(BLOCK_LOG_KEY);
        return result[BLOCK_LOG_KEY] || [];
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

async function loadAuthToken() {
    try {
        const items = await chrome.storage.local.get('authToken');
        authToken = items.authToken;
        if (!authToken) {
            // Do NOT auto-open login. It's annoying.
        }
    } catch (error) { console.error("Error loading auth token:", error); }
}

function openLogin() {
    // Deprecated: login.html
    // Redirect to Dashboard instead
    chrome.tabs.create({ url: 'https://beaconblocker.vercel.app' });
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
    console.log('[BEACON BG] Received message:', message.type, 'authToken:', authToken ? 'present' : 'null');
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
            userEmail: message.email
        }, () => {
            loadAuthToken();
        });
        return false;
    }
    if (message.type === 'LOGOUT') {
        chrome.storage.local.remove(['authToken', 'userEmail'], () => {
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

    // --- BLOCK LOG HANDLERS (for Dashboard) ---
    if (message.type === 'GET_BLOCK_LOG') {
        getLocalBlockLog().then(logs => {
            sendResponse({ success: true, logs: logs });
        });
        return true; // Will respond asynchronously
    }
    if (message.type === 'CLEAR_BLOCK_LOG') {
        clearLocalBlockLog().then(() => {
            sendResponse({ success: true });
        });
        return true;
    }

    return false;
});

// --- EXTERNAL MESSAGE LISTENER (for Dashboard) ---
// Allows dashboard web page to request block logs from extension
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {

    if (message.type === 'GET_BLOCK_LOG') {
        getLocalBlockLog().then(logs => {
            sendResponse({ success: true, logs: logs });
        });
        return true;
    }
    if (message.type === 'CLEAR_BLOCK_LOG') {
        clearLocalBlockLog().then(() => {
            sendResponse({ success: true });
        });
        return true;
    }
    if (message.type === 'PING') {
        sendResponse({ success: true, version: '1.0' });
        return false;
    }

    return false;
});
async function handlePageStateUpdate(message, sender) {
    const tabId = sender.tab.id;
    if (!tabId) { console.log('[PSU] No tabId'); return; }
    const { url, title } = message.data;
    console.log('[PSU] Processing:', url, title);

    // --- 0. Immediate Safe List Check (Prevent Logging/AI) ---
    try {
        const urlObj = new URL(url);
        const hostname = urlObj.hostname.toLowerCase();

        // Check Safe List (localhost, banks, google, etc.)
        // We check if the hostname ends with any safe domain (e.g., 'mail.google.com' ends with 'google.com')
        // Or if it IS a safe domain (e.g. 'localhost')
        const isSafe = SAFE_LIST.some(safe => hostname === safe || hostname.endsWith('.' + safe));

        if (isSafe) {
            console.log('[PSU] SAFE_LIST skip:', hostname);
            return;
        }

        // Check for internal browser URLs
        if (url.startsWith('chrome://') || url.startsWith('about:') || url.startsWith('edge://')) {
            console.log('[PSU] Browser URL skip');
            return;
        }

        // --- YouTube Optimization ---
        // Ignore navigation pages (Home, Search, Feed, History, Channel pages)
        // Only allow: /watch (Videos) or /shorts/ (Shorts)
        if (hostname.includes('youtube.com')) {
            const isContent = urlObj.pathname === '/watch' || urlObj.pathname.startsWith('/shorts/');
            if (!isContent) {
                console.log('[PSU] YouTube non-content skip');
                return;
            }
        }
    } catch (e) {
        console.log('[PSU] URL parse error:', e.message);
        return;
    }

    if (!tabState[tabId]) {
        tabState[tabId] = { lastProcessedUrl: null, lastProcessedTitle: null, hasBeenChecked: false };
    }
    const state = tabState[tabId];
    if (state.hasBeenChecked) { console.log('[PSU] Already checked this tab'); return; }
    if (!title || title === "YouTube") { console.log('[PSU] Empty/YT title skip'); return; }
    if (url === state.lastProcessedUrl && title === state.lastProcessedTitle) { console.log('[PSU] Same URL+title skip'); return; }

    if (url !== state.lastProcessedUrl && title === state.lastProcessedTitle) {
        console.log('[PSU] URL changed but title same - skip');
        return;
    }
    state.hasBeenChecked = true;
    state.lastProcessedUrl = url;
    state.lastProcessedTitle = title;

    // --- COOLDOWN CHECK (Prevent rapid duplicate API calls) ---
    const cacheKey = normalizeUrl(url);
    const lastProcessedTime = recentlyProcessed.get(cacheKey);
    if (lastProcessedTime && (Date.now() - lastProcessedTime < PROCESSING_COOLDOWN_MS)) {
        console.log('[PSU] Cooldown skip');
        return;
    }
    recentlyProcessed.set(cacheKey, Date.now());
    console.log('[PSU] Proceeding to check...');

    // Cleanup old entries periodically (prevent memory leak)
    if (recentlyProcessed.size > 100) {
        const now = Date.now();
        for (const [key, time] of recentlyProcessed) {
            if (now - time > PROCESSING_COOLDOWN_MS * 10) {
                recentlyProcessed.delete(key);
            }
        }
    }

    // Extract scraped data
    const { description, keywords, bodyText } = message.data;

    const pageData = {
        url,
        title,
        h1: title,
        description,
        keywords,
        bodyText,
        localTime: new Date().toLocaleString('en-US', { weekday: 'long', hour: 'numeric', minute: 'numeric', hour12: true })
    };

    const cached = await getCache(url);
    const { cacheVersion: currentVersion } = await chrome.storage.local.get('cacheVersion');

    // Cache is valid if it exists AND matches current cacheVersion (invalidated when user changes rules)
    const cacheValid = cached && (!currentVersion || cached.cacheVersion === currentVersion);

    if (cacheValid) {
        console.log('[PSU] Cache HIT:', cached.decision);
        if (cached.decision === 'BLOCK') {
            // --- PER-TAB SUPPRESSION ---
            // If this tab is already officially blocked for this URL, don't log it again
            if (tabState[tabId] && tabState[tabId].blockedUrl === url) {
                console.log('[PSU] Tab already blocked for this URL, skipping log/redirect');
                return;
            }

            const hostname = new URL(url).hostname.replace('www.', '');
            addToLocalBlockLog({
                url: url,
                domain: hostname,
                reason: cached.reason || 'Blocked by Beacon',
                pageTitle: pageData.title || cached.title || ''
            });
            blockPage(tabId, url);
        }
    } else {
        console.log('[PSU] Cache MISS, calling handlePageCheck');
        if (cached && !cacheValid) {
        }
        handlePageCheck(pageData, tabId);
    }
    // Shorts tracking is now handled in chrome.tabs.onUpdated listener
}

async function handleClearLocalCache(sendResponse) {
    try {
        const RESERVED_KEYS = ['authToken', 'userEmail', 'theme', BLOCK_LOG_KEY, 'cacheVersion'];

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

        // 5. Add System Reset Log
        await addToLocalBlockLog({
            url: 'https://beacon.internal/system-reset',
            domain: 'Beacon Control',
            reason: 'User Reset the Decision Cache',
            pageTitle: 'Cache Reset'
        });

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
    const { [sessionKey]: session } = await chrome.storage.local.get(sessionKey);
    if (session?.active) {
        // Track unique normalized URLs only
        const visitedUrls = new Set(session.visitedUrls || []);
        if (visitedUrls.has(normalizedUrl)) {

            return;
        }
        visitedUrls.add(normalizedUrl);
        const newCount = visitedUrls.size;

        await chrome.storage.local.set({ [sessionKey]: { ...session, count: newCount, visitedUrls: Array.from(visitedUrls) } });
    } else {
        const newSession = { active: true, count: 1, startTime: Date.now(), startUrl: url, visitedUrls: [normalizedUrl], platform: getShortsPlatform(url) };

        await chrome.storage.local.set({ [sessionKey]: newSession });
    }
}
async function endShortsSession(tabId) {
    const sessionKey = `shortsSession_${tabId}`;
    const { [sessionKey]: session } = await chrome.storage.local.get(sessionKey);
    if (session?.active) {
        await chrome.storage.local.remove(sessionKey);
        const durationSeconds = Math.round((Date.now() - session.startTime) / 1000);
        const hostname = session.startUrl ? new URL(session.startUrl).hostname.replace('www.', '') : 'unknown';
        const duration = formatDuration(durationSeconds);

        // Title includes count and duration, reason is consistent category
        let pageTitle;

        if (session.platform === 'TikTok') {
            pageTitle = `TikTok Session (${duration})`;
        } else if (session.platform === 'Reels') {
            pageTitle = `Reels Session | ${session.count} reel${session.count === 1 ? '' : 's'} watched (${duration})`;
        } else if (session.platform === 'Shorts') {
            pageTitle = `Shorts Session | ${session.count} short${session.count === 1 ? '' : 's'} watched (${duration})`;
        } else {
            pageTitle = `${session.platform} Session | ${session.count} video${session.count === 1 ? '' : 's'} watched (${duration})`;
        }

        const reason = 'Short-form Content';

        // Log to local storage so it appears in Activity Log
        addToLocalBlockLog({
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
                addToLocalBlockLog({
                    url: tab.url,
                    domain: hostname,
                    reason: cached.reason || 'Blocked by Beacon',
                    pageTitle: logTitle
                });
                blockPage(tabId, tab.url);
            } else if (cached.decision === 'ALLOW') {
            }
        }
        tabState[tabId] = { lastProcessedUrl: null, lastProcessedTitle: null, hasBeenChecked: false };
    }
    if (changeInfo.url && !isShortsUrl(changeInfo.url)) {
        endShortsSession(tabId);
    }
    // Start tracking when navigating TO a shorts URL
    if (changeInfo.url && isShortsUrl(changeInfo.url)) {
        console.log('[SHORTS] Tab navigated to shorts URL:', changeInfo.url);
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
    console.log('[BLOCK] Blocking tab', tabId, 'URL:', url);

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
    console.log('[HPC] handlePageCheck called for:', pageData.url);
    if (!tabId) { console.log('[HPC] No tabId, returning'); return; }
    const targetUrl = pageData.url;
    if (targetUrl.startsWith(blockedPageUrl)) return;

    // 0. Local Safe List Check
    const hostname = new URL(targetUrl).hostname;
    if (SAFE_LIST.some(safe => hostname.endsWith(safe))) {
        await setCache(targetUrl, { decision: 'ALLOW' });
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
            console.log('[API] Calling:', fetchUrl, 'with authToken:', authToken ? 'present' : 'null');
            const response = await fetch(fetchUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
                body: JSON.stringify(pageData)
            });
            console.log('[API] Response status:', response.status);

            if (response.status === 401 || response.status === 403) {
                await chrome.storage.local.remove('authToken');
                authToken = null;
                openLogin();
                return null;
            }

            if (!response.ok) throw new Error(`Server error: ${response.status}`);
            const data = await response.json();
            console.log('[API] Decision:', data.decision, 'Reason:', data.reason);

            // --- Cache Invalidation Check ---
            if (data.cacheVersion) {
                const { cacheVersion: localVersion } = await chrome.storage.local.get('cacheVersion');
                if (!localVersion || data.cacheVersion > localVersion) {
                    await handleClearLocalCache();
                    await chrome.storage.local.set({ cacheVersion: data.cacheVersion });
                }
            }

            await setCache(targetUrl, { decision: data.decision, title: pageData.title, reason: data.reason });
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
                url: targetUrl,
                domain: hostname,
                reason: data.reason || 'Blocked by Beacon',
                pageTitle: pageData.title || '',
                activePrompt: data.activePrompt || null
            });

            blockPage(tabId, targetUrl);
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
