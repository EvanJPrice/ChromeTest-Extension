// Update UI based on auth state
async function updateUI() {
    const { authToken, userEmail, theme, blockingPaused, strictModeUntil } = await chrome.storage.local.get(['authToken', 'userEmail', 'theme', 'blockingPaused', 'strictModeUntil']);

    // Apply Theme to html element for consistency with dashboard
    if (theme === 'dark') {
        document.documentElement.setAttribute('data-theme', 'dark');
    } else if (theme === 'light') {
        document.documentElement.setAttribute('data-theme', 'light');
    } else {
        // Fallback: If no theme is set, default to system preference
        document.documentElement.removeAttribute('data-theme');
    }

    const isDark = theme === 'dark' || (!theme && window.matchMedia('(prefers-color-scheme: dark)').matches);

    const authSection = document.getElementById('auth-section');
    const loginBtn = document.getElementById('login-btn');
    const logoutBtn = document.getElementById('logout-btn');
    const pauseSection = document.getElementById('pause-section');
    const pauseBtn = document.getElementById('pause-btn');
    const clearCacheBtn = document.getElementById('clear-cache');

    if (authToken) {
        // Logged In - check if paused
        if (blockingPaused) {
            // Paused state - amber styling (aligned with dashboard)
            authSection.innerHTML = `
                <div style="background-color: rgba(234, 179, 8, 0.1); color: ${isDark ? '#fbbf24' : '#b45309'}; padding: 12px; border-radius: 12px; margin-bottom: 1rem; border: 1px solid #f59e0b;">
                    <div style="font-weight: bold; font-size: 1.1rem; display: flex; align-items: center; justify-content: center; gap: 8px;">
                         Paused
                    </div>
                    <div style="font-size: 0.85rem; text-align: center; margin-top: 4px; opacity: 0.9;">
                        ${userEmail || 'Logged In'}
                    </div>
                </div>
            `;
        } else {
            // Active state - green styling (aligned with dashboard)
            authSection.innerHTML = `
                <div style="background-color: rgba(34, 197, 94, 0.1); color: ${isDark ? '#4ade80' : '#15803d'}; padding: 12px; border-radius: 12px; margin-bottom: 1rem; border: 1px solid #22c55e;">
                    <div style="font-weight: bold; font-size: 1.1rem; display: flex; align-items: center; justify-content: center; gap: 8px;">
                         Active
                    </div>
                    <div style="font-size: 0.85rem; text-align: center; margin-top: 4px; opacity: 0.9;">
                        ${userEmail || 'Logged In'}
                    </div>
                </div>
            `;
        }
        loginBtn.style.display = 'none';
        logoutBtn.style.display = 'flex';
        logoutBtn.textContent = 'Sign Out';
        clearCacheBtn.style.display = 'flex';

        // Pause/Resume button
        pauseSection.style.display = 'block';
        const isStrictMode = strictModeUntil && strictModeUntil > Date.now();

        if (isStrictMode) {
            pauseBtn.textContent = 'Locked (Strict Mode)';
            pauseBtn.disabled = true;
            pauseBtn.className = 'neutral-button';
        } else if (blockingPaused) {
            pauseBtn.textContent = 'Resume Blocking';
            pauseBtn.className = 'neutral-button resume-state';
            pauseBtn.disabled = false;
        } else {
            pauseBtn.textContent = 'Pause Blocking';
            pauseBtn.className = 'neutral-button pause-state';
            pauseBtn.disabled = false;
        }
    } else {
        // Logged Out - red styling (aligned with dashboard)
        authSection.innerHTML = `
            <div style="background-color: rgba(239, 68, 68, 0.1); color: ${isDark ? '#f87171' : '#b91c1c'}; padding: 12px; border-radius: 12px; margin-bottom: 1rem; border: 1px solid #ef4444;">
                <div style="font-weight: bold; font-size: 1.1rem; display: flex; align-items: center; justify-content: center; gap: 8px;">
                     Inactive
                </div>
            </div>
        `;
        loginBtn.style.display = 'flex';
        logoutBtn.style.display = 'none';
        clearCacheBtn.style.display = 'none';
        pauseSection.style.display = 'none';
    }

    // Version label
    document.getElementById('version-label').textContent = `v${chrome.runtime.getManifest().version}`;
}

// Event Handlers
document.getElementById('login-btn').addEventListener('click', () => {
    // Unified Login: Open Dashboard
    chrome.tabs.create({ url: BEACON_CONFIG.DASHBOARD_URL });
});

