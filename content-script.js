// content-script.js (v38 - Event Listener Cleanup)

// Conditional logging - only log in development mode
const IS_DEV_CONTENT = typeof BEACON_CONFIG !== 'undefined' && BEACON_CONFIG.BACKEND_URL.includes('localhost');
function debugLog(...args) {
    if (IS_DEV_CONTENT) {
        console.log(...args);
    }
}

// --- EVENT LISTENER TRACKING (for cleanup on page unload) ---
const registeredListeners = [];

function addTrackedListener(target, eventType, handler) {
    target.addEventListener(eventType, handler);
    registeredListeners.push({ target, eventType, handler });
}

// Cleanup all registered listeners on page unload
window.addEventListener('pagehide', () => {
    registeredListeners.forEach(({ target, eventType, handler }) => {
        target.removeEventListener(eventType, handler);
    });
    registeredListeners.length = 0;
});

// --- Safe Chrome API wrapper ---
// Prevents "Extension context invalidated" errors after extension reload
function safeSendMessage(message, callback) {
    try {
        chrome.runtime.sendMessage(message, (response) => {
            if (chrome.runtime.lastError) {
                // console.log('[BCB] Runtime error (expected if disconnected):', chrome.runtime.lastError.message);
                return;
            }
            if (callback) callback(response);
        });
    } catch (e) {
        // console.log('[BCB] Send message failed (expected if disconnected):', e.message);
        // Extension was reloaded, this content script is stale
    }
}

// --- Message Bridge from Background ---
chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'BRIDGE_EVENT') {
        window.dispatchEvent(new CustomEvent(message.eventType, { detail: message.detail }));
    }
});

let lastSentTitle = "";
let lastSentUrl = "";
let isUpdatePending = false; // Lock to prevent overlapping updates

// Function to send the current page state to the background script
let updateTimeout = null;
const DEBOUNCE_DELAY_MS = 800; // Reduced for faster blocking (was 1500ms)

// Function to send the current page state to the background script
function sendUpdate() {
    // Don't reset the timer if an update is already scheduled
    if (isUpdatePending) {
        return;
    }

    clearTimeout(updateTimeout);
    isUpdatePending = true;

    updateTimeout = setTimeout(() => {
        const currentTitle = document.title;
        const currentUrl = window.location.href;

        // Reset the lock first thing
        isUpdatePending = false;

        // Don't send updates for internal extension pages
        if (window.location.protocol === 'chrome-extension:') {
            return;
        }

        // Basic debounce: only send an update if the title OR URL has actually changed.
        if (currentTitle === lastSentTitle && currentUrl === lastSentUrl) {
            return;
        }

        // Don't send useless placeholder titles
        if (!currentTitle || currentTitle === "YouTube") {
            return;
        }

        lastSentTitle = currentTitle;
        lastSentUrl = currentUrl;

        // --- Scrape Context for AI ---
        const description = document.querySelector('meta[name="description"]')?.content || "";
        const keywords = document.querySelector('meta[name="keywords"]')?.content || "";

        // --- Body Text Snippet (500 words max) ---
        // This gives Gemini context to make nuanced decisions like
        // "YouTube video about coding" vs "YouTube video about gaming"
        let bodySnippet = "";
        try {
            // Get visible text from main content areas
            const contentSelectors = ['main', 'article', '[role="main"]', '.content', '#content', 'body'];
            let contentElement = null;
            for (const selector of contentSelectors) {
                contentElement = document.querySelector(selector);
                if (contentElement) break;
            }

            if (contentElement) {
                // Get text, remove scripts/styles, collapse whitespace
                const text = contentElement.innerText || contentElement.textContent || "";
                // Clean up: collapse whitespace, trim
                const cleanText = text.replace(/\s+/g, ' ').trim();
                // Take first 500 words (roughly 2500 chars)
                const words = cleanText.split(' ').slice(0, 500);
                bodySnippet = words.join(' ');
            }
        } catch (e) {
            // Silently fail - bodySnippet remains empty
        }

        safeSendMessage({
            type: 'PAGE_STATE_UPDATE',
            data: {
                url: currentUrl,
                title: currentTitle,
                description: description,
                keywords: keywords,
                bodySnippet: bodySnippet
            }
        });
    }, DEBOUNCE_DELAY_MS);
}

