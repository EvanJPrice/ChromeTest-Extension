// content-script.js (v22 - Title Differencing & Settled Check)
console.log("CONTENT SCRIPT INJECTED");

let storedSearchQuery = null;
let lastProcessedVideoID = ""; 
let lastSentTitle = ""; 

// Helper: Get Video ID
function getVideoID(url) {
    try {
        const urlObj = new URL(url);
        if (url.includes('youtube.com/watch')) return urlObj.searchParams.get('v');
        return url; 
    } catch (e) { return url; }
}

// --- STORAGE HELPERS ---
async function getSearchContext() {
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
    try {
        await chrome.storage.local.set({
            'searchContext': { query: query, timestamp: Date.now() }
        });
    } catch (e) {}
}

async function clearSearchContext() {
    storedSearchQuery = null; 
    try { await chrome.storage.local.remove('searchContext'); } catch (e) {}
}

// --- 1. The Data Scraper ---
async function getPageData() {
    const url = window.location.href;
    let title = "";
    let h1 = "";
    let bodyText = "";
    let currentSearchQuery = null;

    // --- YOUTUBE SPECIFIC ---
    if (url.includes('youtube.com')) {
        
        // A. WATCH PAGE
        if (url.includes('/watch')) {
            const possibleSelectors = [
                'ytd-watch-metadata h1.ytd-watch-metadata', 
                '#title > h1 > yt-formatted-string',
                'h1.title'
            ];
            
            let foundH1 = false;
            for (const sel of possibleSelectors) {
                const el = document.querySelector(sel);
                if (el && el.textContent.trim().length > 0) {
                    const text = el.textContent.trim();
                    // Strict Stale Check: Title shouldn't end in "- YouTube"
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
        } else {
            title = document.title || "YouTube";
        }
    } else {
        // Non-YT
        title = (document.title || '').trim();
        h1 = (document.querySelector('h1')?.textContent || '').trim();
    }

    if (!h1 && !url.includes('youtube.com')) h1 = (document.querySelector('h1')?.textContent || '').trim();
    if (!bodyText && !url.includes('youtube.com')) bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim().substring(0, 500);

    if (!title) title = h1; 

    let description = (document.querySelector('meta[name="description"]')?.content || '').trim();
    let keywords = (document.querySelector('meta[name="keywords"]')?.content || '').trim();

    if (!currentSearchQuery) {
        try {
            const urlObj = new URL(url);
            if (urlObj.hostname.includes("google.") || urlObj.hostname.includes("bing.")) {
                currentSearchQuery = urlObj.searchParams.get('q');
            }
        } catch (e) {}
    }

    if (currentSearchQuery) await saveSearchContext(currentSearchQuery);

    let queryToSend = currentSearchQuery;
    if (!queryToSend) queryToSend = await getSearchContext();

    if ((!title && !h1) || !url.startsWith('http')) return null;

    return { title, description, h1, url, keywords, bodyText, searchQuery: queryToSend };
}

// --- 2. The Check Runner ---
let checkTimeout = null;

async function runCheck() {
    const currentUrl = window.location.href;
    const currentVideoID = getVideoID(currentUrl);

    if (checkTimeout) clearTimeout(checkTimeout);

    // 1. STRICT LOCK
    if (currentVideoID === lastProcessedVideoID && lastSentTitle !== "") return;

    console.log(`Processing New Video ID: ${currentVideoID}`);

    let attempts = 0;
    const maxAttempts = 20; 

    const attemptScrape = async () => {
        attempts++;
        const pageData = await getPageData();
        
        // 2. INITIAL FRESHNESS CHECK
        const isFresh = pageData && 
                       (pageData.title !== "YouTube") && 
                       (pageData.title !== lastSentTitle || attempts >= maxAttempts);

        if (isFresh) {
            // --- 3. "SETTLED" CHECK (Double-Verify) ---
            const candidateTitle = pageData.title;
            
            // Wait 250ms to see if it changes
            setTimeout(async () => {
                const doubleCheckData = await getPageData();
                
                // Is it STILL the same title?
                if (doubleCheckData && doubleCheckData.title === candidateTitle) {
                    
                    console.log(`Sending Verified Data:`, candidateTitle);
                    lastProcessedVideoID = currentVideoID;
                    lastSentTitle = candidateTitle;
                    
                    chrome.runtime.sendMessage({ type: 'PAGE_DATA_RECEIVED', data: pageData });

                    if (pageData.searchQuery && !currentUrl.includes('/results') && !currentUrl.includes('google.')) {
                         await clearSearchContext();
                    }

                } else {
                    console.log("Title flickered! Retrying...");
                    checkTimeout = setTimeout(attemptScrape, 250);
                }
            }, 250);

        } else {
            checkTimeout = setTimeout(attemptScrape, 500); 
        }
    };

    attemptScrape();
}

// --- 3. Triggers ---
setTimeout(runCheck, 500); 

document.addEventListener('yt-navigate-finish', () => {
    runCheck();
});

let lastUrlObserver = window.location.href;
new MutationObserver(() => {
    const currentUrl = window.location.href;
    if (currentUrl !== lastUrlObserver) {
        lastUrlObserver = currentUrl;
        runCheck(); 
    }
}).observe(document.body, { childList: true, subtree: true });