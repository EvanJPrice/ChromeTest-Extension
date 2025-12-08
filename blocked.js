document.addEventListener('DOMContentLoaded', () => {
    const goBackBtn = document.getElementById('go-back-btn');
    if (goBackBtn) {
        goBackBtn.addEventListener('click', () => {
            console.log("Go Back clicked - Redirecting to Google");
            // Redirect to Google to avoid loops
            window.location.href = 'https://www.google.com';
        });
    }

    function closeOrRedirect() {
        console.log("Attempting to close or redirect...");
        // Try to close the tab using Chrome API
        if (chrome && chrome.tabs) {
            chrome.tabs.getCurrent((tab) => {
                if (tab) {
                    chrome.tabs.remove(tab.id);
                } else {
                    // Fallback
                    window.close();
                }
            });
        } else {
            window.close();
            window.location.href = 'chrome://newtab';
        }
    }
});
