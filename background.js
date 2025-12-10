// FILE: background.js
// VERSION: v7.6 (Anti-Duplicate API Calls)

console.log("BACKGROUND.JS SCRIPT STARTED");

const blockedPageUrl = chrome.runtime.getURL('blocked.html');
const backendUrlBase = 'http://localhost:3000'; // Localhost for testing

let tabState = {};

// --- IN-FLIGHT REQUEST TRACKING ---
// Prevents duplicate API calls for the same URL
const pendingRequests = new Map(); // Map<normalizedUrl, Promise>

// --- COOLDOWN-BASED DEDUPLICATION ---
// Prevents re-checking the same URL within a short time window
const recentlyProcessed = new Map(); // Map<normalizedUrl, timestamp>
const PROCESSING_COOLDOWN_MS = 3000; // 3 second cooldown between checks of same URL

// --- 1. ROBUST CACHING ---
// --- 1. ROBUST CACHING (PERSISTENT) & PRIVACY ---
const CACHE_EXPIRATION_BLOCK_MS = 5 * 60 * 1000; // 5 minutes for BLOCKS (to allow rule updates)
const CACHE_EXPIRATION_ALLOW_MS = 24 * 60 * 60 * 1000; // 24 hours for ALLOWS (save costs)
const MAX_CACHE_SIZE = 1000;

// Local Safe List - NEVER send these to the AI
const SAFE_LIST = [
    'chase.com', 'bankofamerica.com', 'wellsfargo.com', 'americanexpress.com', // Banking
    'google.com', 'gmail.com', 'docs.google.com', // Productivity
    'github.com', 'stackoverflow.com', // Dev
    'localhost', '127.0.0.1', '0.0.0.0', 'ai-dashboard'
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
    const entry = { ...data, timestamp: Date.now() };
    try {
        // Simple set. For true LRU in storage, we'd need a separate index, 
        // but for now we'll rely on the 5-min expiration to keep it relatively clean 
        // or implement a periodic cleanup if needed. 
        // Given the complexity, we'll just set it for now.
        await chrome.storage.local.set({ [key]: entry });
    } catch (e) {
        console.error("Cache set error:", e);
    }
}


// --- 2. AUTHENTICATION (JWT) ---
let authToken = null;

async function loadAuthToken() {
    try {
        console.log("DEBUG: Loading Auth Token...");
        const items = await chrome.storage.local.get('authToken');
        authToken = items.authToken;
        console.log("DEBUG: Auth Token Loaded:", authToken ? "Yes (Exists)" : "No (Null)");
        if (!authToken) {
            console.log("No auth token found. Waiting for user to log in via Dashboard.");
            // Do NOT auto-open login. It's annoying.
        }
    } catch (error) { console.error("Error loading auth token:", error); }
}

function openLogin() {
    // Deprecated: login.html
    // Redirect to Dashboard instead
    chrome.tabs.create({ url: 'http://localhost:5173' });
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
    if (message.type === 'LOG') {
        console.log(`[Login Page]`, ...message.data);
        return false;
    }
    if (message.type === 'AUTH_SUCCESS') {
        console.log("BACKGROUND: Auth Success Message Received. Reloading token.");
        loadAuthToken();
        return false;
    }
    if (message.type === 'SYNC_AUTH') {
        console.log("BACKGROUND: Sync Auth Message Received.", message.email);
        chrome.storage.local.set({
            authToken: message.token,
            userEmail: message.email
        }, () => {
            loadAuthToken();
        });
        return false;
    }
    if (message.type === 'LOGOUT') {
        console.log("BACKGROUND: Logout Message Received.");
        chrome.storage.local.remove(['authToken', 'userEmail'], () => {
            loadAuthToken();
        });
        return false;
    }
    if (message.type === 'SYNC_THEME') {
        console.log("BACKGROUND: Sync Theme Message Received.", message.theme);
        chrome.storage.local.set({ theme: message.theme });
        return false;
    }

    console.log(`BACKGROUND: Received message type: ${message.type}`);

    if (!authToken) {
        console.warn("BACKGROUND: No Auth Token! Ignoring message.");
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
    return false;
});

