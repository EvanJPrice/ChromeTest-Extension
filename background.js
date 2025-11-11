// background.js
console.log("BACKGROUND.JS SCRIPT STARTED");

const blockedPageUrl = chrome.runtime.getURL('blocked.html');
// --- Use YOUR Backend Render URL ---
const backendUrlBase = 'https://ai-backend.onrender.com'; // <-- ENSURE THIS IS YOUR URL

let userApiKey = null;

// --- API Key Loading ---
async function loadApiKey() {
    try {
        const items = await chrome.storage.sync.get('userApiKey');
        userApiKey = items.userApiKey;
        console.log("API Key loaded:", userApiKey ? "Yes" : "No");
    } catch (error) {
        console.error("Error loading API key:", error);
    }
}

// Listen for changes in storage (e.g., when user saves in options)
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'sync' && changes.userApiKey) {
        userApiKey = changes.userApiKey.newValue;
        console.log("API Key updated:", userApiKey ? "Yes" : "No");
        // Re-run heartbeat setup now that we have a key
        setupHeartbeat();
    }
});

// --- Heartbeat Setup ---
const HEARTBEAT_ALARM_NAME = 'heartbeat';

// Function to send the heartbeat ping
async function sendHeartbeat() {
    const { userApiKey } = await chrome.storage.sync.get('userApiKey');
    if (userApiKey) {
        try {
            // backendUrlBase is already defined in your file
            const heartbeatUrl = `${backendBaseUrl}/heartbeat?key=${userApiKey}`;

            await fetch(heartbeatUrl, { method: 'POST' });
            console.log("Heartbeat sent.");
        } catch (e) {
            console.error("Heartbeat failed:", e);
        }
    }
}

// Listen for the alarm to fire
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === HEARTBEAT_ALARM_NAME) {
        console.log("Heartbeat alarm triggered.");
        sendHeartbeat();
    }
});

// --- NEW: Send heartbeat on BROWSER startup ---
chrome.runtime.onStartup.addListener(() => {
    console.log("Browser startup detected, sending heartbeat.");
    sendHeartbeat();
});

// --- NEW: Send heartbeat on extension install/update ---
chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === "install" || details.reason === "update") {
        console.log("Extension installed/updated, sending heartbeat.");
        sendHeartbeat();
    }
});

// --- UPDATED: Create alarm (if needed) ---
chrome.alarms.get(HEARTBEAT_ALARM_NAME, (alarm) => {
    if (!alarm) {
        chrome.alarms.create(HEARTBEAT_ALARM_NAME, { 
            delayInMinutes: 1,  // Wait 1 minute after start
            periodInMinutes: 10 // Ping every 10 minutes
        });
        console.log("Heartbeat alarm created.");
    }
});

// --- CRITICAL CHANGE: Send a heartbeat every time the service worker starts
// This handles reloads from inactivity, updates, and initial loads.
console.log("Service worker started, sending heartbeat.");
sendHeartbeat();
// --- End Heartbeat Setup ---


// --- Listen for messages from Content Script ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'PAGE_DATA_RECEIVED' && sender.tab?.id && message.data?.url) {
        const tabId = sender.tab.id;
        const pageData = message.data;
        const targetUrl = pageData.url; 

        console.log("Background: Received PAGE_DATA for:", targetUrl);

        if (!userApiKey) {
            console.log('No API key set in storage. Stopping block check.');
            return true; // Stop here, don't block
        }

        if (targetUrl.startsWith(blockedPageUrl)) {
            console.log("Ignoring message from blocked page.");
            return true;
        }

        fetch(`${backendUrlBase}/check-url`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${userApiKey}`
            },
            body: JSON.stringify(pageData)
        })
        .then(response => {
            if (!response.ok) {
               console.error('Backend returned an error. Status:', response.status);
               throw new Error(`Server error: ${response.status}`);
            }
            return response.json();
          })
          .then(data => {
            console.log('Server decision for', targetUrl, 'is', data.decision);
            if (data.decision === 'BLOCK') {
              chrome.tabs.get(tabId, (tab) => {
                  if (chrome.runtime.lastError || !tab) {
                      console.warn(`Tab ${tabId} closed before block could be applied.`);
                  } else if (tab.url !== blockedPageUrl) {
                      chrome.tabs.update(tabId, { url: blockedPageUrl });
                  }
              });
            }
          })
          .catch(error => {
            console.error('Error fetching/processing backend response:', error);
             // Default to BLOCK on any fetch error
             chrome.tabs.get(tabId, (tab) => {
                 if (chrome.runtime.lastError || !tab) {
                      console.warn(`Tab ${tabId} closed before error block could be applied.`);
                 } else {
                     chrome.tabs.update(tabId, { url: blockedPageUrl });
                 }
              });
          });

        return true; // Indicate async response
    }
    return false;
});

// --- !! STARTUP LOGIC !! ---
// Load the key first, and THEN set up the heartbeat.
// This fixes the race condition.
loadApiKey().then(() => {
    setupHeartbeat();
});

console.log("BACKGROUND.JS LISTENING FOR MESSAGES");