// --- Triggers ---

// 1. On initial load (reduced delay for faster blocking - was 800ms)
setTimeout(sendUpdate, 200);

// 2. For YouTube's SPA navigation
document.addEventListener('yt-navigate-finish', () => {
    // After a YT navigation, the title will change, triggering the observer.
    // Reset locks to ensure update is sent after navigation
    lastSentTitle = "";
    lastSentUrl = "";
    isUpdatePending = false;
    sendUpdate();
});

// 3. For general title changes (covers most SPA and MPA navigations)
const titleElement = document.querySelector('title');
if (titleElement) {
    new MutationObserver(() => {
        sendUpdate();
    }).observe(titleElement, { childList: true });
}

// --- Dashboard Integration ---
// This allows the web dashboard to know if the extension is installed and logged in.
const DASHBOARD_URLS = typeof BEACON_CONFIG !== 'undefined' ? BEACON_CONFIG.DASHBOARD_DOMAINS : ['beaconblocker.vercel.app', 'chrome-test-dashboard.vercel.app'];

// Extra validation for sensitive operations - ensures we're actually on a trusted dashboard
function isOnTrustedDashboard() {
    const currentHost = window.location.host.toLowerCase(); // Use .host to include port
    return DASHBOARD_URLS.some(domain =>
        currentHost === domain || currentHost.endsWith('.' + domain)
    );
}

debugLog('[BCB] Content script loaded');
debugLog('[BCB] Is dashboard:', DASHBOARD_URLS.some(url => window.location.href.includes(url)));

