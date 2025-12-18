document.addEventListener('DOMContentLoaded', () => {
    // --- Go to Google Button ---
    const goBackBtn = document.getElementById('go-back-btn');
    if (goBackBtn) {
        goBackBtn.addEventListener('click', () => {
            window.location.href = 'https://www.google.com';
        });
    }

    // --- Close Tab Button ---
    const closeTabBtn = document.getElementById('close-tab-btn');
    if (closeTabBtn) {
        closeTabBtn.addEventListener('click', () => {
            window.close();
        });
    }

    // --- Dashboard Button ---
    const dashboardBtn = document.getElementById('dashboard-btn');
    if (dashboardBtn) {
        dashboardBtn.addEventListener('click', () => {
            chrome.tabs.create({ url: BEACON_CONFIG.DASHBOARD_URL });
        });
    }

    // --- Report Bug Link ---
    const reportBugLink = document.getElementById('report-bug-link');
    if (reportBugLink) {
        reportBugLink.addEventListener('click', (e) => {
            e.preventDefault();
            const dashboardUrl = BEACON_CONFIG.DASHBOARD_URL;
            const bugReportUrl = BEACON_CONFIG.DASHBOARD_URL + '?reportBug=true';

            chrome.tabs.query({ url: `${dashboardUrl}/*` }, (tabs) => {
                if (tabs.length > 0) {
                    // Dashboard tab exists, update it and activate
                    chrome.tabs.update(tabs[0].id, { url: bugReportUrl, active: true });
                    chrome.windows.update(tabs[0].windowId, { focused: true });
                } else {
                    // No dashboard tab, create new
                    chrome.tabs.create({ url: bugReportUrl });
                }
            });
        });
    }
});
