const SUPABASE_URL = 'https://puhutwfwaxohanpbsmtd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB1aHV0d2Z3YXhvaGFucGJzbXRkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjA2MjU4OTAsImV4cCI6MjA3NjIwMTg5MH0.K--sv4BJ52W4wui2lDkBlTcIw6RZN7xFvod4DPz42B8';
// const backendUrlBase = 'https://chrometest.onrender.com';
const backendUrlBase = 'http://localhost:3000'; // Use local backend for development

// --- OAuth Handler ---
document.getElementById('googleLogin').addEventListener('click', async () => {
    const errorDiv = document.getElementById('error');
    errorDiv.style.display = 'none';

    try {
        const redirectUrl = chrome.identity.getRedirectURL();
        const authUrl = `${SUPABASE_URL}/auth/v1/authorize?provider=google&redirect_to=${redirectUrl}`;

        console.log("Launching OAuth flow:", authUrl);

        chrome.identity.launchWebAuthFlow({
            url: authUrl,
            interactive: true
        }, async (redirectedTo) => {
            if (chrome.runtime.lastError) {
                console.error(chrome.runtime.lastError);
                errorDiv.textContent = "Login canceled or failed.";
                errorDiv.style.display = 'block';
                return;
            }

            if (redirectedTo) {
                console.log("OAuth Success. Redirected to:", redirectedTo);

                // Parse the URL fragment (hash)
                const url = new URL(redirectedTo);
                const params = new URLSearchParams(url.hash.substring(1)); // remove #
                const accessToken = params.get('access_token');
                const refreshToken = params.get('refresh_token');

                if (accessToken) {
                    await handleLoginSuccess(accessToken);
                } else {
                    errorDiv.textContent = "No access token found.";
                    errorDiv.style.display = 'block';
                }
            }
        });
    } catch (err) {
        console.error("OAuth Error:", err);
        errorDiv.textContent = err.message;
        errorDiv.style.display = 'block';
    }
});

// --- Forgot Password Handler ---
document.getElementById('forgotPassword').addEventListener('click', async (e) => {
    e.preventDefault();
    const email = document.getElementById('email').value;
    const errorDiv = document.getElementById('error');

    errorDiv.style.display = 'none';

    if (!email) {
        errorDiv.textContent = "Please enter your email address first.";
        errorDiv.style.display = 'block';
        return;
    }

    const originalText = e.target.textContent;
    e.target.textContent = "Sending...";
    e.target.style.pointerEvents = "none";

    try {
        const response = await fetch(`${SUPABASE_URL}/auth/v1/recover`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'apikey': SUPABASE_ANON_KEY
            },
            body: JSON.stringify({ email })
        });

        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.msg || data.error_description || data.error || "Failed to send reset email");
        }

        const successDiv = document.getElementById('success');
        successDiv.textContent = `Password reset email sent to ${email}. Please check your inbox.`;
        successDiv.style.display = 'block';

    } catch (err) {
        console.error("Recovery Error:", err);
        errorDiv.textContent = err.message;
        errorDiv.style.display = 'block';
    } finally {
        e.target.textContent = originalText;
        e.target.style.pointerEvents = "auto";
    }
});

// --- Auth Mode Toggle ---
let isSignUpMode = false;
const toggleLink = document.getElementById('toggleAuthMode');
const toggleText = document.getElementById('toggleText');
const submitBtn = document.getElementById('submitBtn');
const formTitle = document.querySelector('h1'); // Assuming h1 is "Beacon Blocker" - maybe we change subtitle?
const subtitle = document.querySelector('.subtitle');
const forgotPasswordLink = document.getElementById('forgotPassword');
const generatePasswordBtn = document.getElementById('generatePassword');
const container = document.querySelector('.container');

toggleLink.addEventListener('click', (e) => {
    e.preventDefault();
    isSignUpMode = !isSignUpMode;
    document.body.classList.toggle('signup-mode', isSignUpMode);

    if (isSignUpMode) {
        // Sign Up Mode Text
        submitBtn.textContent = 'Sign Up';
        toggleText.textContent = 'Already have an account?';
        toggleLink.textContent = 'Log In';
        subtitle.textContent = 'Create an account to start blocking';

        forgotPasswordLink.style.display = 'none';
        generatePasswordBtn.style.display = 'block';
        passwordInput.setAttribute('autocomplete', 'new-password');
    } else {
        // Login Mode Text
        submitBtn.textContent = 'Log In';
        toggleText.textContent = "Don't have an account?";
        toggleLink.textContent = 'Sign Up';
        subtitle.textContent = 'Sign in to sync your focus rules';

        forgotPasswordLink.style.display = 'inline';
        generatePasswordBtn.style.display = 'none';
        passwordInput.setAttribute('autocomplete', 'current-password');
    }
});

// --- Password Features ---
const passwordInput = document.getElementById('password');
const togglePasswordBtn = document.getElementById('togglePassword');

togglePasswordBtn.addEventListener('click', () => {
    const type = passwordInput.getAttribute('type') === 'password' ? 'text' : 'password';
    passwordInput.setAttribute('type', type);
    togglePasswordBtn.textContent = type === 'password' ? 'Show' : 'Hide';
});

generatePasswordBtn.addEventListener('click', () => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+';
    let password = '';
    for (let i = 0; i < 16; i++) {
        password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    passwordInput.value = password;
    passwordInput.setAttribute('type', 'text'); // Show generated password
    togglePasswordBtn.textContent = 'Hide';
});