async function handlePageStateUpdate(message, sender) {
    const tabId = sender.tab.id;
    if (!tabId) return;
    const { url, title } = message.data;

    // --- 0. Immediate Safe List Check (Prevent Logging/AI) ---
    try {
        const urlObj = new URL(url);
        const hostname = urlObj.hostname.toLowerCase();

        // Check Safe List (localhost, banks, google, etc.)
        // We check if the hostname ends with any safe domain (e.g., 'mail.google.com' ends with 'google.com')
        // Or if it IS a safe domain (e.g. 'localhost')
        const isSafe = SAFE_LIST.some(safe => hostname === safe || hostname.endsWith('.' + safe));

        if (isSafe) {
            // console.log(`Ignored Safe List URL: ${url}`); // Optional: uncomment for debug
            return;
        }

        // Check for internal browser URLs
        if (url.startsWith('chrome://') || url.startsWith('about:') || url.startsWith('edge://')) return;

        // --- YouTube Optimization ---
        // Ignore navigation pages (Home, Search, Feed, History, Channel pages)
        // Only allow: /watch (Videos) or /shorts/ (Shorts)
        if (hostname.includes('youtube.com')) {
            const isContent = urlObj.pathname === '/watch' || urlObj.pathname.startsWith('/shorts/');
            if (!isContent) {
                // console.log("Ignoring YouTube navigation page:", url);
                return;
            }
        }
    } catch (e) {
        // If URL is invalid, ignore it
        return;
    }

    if (!tabState[tabId]) {
        tabState[tabId] = { lastProcessedUrl: null, lastProcessedTitle: null, hasBeenChecked: false };
    }
    const state = tabState[tabId];
    if (state.hasBeenChecked) return;
    if (!title || title === "YouTube") return;
    if (url === state.lastProcessedUrl && title === state.lastProcessedTitle) return;

    if (url !== state.lastProcessedUrl && title === state.lastProcessedTitle) {
        return;
    }
    state.hasBeenChecked = true;
    state.lastProcessedUrl = url;
    state.lastProcessedTitle = title;

    // --- COOLDOWN CHECK (Prevent rapid duplicate API calls) ---
    const cacheKey = normalizeUrl(url);
    const lastProcessedTime = recentlyProcessed.get(cacheKey);
    if (lastProcessedTime && (Date.now() - lastProcessedTime < PROCESSING_COOLDOWN_MS)) {
        console.log(`[DEDUP] Skipping ${cacheKey} - processed ${Date.now() - lastProcessedTime}ms ago`);
        return;
    }
    recentlyProcessed.set(cacheKey, Date.now());

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

    // Determine expiration based on decision
    let expiration = CACHE_EXPIRATION_BLOCK_MS;
    if (cached && cached.decision === 'ALLOW') {
        expiration = CACHE_EXPIRATION_ALLOW_MS;
    }

    if (cached && (Date.now() - cached.timestamp < expiration)) {
        console.log(`Cache Hit for ${url}: ${cached.decision}`);
        if (cached.decision === 'BLOCK') {
            blockPage(tabId, url);
        }
    } else {
        handlePageCheck(pageData, tabId);
    }
    if (isShortsUrl(url)) {
        handleShortsViewed(tabId, url);
    }
}

async function handleClearLocalCache(sendResponse) {
    console.log("Clearing local decision cache...");
    try {
        const items = await chrome.storage.local.get(null);
        const keysToRemove = Object.keys(items).filter(key => key !== 'authToken');

        if (keysToRemove.length > 0) {
            await chrome.storage.local.remove(keysToRemove);
        }

        console.log("Local decision cache cleared (AuthToken preserved).");
        if (typeof sendResponse === 'function') sendResponse({ success: true });
    } catch (e) {
        console.error("Error clearing cache:", e);
        if (typeof sendResponse === 'function') sendResponse({ success: false, error: e.message });
    }
}

// --- 4. SHORTS SESSION MANAGEMENT ---
function isShortsUrl(url) {
    if (!url) return false;
    return url.includes('/shorts/') || url.includes('/reels/') || url.includes('tiktok.com');
}
function getShortsPlatform(url) {
    if (!url) return "Short-form";
    if (url.includes('/shorts/')) return "Shorts";
    if (url.includes('/reels/')) return "Reels";
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
    const sessionKey = `shortsSession_${tabId}`;
    const { [sessionKey]: session } = await chrome.storage.local.get(sessionKey);
    if (session?.active) {
        const newCount = (session.count || 0) + 1;
        await chrome.storage.local.set({ [sessionKey]: { ...session, count: newCount } });
    } else {
        const newSession = { active: true, count: 1, startTime: Date.now(), startUrl: url, platform: getShortsPlatform(url) };
        await chrome.storage.local.set({ [sessionKey]: newSession });
    }
}
async function endShortsSession(tabId) {
    const sessionKey = `shortsSession_${tabId}`;
    const { [sessionKey]: session } = await chrome.storage.local.get(sessionKey);
    if (session?.active) {
        await chrome.storage.local.remove(sessionKey);
        const durationSeconds = Math.round((Date.now() - session.startTime) / 1000);
        const videoText = session.count === 1 ? 'video' : 'videos';
        const reason = `${session.platform || 'Short-form'} Session (${formatDuration(durationSeconds)})`;
        await sendLogEvent({ title: `Watched ${session.count} short-form ${videoText}`, reason: reason, decision: "ALLOW", url: session.startUrl });
    }
}

