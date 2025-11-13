// content-script.js (v16 - Explicit Storage Clearing)
console.log("CONTENT SCRIPT INJECTED");

let storedSearchQuery = null; // In-memory cache
let lastProcessedVideoID = ""; 
let lastSentTitle = ""; 

function getVideoID(url) {
    try {
        const urlObj = new URL(url);
        if (url.includes('youtube.com/watch')) {
            return urlObj.searchParams.get('v');
        }
        return url; 
    } catch (e) { return url; }
}

// Helper: Search Context
async function getSearchContext() {
    // 1. Check in-memory first
    if (storedSearchQuery) return storedSearchQuery;

    // 2. Check storage
    try {
        const data = await chrome.storage.local.get('searchContext');
        if (data.searchContext) {
            const { query, timestamp } = data.searchContext;
            if (Date.now() - timestamp < 300000) return query;
        }
    } catch (e) {}
    return null;
}

async function saveSearchContext(query) {
    if (!query) return;
    storedSearchQuery = query; // Update memory
    try {
        await chrome.storage.local.set({
            'searchContext': { query: query, timestamp: Date.now() }
        });
    } catch (e) {}
}

async function clearSearchContext() {
    storedSearchQuery = null; // Clear memory
    try {
        await chrome.storage.local.remove('searchContext'); // Clear storage
        console.log("Context cleared.");
    } catch (e) {}
}

// --- 1. The Data Scraper ---
async function getPageData() {
    const url = window.location.href;
    let title = (document.title || '').trim();
    let h1 = '';
    let bodyText = '';
    let currentSearchQuery = null;

    // --- YOUTUBE SPECIFIC ---
    if (url.includes('youtube.com')) {
        if (url.includes('/watch')) {
            const possibleSelectors = [
                'ytd-watch-metadata h1.ytd-watch-metadata', 
                '#title > h1 > yt-formatted-string',
            ];
            
            let foundH1 = false;
            for (const sel of possibleSelectors) {
                const el = document.querySelector(sel);
                if (el && el.textContent.trim().length > 0) {
                    const text = el.textContent.trim();
                    if (!text.endsWith('- YouTube')) {
                        h1 = text;
                        title = h1; 
                        foundH1 = true;
                        break; 
                    }
                }
            }
            if (!foundH1) return null;

            const ytDesc = document.querySelector('#description-inline-expander');
            if (ytDesc) bodyText = ytDesc.innerText.replace(/\s+/g, ' ').trim().substring(0, 500);
        
        } else if (url.includes('/results')) {
            try {
                const urlObj = new URL(url);
                currentSearchQuery = urlObj.searchParams.get('search_query');
                if (!currentSearchQuery) return null; 
            } catch (e) {}
        }
    }

    // --- Fallbacks ---
    if (!h1) h1 = (document.querySelector('h1')?.textContent || '').trim();
    if (!bodyText) bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim().substring(0, 500);

    let description = (document.querySelector('meta[name="description"]')?.content || '').trim();
    let keywords = (document.querySelector('meta[name="keywords"]')?.content || '').trim();

    // --- Search Query Logic ---
    if (!currentSearchQuery) {
        try {
            const urlObj = new URL(url);
            if (urlObj.hostname.includes("google.") || urlObj.hostname.includes("bing.")) {
                currentSearchQuery = urlObj.searchParams.get('q');
            }
        } catch (e) {}
    }

    if (currentSearchQuery) {
        await saveSearchContext(currentSearchQuery);
    }

    let queryToSend = currentSearchQuery;
    if (!queryToSend) {
        queryToSend = await getSearchContext();
    }

    if ((!title && !h1) || !url.startsWith('http')) return null;

    return { title, description, h1, url, keywords, bodyText, searchQuery: queryToSend };
}

// --- 2. The Check Runner ---
let checkTimeout = null;

async function runCheck() {
    const currentUrl = window.location.href;
    const currentVideoID = getVideoID(currentUrl);

    if (checkTimeout) clearTimeout(checkTimeout);

    if (currentVideoID === lastProcessedVideoID && lastSentTitle !== "") {
        return;
    }

    console.log("Processing:", currentUrl);

    let attempts = 0;
    const maxAttempts = 10; 

    const attemptScrape = async () => {
        attempts++;
        const pageData = await getPageData();
        
        const isFresh = pageData && 
                       (pageData.title !== "YouTube") && 
                       (pageData.title !== lastSentTitle || attempts >= maxAttempts);

        if (isFresh) {
            console.log(`Sending Data:`, pageData.title);
            
            lastProcessedVideoID = currentVideoID;
            lastSentTitle = pageData.title;
            
            chrome.runtime.sendMessage({ type: 'PAGE_DATA_RECEIVED', data: pageData });

            // --- CRITICAL FIX: CLEAR CONTEXT AFTER SENDING ---
            // If we used a stored query (and we are NOT currently on a search page), clear it.
            if (pageData.searchQuery && !currentUrl.includes('/results') && !currentUrl.includes('google.') && !currentUrl.includes('bing.')) {
                 console.log("Used stored context. Clearing now.");
                 await clearSearchContext();
            }

        } else {
            console.log(`Waiting... (${attempts})`);
            checkTimeout = setTimeout(attemptScrape, 500); 
        }
    };

    attemptScrape();
}

// --- 3. Triggers ---
setTimeout(runCheck, 500); 

document.addEventListener('yt-navigate-finish', () => {
    // console.log("Event: yt-navigate-finish");
    runCheck();
});

let lastUrlObserver = window.location.href;
new MutationObserver(() => {
    const currentUrl = window.location.href;
    if (currentUrl !== lastUrlObserver) {
        lastUrlObserver = currentUrl;
        // console.log("Event: URL Mutation");
        runCheck(); 
    }
}).observe(document.body, { childList: true, subtree: true });