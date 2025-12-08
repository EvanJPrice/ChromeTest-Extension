// Update UI based on auth state
// Update UI based on auth state
async function updateUI() {
    const { authToken, userEmail, theme } = await chrome.storage.local.get(['authToken', 'userEmail', 'theme']);

    // Apply Theme
    if (theme === 'dark') {
        document.body.setAttribute('data-theme', 'dark');
    } else if (theme === 'light') {
        document.body.setAttribute('data-theme', 'light');
    } else {
        // System - remove attribute to let media query handle it
        document.body.removeAttribute('data-theme');
    }

    const authSection = document.getElementById('auth-section');
    const loginBtn = document.getElementById('login-btn');
    const logoutBtn = document.getElementById('logout-btn');

    if (authToken) {
        // Logged In
        authSection.innerHTML = `
            <div style="background-color: #dcfce7; color: #166534; padding: 12px; border-radius: 8px; margin-bottom: 1rem; border: 1px solid #bbf7d0;">
                <div style="font-weight: bold; font-size: 1.1rem; display: flex; align-items: center; justify-content: center; gap: 8px;">
                     Active
                </div>
                <div style="font-size: 0.85rem; text-align: center; margin-top: 4px; opacity: 0.9;">
                    ${userEmail || 'Logged In'}
                </div>
            </div>
        `;
        loginBtn.style.display = 'none';
        logoutBtn.style.display = 'block';
        logoutBtn.textContent = 'Sign Out';
        logoutBtn.style.display = 'block';
        logoutBtn.textContent = 'Sign Out';
        // Removed inline background color to respect CSS class
    } else {
        // Logged Out
        authSection.innerHTML = `
            <div style="background-color: #fee2e2; color: #991b1b; padding: 12px; border-radius: 8px; margin-bottom: 1rem; border: 1px solid #fecaca;">
                <div style="font-weight: bold; font-size: 1.1rem; display: flex; align-items: center; justify-content: center; gap: 8px;">
                     Inactive
                </div>
            </div>
        `;
        loginBtn.style.display = 'block';
        logoutBtn.style.display = 'none';
    }
}

// Event Handlers
document.getElementById('login-btn').addEventListener('click', () => {
    // Unified Login: Open Dashboard
    chrome.tabs.create({ url: 'http://localhost:5173' });
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
        chrome.tabs.create({ url: 'http://localhost:5173?logout=true' });

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
            status.textContent = response?.success ? 'Cache cleared.' : 'Error clearing cache.';
            setTimeout(() => status.textContent = '', 2000);

            // Reset button immediately
            btn.textContent = 'Clear Cache';
            btn.classList.remove('confirming');
        });
    }
});

document.getElementById('dashboard-btn').addEventListener('click', () => {
    chrome.tabs.create({ url: 'http://localhost:5173' });
});

document.getElementById('report-bug-link').addEventListener('click', (e) => {
    e.preventDefault();
    const dashboardUrl = 'http://localhost:5173';
    const bugReportUrl = 'http://localhost:5173?reportBug=true';

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

// Initialize
document.addEventListener('DOMContentLoaded', updateUI);

// Listen for storage changes (e.g. if user logs in via login.html tab)
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
        if (changes.authToken) updateUI();
        if (changes.theme) updateUI();
    }
});