// Pause/Resume handler
document.getElementById('pause-btn').addEventListener('click', async () => {
    const { blockingPaused } = await chrome.storage.local.get('blockingPaused');
    const newValue = !blockingPaused;
    await chrome.storage.local.set({ blockingPaused: newValue });
    chrome.runtime.sendMessage({ type: 'SYNC_PAUSE', paused: newValue });
    updateUI();
});

let logoutConfirmTimer = null;
document.getElementById('logout-btn').addEventListener('click', async (e) => {
    const btn = e.target;

    if (btn.textContent === 'Sign Out') {
        // First click: Change text to confirm
        btn.textContent = 'Confirm Sign Out?';
        btn.classList.add('confirming');

        // Revert after 3 seconds if not clicked
        logoutConfirmTimer = setTimeout(() => {
            btn.textContent = 'Sign Out';
            btn.classList.remove('confirming');
        }, 3000);
    } else {
        // Second click: Actually log out
        clearTimeout(logoutConfirmTimer);

        // 1. Clear Extension Auth
        await chrome.storage.local.remove(['authToken', 'userEmail']);

        // 2. Open Dashboard to trigger Supabase Sign Out
        chrome.tabs.create({ url: BEACON_CONFIG.DASHBOARD_URL + '?logout=true' });

        updateUI();
    }
});

let clearCacheConfirmTimer = null;
document.getElementById('clear-cache').addEventListener('click', (e) => {
    const btn = e.target;

    if (btn.textContent === 'Clear Cache') {
        // First click: Change text to confirm
        btn.textContent = 'Confirm Clear Cache?';
        btn.classList.add('confirming');

        // Revert after 3 seconds if not clicked
        clearCacheConfirmTimer = setTimeout(() => {
            btn.textContent = 'Clear Cache';
            btn.classList.remove('confirming');
        }, 3000);
    } else {
        // Second click: Actually clear cache
        clearTimeout(clearCacheConfirmTimer);

        chrome.runtime.sendMessage({ type: 'CLEAR_LOCAL_CACHE' }, (response) => {
            const status = document.getElementById('status');
            if (response?.success) {
                status.innerHTML = `
                    <div class="status-success-container">
                        <svg class="status-icon" viewBox="0 0 24 24">
                            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
                        </svg>
                        <span class="status-text">System Cache Reset</span>
                    </div>
                `;
            } else {
                status.textContent = 'Error clearing cache.';
                status.style.color = 'red';
            }

            setTimeout(() => {
                status.innerHTML = '';
            }, 3000);

            // Reset button immediately
            btn.textContent = 'Clear Cache';
            btn.classList.remove('confirming');
        });
    }
});

document.getElementById('dashboard-btn').addEventListener('click', () => {
    chrome.tabs.create({ url: BEACON_CONFIG.DASHBOARD_URL });
});

document.getElementById('report-bug-link').addEventListener('click', (e) => {
    e.preventDefault();
    const dashboardUrl = BEACON_CONFIG.DASHBOARD_URL;
    const bugReportUrl = BEACON_CONFIG.DASHBOARD_URL + '?reportBug=true';

    chrome.tabs.query({ url: `${dashboardUrl}/*` }, (tabs) => {
        if (tabs.length > 0) {
            // Tab exists, update it and activate
            chrome.tabs.update(tabs[0].id, { url: bugReportUrl, active: true });
            chrome.windows.update(tabs[0].windowId, { focused: true });
        } else {
            // No tab, create new
            chrome.tabs.create({ url: bugReportUrl });
        }
    });
});

document.getElementById('feature-idea-link').addEventListener('click', (e) => {
    e.preventDefault();
    const dashboardUrl = BEACON_CONFIG.DASHBOARD_URL;
    const featureUrl = BEACON_CONFIG.DASHBOARD_URL + '?shareFeature=true';

    chrome.tabs.query({ url: `${dashboardUrl}/*` }, (tabs) => {
        if (tabs.length > 0) {
            chrome.tabs.update(tabs[0].id, { url: featureUrl, active: true });
            chrome.windows.update(tabs[0].windowId, { focused: true });
        } else {
            chrome.tabs.create({ url: featureUrl });
        }
    });
});

// Initialize
document.addEventListener('DOMContentLoaded', updateUI);

// Listen for storage changes (e.g. if user logs in via dashboard, or pauses from dashboard)
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
        if (changes.authToken || changes.theme || changes.blockingPaused || changes.strictModeUntil) {
            updateUI();
        }
    }
});
