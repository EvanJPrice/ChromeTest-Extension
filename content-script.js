// content-script.js (v36 - Safe Chrome API Wrapper)
console.log("CONTENT SCRIPT INJECTED");

// --- Safe Chrome API wrapper ---
// Prevents "Extension context invalidated" errors after extension reload
function safeSendMessage(message) {
    try {
        if (chrome.runtime && chrome.runtime.id) {
            chrome.runtime.sendMessage(message);
        }
    } catch (e) {
        // Extension was reloaded, this content script is stale
        console.log("Content Script: Extension context invalidated. Please refresh this page.");
    }
}

let lastSentTitle = "";
let lastSentUrl = "";
let isUpdatePending = false; // Lock to prevent overlapping updates

// Function to send the current page state to the background script
let updateTimeout = null;
const DEBOUNCE_DELAY_MS = 1500; // Increased from 1000 to 1500ms

// Function to send the current page state to the background script
function sendUpdate() {
    // Don't reset the timer if an update is already scheduled
    if (isUpdatePending) {
        console.log("Content Script: Update already pending, ignoring trigger.");
        return;
    }

    clearTimeout(updateTimeout);
    isUpdatePending = true;

    updateTimeout = setTimeout(() => {
        const currentTitle = document.title;
        const currentUrl = window.location.href;

        // Reset the lock first thing
        isUpdatePending = false;

        // Basic debounce: only send an update if the title OR URL has actually changed.
        if (currentTitle === lastSentTitle && currentUrl === lastSentUrl) {
            console.log("Content Script: No change detected, skipping update.");
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
        // Get first 500 chars of body text, cleaning up whitespace
        const bodyText = document.body.innerText.replace(/\s+/g, ' ').substring(0, 500);

        console.log(`Content Script: Sending update for "${currentTitle}" at ${currentUrl}`);
        safeSendMessage({
            type: 'PAGE_STATE_UPDATE',
            data: {
                url: currentUrl,
                title: currentTitle,
                description: description,
                keywords: keywords,
                bodyText: bodyText
            }
        });
    }, DEBOUNCE_DELAY_MS);
}

// --- Triggers ---

// 1. On initial load (slightly longer delay to ensure page is ready)
setTimeout(sendUpdate, 800);

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
const DASHBOARD_URLS = ['localhost:5173', 'chrome-test-dashboard.vercel.app'];

if (DASHBOARD_URLS.some(url => window.location.href.includes(url))) {
    console.log("Beacon Blocker: Dashboard detected. Injecting status marker.");

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
    window.addEventListener('BEACON_RULES_UPDATED', (event) => {
        console.log("Content Script: Received BEACON_RULES_UPDATED event. Clearing cache.");
        safeSendMessage({ type: 'CLEAR_LOCAL_CACHE' });
    });

    // --- Auth Sync Bridge ---
    document.addEventListener('BEACON_AUTH_SYNC', (event) => {
        const { token, email } = event.detail;
        console.log("Content Script: Received BEACON_AUTH_SYNC event.", email);
        if (token && email) {
            safeSendMessage({
                type: 'SYNC_AUTH',
                token: token,
                email: email
            });
        }
    });

    // --- Auth Logout Bridge ---
    document.addEventListener('BEACON_AUTH_LOGOUT', () => {
        console.log("Content Script: Received BEACON_AUTH_LOGOUT event.");
        safeSendMessage({ type: 'LOGOUT' });
    });

    // --- Theme Sync Bridge ---
    document.addEventListener('BEACON_THEME_SYNC', (event) => {
        const { theme } = event.detail;
        console.log("Content Script: Received BEACON_THEME_SYNC event.", theme);
        if (theme) {
            console.log("Content Script: Sending SYNC_THEME message to background.");
            safeSendMessage({
                type: 'SYNC_THEME',
                theme: theme
            });
        }
    });
}