if (DASHBOARD_URLS.some(url => window.location.href.includes(url))) {
    debugLog('[BCB] Dashboard detected! Setting up bridges...');

    const injectMarker = async () => {
        const { authToken } = await chrome.storage.local.get('authToken');

        let marker = document.getElementById('beacon-extension-status');
        if (!marker) {
            marker = document.createElement('div');
            marker.id = 'beacon-extension-status';
            marker.style.display = 'none';
            document.body.appendChild(marker);
        }

        marker.setAttribute('data-installed', 'true');
        marker.setAttribute('data-logged-in', authToken ? 'true' : 'false');
        marker.setAttribute('data-version', chrome.runtime.getManifest().version);
        marker.setAttribute('data-extension-id', chrome.runtime.id);

        // Dispatch event so React knows to check immediately
        window.dispatchEvent(new CustomEvent('beacon-extension-update'));
    };

    injectMarker();

    // Listen for login/logout changes
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.authToken) {
            injectMarker();
        }
    });

    // --- Cache Invalidation Bridge ---
    // Listen for CustomEvent from the Dashboard (App.jsx)
    addTrackedListener(window, 'BEACON_RULES_UPDATED', () => {
        safeSendMessage({ type: 'CLEAR_LOCAL_CACHE' });
    });

    // --- Auth Sync Bridge ---
    // Extra validation for auth operations to prevent injection attacks
    addTrackedListener(document, 'BEACON_AUTH_SYNC', (event) => {
        if (!isOnTrustedDashboard()) {
            console.warn('[BCB] Auth sync rejected - not on trusted dashboard. Host:', window.location.host);
            return;
        }
        const { token, email } = event.detail;
        if (token && email) {
            console.log('[BCB] Auth sync accepted for:', email);
            safeSendMessage({
                type: 'SYNC_AUTH',
                token: token,
                email: email
            });
        }
    });

    // --- Auth Logout Bridge ---
    addTrackedListener(document, 'BEACON_AUTH_LOGOUT', () => {
        if (!isOnTrustedDashboard()) {
            console.warn('[BCB] Logout rejected - not on trusted dashboard');
            return;
        }
        safeSendMessage({ type: 'LOGOUT' });
    });

    // --- Theme Sync Bridge ---
    addTrackedListener(document, 'BEACON_THEME_SYNC', (event) => {
        const { theme } = event.detail;
        if (theme) {
            safeSendMessage({
                type: 'SYNC_THEME',
                theme: theme
            });
        }
    });

    // --- Pause Sync Bridge ---
    addTrackedListener(document, 'BEACON_PAUSE_SYNC', (event) => {
        const { paused } = event.detail;
        debugLog('[BCB] Syncing pause state:', paused);
        safeSendMessage({
            type: 'SYNC_PAUSE',
            paused: paused
        });
    });

    // --- Block Log Fetch Bridge (Privacy-First) ---
    // Dashboard requests block logs via CustomEvent, we respond with local storage data
    addTrackedListener(document, 'BEACON_GET_BLOCK_LOG', async () => {
        try {
            // Request block log from background script
            chrome.runtime.sendMessage({ type: 'GET_BLOCK_LOG' }, (response) => {
                if (response?.success) {
                    // Dispatch response event with logs
                    window.dispatchEvent(new CustomEvent('BEACON_BLOCK_LOG_RESPONSE', {
                        detail: { logs: response.logs }
                    }));
                } else {
                    window.dispatchEvent(new CustomEvent('BEACON_BLOCK_LOG_RESPONSE', {
                        detail: { logs: [] }
                    }));
                }
            });
        } catch (e) {
            console.error("Content Script: Error fetching block log:", e);
            window.dispatchEvent(new CustomEvent('BEACON_BLOCK_LOG_RESPONSE', {
                detail: { logs: [] }
            }));
        }
    });

    // --- Block Log Clear Bridge ---
    addTrackedListener(document, 'BEACON_CLEAR_BLOCK_LOG', () => {
        safeSendMessage({ type: 'CLEAR_BLOCK_LOG' });
    });

    // --- Single Log Delete Bridge ---
    addTrackedListener(document, 'BEACON_DELETE_SINGLE_LOG', (event) => {
        const { timestamp } = event.detail;
        safeSendMessage({ type: 'DELETE_SINGLE_LOG', timestamp });
    });

    // --- Activity Log Settings Bridge ---
    addTrackedListener(document, 'BEACON_ACTIVITY_LOG_SETTINGS_SYNC', (event) => {
        const { autoDelete, retentionDays, logAllowDecisions } = event.detail;
        safeSendMessage({
            type: 'SYNC_ACTIVITY_LOG_SETTINGS',
            autoDelete,
            retentionDays,
            logAllowDecisions
        });
    });

    // --- Pause State Bridge (Dashboard reads current pause state from extension) ---
    addTrackedListener(document, 'BEACON_GET_PAUSE_STATE', () => {
        safeSendMessage({ type: 'GET_PAUSE_STATE' }, (response) => {
            window.dispatchEvent(new CustomEvent('BEACON_PAUSE_STATE_RESPONSE', {
                detail: { paused: response?.paused ?? false }
            }));
        });
    });

    // --- Storage Usage Bridge ---
    addTrackedListener(document, 'BEACON_GET_STORAGE_USAGE', () => {
        safeSendMessage({ type: 'GET_STORAGE_USAGE' }, (response) => {
            if (response?.success) {
                window.dispatchEvent(new CustomEvent('BEACON_STORAGE_USAGE_RESPONSE', {
                    detail: { used: response.used, max: response.max }
                }));
            } else {
                window.dispatchEvent(new CustomEvent('BEACON_STORAGE_USAGE_RESPONSE', {
                    detail: { used: 0, max: 10485760 }
                }));
            }
        });
    });
}