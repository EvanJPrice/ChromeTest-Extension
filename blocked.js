document.addEventListener('DOMContentLoaded', () => {
    // --- Go to Google Button ---
    const goBackBtn = document.getElementById('go-back-btn');
    if (goBackBtn) {
        goBackBtn.addEventListener('click', () => {
            console.log("Go to Google clicked");
            window.location.href = 'https://www.google.com';
        });
    }

    // --- Close Tab Button ---
    const closeTabBtn = document.getElementById('close-tab-btn');
    if (closeTabBtn) {
        closeTabBtn.addEventListener('click', () => {
            console.log("Close Tab clicked");
            window.close();
        });
    }

    // --- Dashboard Button ---
    const dashboardBtn = document.getElementById('dashboard-btn');
    if (dashboardBtn) {
        dashboardBtn.addEventListener('click', () => {
            console.log("Dashboard clicked - Opening Dashboard");
            chrome.tabs.create({ url: 'http://localhost:5173' });
        });
    }

    // --- Report Bug Link ---
    const reportBugLink = document.getElementById('report-bug-link');
    if (reportBugLink) {
        reportBugLink.addEventListener('click', (e) => {
            e.preventDefault();
            console.log("Report Bug clicked - Opening Bug Report");
            const dashboardUrl = 'http://localhost:5173';
            const bugReportUrl = 'http://localhost:5173?reportBug=true';

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