// --- 5. TAB & LIFECYCLE LISTENERS ---
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.status === 'loading' && tab.url) {
        const cached = await getCache(tab.url);

        let expiration = CACHE_EXPIRATION_BLOCK_MS;
        if (cached && cached.decision === 'ALLOW') expiration = CACHE_EXPIRATION_ALLOW_MS;

        if (cached && (Date.now() - cached.timestamp < expiration)) {
            const logTitle = cached.title || tab.title || "Cached Page";
            if (cached.decision === 'BLOCK') {
                console.log(`INSTA-BLOCK from cache for ${tab.url}`);
                sendLogEvent({ title: logTitle, reason: "Previously blocked by AI", decision: "BLOCK_CACHE", url: tab.url });
                blockPage(tabId, tab.url);
            } else if (cached.decision === 'ALLOW') {
                console.log(`Cache Hit (ALLOW) for ${tab.url}`);
                // Log it so it appears in the dashboard history
                // sendLogEvent({ title: logTitle, reason: "Previously allowed by AI", decision: "ALLOW_CACHE", url: tab.url });
            }
        }
        tabState[tabId] = { lastProcessedUrl: null, lastProcessedTitle: null, hasBeenChecked: false };
    }
    if (changeInfo.url && !isShortsUrl(changeInfo.url)) {
        endShortsSession(tabId);
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
    if (isShortsUrl(url)) {
        await chrome.storage.local.remove(`shortsSession_${tabId}`);
    }
    chrome.tabs.update(tabId, { url: blockedPageUrl }).catch(e => console.warn(`Tab ${tabId} likely closed.`));
}
async function handlePageCheck(pageData, tabId) {
    if (!tabId) return;
    const targetUrl = pageData.url;
    if (targetUrl.startsWith(blockedPageUrl)) return;

    // 0. Local Safe List Check
    const hostname = new URL(targetUrl).hostname;
    if (SAFE_LIST.some(safe => hostname.endsWith(safe))) {
        console.log(`Local Safe List match: ${hostname}`);
        await setCache(targetUrl, { decision: 'ALLOW' });
        return;
    }

    // --- IN-FLIGHT GUARD: Prevent duplicate requests ---
    const cacheKey = normalizeUrl(targetUrl);
    if (pendingRequests.has(cacheKey)) {
        console.log(`[GUARD] Request already in-flight for ${cacheKey}. Waiting...`);
        try {
            const existingResult = await pendingRequests.get(cacheKey);
            if (existingResult?.decision === 'BLOCK') {
                blockPage(tabId, targetUrl);
            }
            return;
        } catch (e) {
            // If the pending request failed, we'll try again
            console.log(`[GUARD] Pending request failed, retrying...`);
        }
    }

    // Create a promise for this request that others can await
    const requestPromise = (async () => {
        try {
            const fetchUrl = `${backendUrlBase}/check-url`;
            console.log(`[API CALL] Fetching: ${fetchUrl} for ${cacheKey}`);
            const response = await fetch(fetchUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
                body: JSON.stringify(pageData)
            });

            if (response.status === 401 || response.status === 403) {
                console.log("Auth token invalid. Clearing and re-login.");
                await chrome.storage.local.remove('authToken');
                authToken = null;
                openLogin();
                return null;
            }

            if (!response.ok) throw new Error(`Server error: ${response.status}`);
            const data = await response.json();
            console.log('Server decision for', targetUrl, 'is', data.decision);

            // --- Cache Invalidation Check ---
            if (data.cacheVersion) {
                const { cacheVersion: localVersion } = await chrome.storage.local.get('cacheVersion');
                if (!localVersion || data.cacheVersion > localVersion) {
                    console.log(`New rules detected (Server: ${data.cacheVersion}, Local: ${localVersion}). Clearing cache.`);
                    await handleClearLocalCache();
                    await chrome.storage.local.set({ cacheVersion: data.cacheVersion });
                }
            }

            await setCache(targetUrl, { decision: data.decision, title: pageData.title });
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