// --- Email Auth Handler ---
document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;
    const errorDiv = document.getElementById('error');

    errorDiv.style.display = 'none';

    // --- Client-Side Validation ---
    if (isSignUpMode) {
        if (password.length < 6) {
            errorDiv.textContent = "Password must be at least 6 characters long.";
            errorDiv.style.display = 'block';
            return;
        }
    }

    submitBtn.disabled = true;
    submitBtn.textContent = isSignUpMode ? 'Signing up...' : 'Logging in...';

    try {
        let response, data;

        if (isSignUpMode) {
            // --- SIGN UP FLOW ---

            // 1. Try to Log In first (Smart Duplicate Detection)
            // If the user already exists and entered the correct password, just log them in!
            try {
                const loginResponse = await fetch(`${backendUrlBase}/login`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, password })
                });

                if (loginResponse.ok) {
                    const loginData = await loginResponse.json();
                    if (loginData.session?.access_token) {
                        console.log("Auto-login successful during signup");
                        await handleLoginSuccess(loginData.session.access_token);
                        return;
                    }
                }
            } catch (ignore) {
                // Login failed, proceed to actual signup
            }

            // 2. Proceed to Sign Up
            response = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': SUPABASE_ANON_KEY
                },
                body: JSON.stringify({ email, password })
            });
        } else {
            // --- LOGIN FLOW ---
            response = await fetch(`${backendUrlBase}/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password })
            });
        }

        data = await response.json();
        console.log("Signup Response Data:", data);

        if (!response.ok) {
            throw new Error(data.error || data.msg || data.error_description || 'Authentication failed');
        }

        // --- DUPLICATE DETECTION (Timestamp Check) ---
        // If Supabase returns a user object for signup, check if it's an existing user
        // by comparing created_at with current time.
        if (isSignUpMode && data.created_at) {
            const createdAt = new Date(data.created_at).getTime();
            const now = Date.now();
            const diff = now - createdAt;
            console.log("Duplicate Check:", { createdAt: data.created_at, now, diff });

            // If account was created more than 30 seconds ago, it's an existing account
            if (diff > 30000) {
                console.warn("Existing user detected! Throwing error.");
                throw new Error("User already registered");
            }
        }

        if (isSignUpMode && !data.session && !data.access_token) {
            // Handle case where email confirmation is required
            const successDiv = document.getElementById('success');
            successDiv.innerHTML = `<strong>Account created!</strong><br>Please check your email to confirm your account before logging in.`;
            successDiv.style.display = 'block';

            // Switch back to login mode
            toggleLink.click();
            return;
        }

        // Handle success (Login returns session in different structure than raw Supabase signup sometimes, but backend /login normalizes it. 
        // If using raw Supabase signup, data structure is { access_token, ... } or { session: { access_token ... } }
        // Let's normalize.
        const token = data.session?.access_token || data.access_token;

        if (token) {
            await handleLoginSuccess(token, email);
        } else {
            // Should verify email
            const successDiv = document.getElementById('success');
            successDiv.innerHTML = `<strong>Please check your email</strong><br>to confirm your account.`;
            successDiv.style.display = 'block';
            toggleLink.click();
        }

    } catch (err) {
        console.error("Auth Error:", err);
        let msg = err.message || JSON.stringify(err);

        // Improve Supabase error messages
        // Supabase often returns "User already registered" in the message body
        if (msg.includes("User already registered") || msg.includes("already registered") || msg.includes("duplicate key")) {
            msg = "This email is already registered. Please log in instead.";
        } else if (msg.includes("Invalid login credentials")) {
            msg = "Incorrect email or password.";
        } else if (msg.includes("over_email_send_rate_limit")) {
            msg = "Too many attempts. Please wait a minute before trying again.";
        }

        errorDiv.textContent = msg;
        errorDiv.style.display = 'block';
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = isSignUpMode ? 'Sign Up' : 'Log In';
    }
});

async function handleLoginSuccess(token, providedEmail = null) {
    let email = providedEmail;

    // If email not provided, try to fetch it from Supabase
    if (!email) {
        try {
            const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'apikey': SUPABASE_ANON_KEY
                }
            });
            if (response.ok) {
                const userData = await response.json();
                email = userData.email;
            }
        } catch (e) {
            console.error("Failed to fetch user email:", e);
        }
    }

    // Save token AND email
    await chrome.storage.local.set({ authToken: token, userEmail: email });

    // Notify background script
    chrome.runtime.sendMessage({ type: 'AUTH_SUCCESS' });

    const container = document.querySelector('.container');
    container.innerHTML = `
        <div style="text-align: center;">
            <div style="color: #15803d; font-size: 3rem; margin-bottom: 1rem;">✅</div>
            <h2 style="color: #15803d; margin-bottom: 0.5rem;">Login Successful!</h2>
            <p style="color: #64748b; margin-bottom: 0.5rem;">Logged in as: <strong>${email || 'User'}</strong></p>
            <p style="color: #64748b; margin-bottom: 1.5rem;">Redirecting to your dashboard...</p>
            <div class="spinner" style="border: 4px solid #f3f3f3; border-top: 4px solid #2563eb; border-radius: 50%; width: 30px; height: 30px; animation: spin 1s linear infinite; margin: 0 auto;"></div>
        </div>
        <style>
            @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        </style>
    `;

    // Auto-redirect after 1.5 seconds
    setTimeout(() => {
        // Open Dashboard using Chrome API (more robust than window.open)
        chrome.tabs.create({ url: 'http://localhost:5173' }, () => {
            // Close Login Window after tab is created
            window.close();
        });
    }, 1500);
}
