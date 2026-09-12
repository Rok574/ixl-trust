// =====================================================
// CONFIGURATION
// =====================================================
const DEFAULT_WISP = window.SITE_CONFIG?.defaultWisp ?? "wss://anura.pro/";
const WISP_SERVERS = window.SITE_CONFIG?.wispServers ?? [
    { name: "Anura", url: "wss://anura.pro/" },
    { name: "Fern", url: "wss://fern.best/" },
    { name: "Mercury", url: "wss://wisp.mercurywork.shop/" },
    { name: "Tomp", url: "wss://wisp.tomp.app/" },
    { name: "Incognito", url: "wss://wisp.incognito.dev/" },
    { name: "Flow Works", url: "wss://wisp.flow-works.me/" },
    { name: "Riley Wisp", url: "wss://wisp.ryzenmn.us/wisp/" },
    { name: "Alu Wisp", url: "wss://aluu.xyz/wisp/" },
];

// Transport fallback chain. Epoxy (fast TLS) first, libcurl second — both
// speak WISP, but different TLS stacks succeed on different sites/networks.
// Each entry: { id, url, args(wispUrl) }.
const TRANSPORTS = [
    {
        id: "epoxy-jsdelivr",
        url: "https://cdn.jsdelivr.net/npm/@mercuryworkshop/epoxy-transport@2.1.28/dist/index.mjs",
        args: (wisp) => [{ wisp }],
    },
    {
        id: "epoxy-unpkg",
        url: "https://unpkg.com/@mercuryworkshop/epoxy-transport@2.1.28/dist/index.mjs",
        args: (wisp) => [{ wisp }],
    },
    {
        id: "libcurl",
        url: "https://cdn.jsdelivr.net/npm/@mercuryworkshop/libcurl-transport@1.5.0/dist/index.mjs",
        args: (wisp) => [{ websocket: wisp }],
    },
];

const SEARCH_ENGINES = {
    brave: { name: "Brave", url: "https://search.brave.com/search?q=" },
    duckduckgo: { name: "DuckDuckGo", url: "https://duckduckgo.com/?q=" },
    google: { name: "Google", url: "https://www.google.com/search?q=" },
    bing: { name: "Bing", url: "https://www.bing.com/search?q=" },
    qwant: { name: "Qwant", url: "https://www.qwant.com/?q=" },
};

const CLOAK_PRESETS = {
    ixl: { name: "IXL", title: "IXL | Math, Language Arts, Science, Social Studies, and Spanish", icon: "https://ixl.com/ixl-favicon.png" },
    classroom: { name: "Google Classroom", title: "Home", icon: "https://ssl.gstatic.com/classroom/favicon.png" },
    drive: { name: "Google Drive", title: "My Drive - Google Drive", icon: "https://ssl.gstatic.com/images/branding/product/1x/drive_2020q4_32dp.png" },
    docs: { name: "Google Docs", title: "Google Docs", icon: "https://ssl.gstatic.com/docs/documents/images/kix-favicon-7.gif" },
    blank: { name: "Blank", title: "New Tab", icon: "" },
};

// Generic settings store (all persisted in localStorage)
const getSetting = (key, fallback) => {
    try {
        const v = localStorage.getItem(key);
        return v === null ? fallback : JSON.parse(v);
    } catch { return fallback; }
};
const setSetting = (key, value) => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
};
const getSearchEngine = () => SEARCH_ENGINES[getSetting("searchEngine", "brave")] ?? SEARCH_ENGINES.brave;

// Per-server real-traffic stats: { emaMs, ok, fail, lastOk }
// Used for latency-aware routing on top of raw WebSocket pings.
const transportStats = new Map();
function recordFetchResult(wispUrl, ok, latencyMs) {
    let s = transportStats.get(wispUrl);
    if (!s) { s = { emaMs: null, ok: 0, fail: 0, lastOk: 0 }; transportStats.set(wispUrl, s); }
    if (ok) {
        s.ok++;
        s.lastOk = Date.now();
        s.emaMs = s.emaMs === null ? latencyMs : s.emaMs * 0.7 + latencyMs * 0.3;
    } else {
        s.fail++;
    }
}
function scoreServer(url, pingLatency) {
    const s = transportStats.get(url);
    const fails = s?.fail ?? 0;
    const oks = s?.ok ?? 0;
    // Heavy penalty for failing servers, mild preference for proven-fast ones.
    const base = pingLatency ?? 1500;
    const ema = s?.emaMs ?? base;
    return ema * 0.6 + base * 0.4 + fails * 750 - Math.min(oks * 5, 200);
}

// Initialize default proxy server if not set
if (!localStorage.getItem("proxServer")) {
    localStorage.setItem("proxServer", DEFAULT_WISP);
}
// Migrate away from removed servers (e.g. AnuraOS Wisp)
const REMOVED_WISPS = ["wss://anura.pro/wisp/"];
if (REMOVED_WISPS.includes(localStorage.getItem("proxServer"))) {
    localStorage.setItem("proxServer", DEFAULT_WISP);
}

// Helper to get all servers (config + custom)
function getAllWispServers() {
    const customWisps = getStoredWisps();
    return [...WISP_SERVERS, ...customWisps];
}

// =====================================================
// PROACTIVE SERVER HEALTH CHECKING
// =====================================================

// Ping a wisp server to check if it's responsive
async function pingWispServer(url, timeout = 2000) {
    return new Promise((resolve) => {
        const start = Date.now();
        try {
            const ws = new WebSocket(url);
            const timer = setTimeout(() => {
                try { ws.close(); } catch {}
                resolve({ url, success: false, latency: null });
            }, timeout);

            ws.onopen = () => {
                clearTimeout(timer);
                const latency = Date.now() - start;
                try { ws.close(); } catch {}
                resolve({ url, success: true, latency });
            };

            ws.onerror = () => {
                clearTimeout(timer);
                try { ws.close(); } catch {}
                resolve({ url, success: false, latency: null });
            };
        } catch {
            resolve({ url, success: false, latency: null });
        }
    });
}

// Find the best (fastest working) server from the list.
// Combines live WebSocket pings with real fetch-traffic stats.
async function findBestWispServer(servers, currentUrl) {
    if (!servers || servers.length === 0) return currentUrl;

    const preferred = getSetting("transport", "auto");
    // When user pinned a transport, still pick best server via ping.
    const results = await Promise.all(
        servers.map(s => pingWispServer(s.url, 2000))
    );

    const working = results
        .filter(r => r.success)
        .sort((a, b) => scoreServer(a.url, a.latency) - scoreServer(b.url, b.latency));

    if (working.length > 0) {
        return working[0].url;
    }

    // If none working, return current or first
    return currentUrl || servers[0]?.url;
}

// Proactively check and switch to best server on init
async function initializeWithBestServer() {
    const autoswitch = localStorage.getItem('wispAutoswitch') !== 'false';
    const allServers = getAllWispServers();

    if (!autoswitch || allServers.length <= 1) {
        return;
    }

    const currentUrl = localStorage.getItem("proxServer") || DEFAULT_WISP;
    
    // Check if current server is working, if not find a better one
    const currentCheck = await pingWispServer(currentUrl, 2000);
    
    if (currentCheck.success) {
        console.log("Init: Current server is working:", currentUrl, currentCheck.latency + "ms");
        return;
    }

    // Current server is bad, find the fastest working server
    console.log("Init: Current server not responding, finding better server...");
    const best = await findBestWispServer(allServers, currentUrl);
    
    if (best && best !== currentUrl) {
        console.log("Init: Auto-switching to faster server:", best);
        localStorage.setItem("proxServer", best);
        const serverName = allServers.find(s => s.url === best)?.name || 'Faster Server';
        notify('info', 'Auto-switched', `Using ${serverName} for best performance`);
    }
}

// =====================================================
// BROWSER STATE
// =====================================================
// Wait for the BareMux ESM module (loaded in index.html) instead of
// falling back to a dummy that silently breaks all proxying.
function getBareMux() {
    if (window.BareMux?.BareMuxConnection) return Promise.resolve(window.BareMux);
    if (window.BareMuxReady) return window.BareMuxReady.then(() => window.BareMux);
    return new Promise((resolve) => {
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            resolve(window.BareMux);
        };
        window.addEventListener("baremux-ready", finish, { once: true });
        // Poll as a fallback in case the event fired before we listened.
        const iv = setInterval(() => {
            if (window.BareMux?.BareMuxConnection) {
                clearInterval(iv);
                finish();
            }
        }, 50);
        // Give up after 10s — caller will throw a clear error.
        setTimeout(() => { clearInterval(iv); finish(); }, 10000);
    });
}

// SINGLETON: Shared resources for all tabs (prevents connection exhaustion)
let sharedScramjet = null;
let sharedConnection = null;
let sharedConnectionReady = false;
let activeTransportId = null;

// Try each transport in order until one accepts setTransport().
async function setTransportWithFallback(connection, wispUrl) {
    const preferred = getSetting("transport", "auto");
    const ordered = preferred === "auto"
        ? TRANSPORTS
        : [...TRANSPORTS.filter(t => t.id === preferred), ...TRANSPORTS.filter(t => t.id !== preferred)];
    let lastErr = null;
    for (const t of ordered) {
        try {
            await connection.setTransport(t.url, t.args(wispUrl));
            activeTransportId = t.id;
            console.log(`Transport ready: ${t.id} via ${wispUrl}`);
            return t.id;
        } catch (err) {
            lastErr = err;
            console.warn(`Transport ${t.id} failed, trying next:`, err?.message || err);
        }
    }
    throw lastErr || new Error("All transports failed.");
}

let tabs = [];
let activeTabId = null;
let nextTabId = 1;

// =====================================================
// UTILITIES
// =====================================================
const getBasePath = () => {
    const basePath = location.pathname.replace(/[^/]*$/, '');
    return basePath.endsWith('/') ? basePath : basePath + '/';
};

const getStoredWisps = () => {
    try { return JSON.parse(localStorage.getItem('customWisps') ?? '[]'); }
    catch { return []; }
};

const getActiveTab = () => tabs.find(t => t.id === activeTabId);

// Toast notifications (replaces missing Notify dependency)
function ensureToastContainer() {
    let c = document.getElementById("toast-container");
    if (!c) {
        c = document.createElement("div");
        c.id = "toast-container";
        document.body.appendChild(c);
    }
    return c;
}
const notify = (type, title, message) => {
    try {
        if (typeof Notify !== "undefined" && Notify[type]) { Notify[type](title, message); return; }
        const c = ensureToastContainer();
        const el = document.createElement("div");
        el.className = `toast toast-${type || "info"}`;
        el.innerHTML = `<div class="toast-title"></div><div class="toast-msg"></div>`;
        el.querySelector(".toast-title").textContent = title || "";
        el.querySelector(".toast-msg").textContent = message || "";
        c.appendChild(el);
        setTimeout(() => el.classList.add("show"), 10);
        setTimeout(() => { el.classList.remove("show"); setTimeout(() => el.remove(), 300); }, 3600);
        while (c.children.length > 4) c.firstChild.remove();
    } catch {}
};

// Connection status pill in the nav bar
function updateConnectionStatus(state, latencyMs) {
    const pill = document.getElementById("conn-status");
    if (!pill) return;
    const dot = pill.querySelector(".conn-dot");
    const txt = pill.querySelector(".conn-text");
    pill.dataset.state = state;
    if (dot) dot.className = `conn-dot conn-${state}`;
    if (txt) {
        const transport = activeTransportId ? ` · ${activeTransportId.split("-")[0]}` : "";
        txt.textContent = state === "online"
            ? (latencyMs != null ? `${latencyMs}ms${transport}` : `online${transport}`)
            : state === "switching" ? "switching…" : "offline";
    }
    pill.title = `Proxy: ${localStorage.getItem("proxServer") || DEFAULT_WISP}${activeTransportId ? ` (${activeTransportId})` : ""}`;
}

// =====================================================
// INITIALIZATION
// =====================================================
async function getSharedScramjet() {
    if (sharedScramjet) return sharedScramjet;

    if (typeof $scramjetLoadController !== "function") {
        throw new Error("Scramjet CDN failed to load ($scramjetLoadController missing).");
    }
    const basePath = getBasePath();
    const { ScramjetController } = $scramjetLoadController();
    
    sharedScramjet = new ScramjetController({
        prefix: basePath + "scramjet/",
        files: {
            wasm: "https://cdn.jsdelivr.net/gh/Destroyed12121/Staticsj@main/JS/scramjet.wasm.wasm",
            all: "https://cdn.jsdelivr.net/gh/Destroyed12121/Staticsj@main/JS/scramjet.all.js",
            sync: "https://cdn.jsdelivr.net/gh/Destroyed12121/Staticsj@main/JS/scramjet.sync.js"
        },
        // Compatibility flags: keep rewrites lenient so heavy apps
        // (Discord, YouTube, Spotify) don't hard-crash on edge JS.
        flags: {
            strictRewrites: false,
            captureErrors: true,
            cleanErrors: true,
            allowInvalidJs: true,
            allowFailedIntercepts: true,
            interceptDownloads: true,
            syncxhr: false,
            serviceworkers: true,
            sourcemaps: false,
        },
        siteFlags: {
            "discord\\.com": { syncxhr: true, serviceworkers: false },
            "youtube\\.com": { sourcemaps: false, serviceworkers: false },
            "spotify\\.com": { serviceworkers: false },
            "netflix\\.com": { serviceworkers: false },
        },
    });
    
    try {
        await sharedScramjet.init();
    } catch (err) {
        // Handle IndexedDB schema errors by clearing cache and retrying
        const msg = String(err?.message || "");
        if (msg.includes('IDBDatabase') || msg.includes('object stores')) {
            console.warn('Scramjet IndexedDB error, clearing cache and retrying...');
            
            // Clear IndexedDB for Scramjet
            try {
                const dbNames = ['scramjet-data', 'scrambase', 'ScramjetData'];
                for (const dbName of dbNames) {
                    const req = indexedDB.deleteDatabase(dbName);
                    req.onsuccess = () => console.log(`Cleared IndexedDB: ${dbName}`);
                    req.onerror = () => console.warn(`Failed to clear IndexedDB: ${dbName}`);
                }
            } catch (clearErr) {
                console.warn('Failed to clear IndexedDB:', clearErr);
            }
            
            // Reset shared instance and retry
            sharedScramjet = null;
            return getSharedScramjet();
        }
        throw err;
    }
    
    return sharedScramjet;
}

async function getSharedConnection() {
    if (sharedConnectionReady) return sharedConnection;

    const BareMux = await getBareMux();
    if (!BareMux?.BareMuxConnection) {
        throw new Error("BareMux failed to load. Check network / CDN access.");
    }

    const basePath = getBasePath();
    const wispUrl = localStorage.getItem("proxServer") ?? DEFAULT_WISP;
    
    sharedConnection = new BareMux.BareMuxConnection(basePath + "bareworker.js");
    await setTransportWithFallback(sharedConnection, wispUrl);
    sharedConnectionReady = true;
    updateConnectionStatus("online", null);
    return sharedConnection;
}

// Live reconnect to a different WISP without a full page reload.
// Falls back to reload if the live swap fails.
async function reconnectTransport(newWispUrl) {
    const wispUrl = newWispUrl || localStorage.getItem("proxServer") || DEFAULT_WISP;
    try {
        if (sharedConnection) {
            await setTransportWithFallback(sharedConnection, wispUrl);
        }
        navigator.serviceWorker.controller?.postMessage({ type: "config", wispurl: wispUrl });
        // Also tell the SW to drop its cached Bare client so it reconnects.
        navigator.serviceWorker.controller?.postMessage({ type: "reconnect", wispurl: wispUrl });
        updateConnectionStatus("online", null);
        return true;
    } catch (err) {
        console.warn("Live reconnect failed, will reload:", err);
        return false;
    }
}

async function initializeBrowser() {
    applyTheme();
    applyCloak();
    const root = document.getElementById("app");
    if (!root) throw new Error("#app container missing.");
    root.innerHTML = `
        <div class="browser-container">
            <div class="flex tabs" id="tabs-container"></div>
            <div class="flex nav">
                <button id="back-btn" title="Back (Alt+Left)"><i class="fa-solid fa-chevron-left"></i></button>
                <button id="fwd-btn" title="Forward (Alt+Right)"><i class="fa-solid fa-chevron-right"></i></button>
                <button id="reload-btn" title="Reload (Ctrl+R)"><i class="fa-solid fa-rotate-right"></i></button>
                <button id="home-btn-top" title="New Tab home"><i class="fa-solid fa-house"></i></button>
                <div class="address-wrapper">
                    <input class="bar" id="address-bar" autocomplete="off" placeholder="Search or enter URL">
                    <button id="bookmark-star" title="Bookmark this page"><i class="fa-regular fa-star"></i></button>
                </div>
                <div id="conn-status" class="conn-pill" data-state="switching" title="Proxy status"><span class="conn-dot conn-switching"></span><span class="conn-text">…</span></div>
                <button id="history-btn" title="History"><i class="fa-solid fa-clock-rotate-left"></i></button>
                <button id="cloak-btn" title="Open cloaked (about:blank)"><i class="fa-solid fa-eye-low-vision"></i></button>
                <button id="devtools-btn" title="DevTools"><i class="fa-solid fa-code"></i></button>
                <button id="wisp-settings-btn" title="Settings"><i class="fa-solid fa-gear"></i></button>
            </div>
            <div id="bookmarks-bar" class="bookmarks-bar" style="display:none"></div>
            <div class="loading-bar-container"><div class="loading-bar" id="loading-bar"></div></div>
            <div class="iframe-container" id="iframe-container">
                <div id="error" class="message-container" style="display: none;">
                    <div class="message-content">
                        <h1>Connection Error</h1>
                        <p id="error-message">An error occurred.</p>
                        <div class="error-actions">
                            <button id="retry-btn">Retry</button>
                            <button id="switch-server-btn">Try another server</button>
                        </div>
                    </div>
                </div>
            </div>
            <div id="history-modal" class="mini-modal hidden">
                <div class="mini-card">
                    <div class="mini-header"><span>History</span><div><button id="clear-history">Clear</button><button id="close-history">✕</button></div></div>
                    <input id="history-search" placeholder="Search history…">
                    <div id="history-list"></div>
                </div>
            </div>
        </div>`;

    // Cache DOM elements
    const elements = {
        backBtn: document.getElementById('back-btn'),
        fwdBtn: document.getElementById('fwd-btn'),
        reloadBtn: document.getElementById('reload-btn'),
        addrBar: document.getElementById('address-bar'),
    };

    // Bind navigation events
    elements.backBtn.onclick = () => getActiveTab()?.frame.back();
    elements.fwdBtn.onclick = () => getActiveTab()?.frame.forward();
    elements.reloadBtn.onclick = () => getActiveTab()?.frame.reload();
    const goHome = () => {
        const tab = getActiveTab();
        if (!tab) return;
        tab.loading = true;
        showIframeLoading(true, "New Tab");
        showErrorBox(false);
        try { tab.frame.go("about:blank"); } catch {}
        tab.url = "NT.html";
        tab.title = "New Tab";
        tab.favicon = null;
        tab.loading = false;
        showIframeLoading(false);
        // Reset the frame to the local new-tab page (not proxied).
        tab.frame.frame.src = getBasePath() + "NT.html";
        updateTabsUI();
        updateAddressBar();
        saveSession();
    };
    document.getElementById('home-btn-top').onclick = goHome;
    document.getElementById('bookmark-star').onclick = () => toggleBookmarkCurrent();
    document.getElementById('history-btn').onclick = openHistory;
    document.getElementById('cloak-btn').onclick = openCloaked;
    document.getElementById('conn-status').onclick = async () => {
        // Click status pill = fastest-server re-check + live reconnect.
        updateConnectionStatus("switching", null);
        const best = await findBestWispServer(getAllWispServers(), localStorage.getItem("proxServer"));
        if (best) {
            localStorage.setItem("proxServer", best);
            await reconnectTransport(best);
            syncSwConfig();
        }
        const st = transportStats.get(localStorage.getItem("proxServer"));
        updateConnectionStatus("online", st?.emaMs != null ? Math.round(st.emaMs) : null);
    };
    document.getElementById('close-history').onclick = () => document.getElementById('history-modal').classList.add('hidden');
    document.getElementById('clear-history').onclick = () => { localStorage.removeItem('proxyHistory'); renderHistory(""); };
    document.getElementById('history-search').oninput = (e) => renderHistory(e.target.value);
    document.getElementById('retry-btn').onclick = () => { const t = getActiveTab(); if (t && t.url) handleSubmit(t.url); };
    document.getElementById('switch-server-btn').onclick = async () => {
        showErrorBox(false);
        const best = await findBestWispServer(getAllWispServers(), localStorage.getItem("proxServer"));
        if (best) { localStorage.setItem("proxServer", best); await reconnectTransport(best); syncSwConfig(); }
        const t = getActiveTab(); if (t && t.url) handleSubmit(t.url);
    };
    document.getElementById('devtools-btn').onclick = toggleDevTools;
    document.getElementById('wisp-settings-btn').onclick = openSettings;

    // Address bar events
    elements.addrBar.onkeyup = (e) => e.key === 'Enter' && handleSubmit();
    elements.addrBar.onfocus = () => elements.addrBar.select();

    // Handle navigation messages
    window.addEventListener('message', (e) => {
        if (e.data?.type === 'navigate') handleSubmit(e.data.url);
    });

    bindGlobalShortcuts();
    bindPanicKey();
    renderBookmarksBar();

    // Session restore: reopen last session's tabs, else fresh tab.
    const restored = restoreSession();
    if (!restored) createTab(true);
    checkHashParameters();
    updateConnectionStatus("online", null);
}

// =====================================================
// HISTORY / BOOKMARKS / SESSION / CLOAK / THEME
// =====================================================
function showErrorBox(show, msg) {
    const box = document.getElementById("error");
    if (!box) return;
    box.style.display = show ? "flex" : "none";
    if (show && msg) {
        const m = document.getElementById("error-message");
        if (m) m.textContent = msg;
    }
    if (show) showIframeLoading(false);
}

function recordHistory(url, title) {
    try {
        if (!url || url.includes("NT.html") || url === "about:blank") return;
        const h = JSON.parse(localStorage.getItem("proxyHistory") || "[]");
        h.unshift({ url, title: title || url, t: Date.now() });
        localStorage.setItem("proxyHistory", JSON.stringify(h.slice(0, 300)));
    } catch {}
}
function openHistory() {
    document.getElementById('history-modal').classList.remove('hidden');
    const s = document.getElementById('history-search');
    if (s) s.value = "";
    renderHistory("");
}
function renderHistory(filter) {
    const list = document.getElementById("history-list");
    if (!list) return;
    const q = (filter || "").toLowerCase();
    let h = [];
    try { h = JSON.parse(localStorage.getItem("proxyHistory") || "[]"); } catch {}
    list.innerHTML = "";
    h.filter(e => !q || e.url.toLowerCase().includes(q) || (e.title || "").toLowerCase().includes(q))
     .slice(0, 80).forEach(e => {
        const row = document.createElement("div");
        row.className = "hist-row";
        const b = document.createElement("button");
        b.className = "hist-go";
        b.textContent = e.title || e.url;
        b.title = e.url;
        b.onclick = () => { document.getElementById('history-modal').classList.add('hidden'); handleSubmit(e.url); };
        const del = document.createElement("button");
        del.className = "hist-del";
        del.textContent = "✕";
        del.onclick = () => {
            const all = JSON.parse(localStorage.getItem("proxyHistory") || "[]").filter(x => x.url !== e.url || x.t !== e.t);
            localStorage.setItem("proxyHistory", JSON.stringify(all));
            renderHistory(document.getElementById('history-search')?.value || "");
        };
        row.appendChild(b); row.appendChild(del);
        list.appendChild(row);
    });
    if (!list.children.length) list.innerHTML = `<div class="hist-empty">No history yet.</div>`;
}

function getBookmarks() {
    try { return JSON.parse(localStorage.getItem("bookmarks") || "[]"); } catch { return []; }
}
function toggleBookmarkCurrent() {
    const tab = getActiveTab();
    if (!tab || !tab.url || tab.url.includes("NT.html")) { notify("warning", "Nothing to bookmark", "Navigate somewhere first."); return; }
    const marks = getBookmarks();
    const i = marks.findIndex(m => m.url === tab.url);
    if (i >= 0) { marks.splice(i, 1); notify("info", "Bookmark removed", tab.title); }
    else { marks.unshift({ url: tab.url, title: tab.title || tab.url }); notify("success", "Bookmarked", tab.title); }
    localStorage.setItem("bookmarks", JSON.stringify(marks.slice(0, 100)));
    renderBookmarksBar(); updateAddressBar();
}
function renderBookmarksBar() {
    const bar = document.getElementById("bookmarks-bar");
    if (!bar) return;
    const marks = getBookmarks();
    bar.style.display = marks.length ? "flex" : "none";
    bar.innerHTML = "";
    marks.slice(0, 20).forEach(m => {
        const b = document.createElement("button");
        b.className = "bm-item";
        b.title = m.url;
        b.textContent = m.title || m.url;
        b.onclick = () => handleSubmit(m.url);
        b.oncontextmenu = (e) => {
            e.preventDefault();
            localStorage.setItem("bookmarks", JSON.stringify(getBookmarks().filter(x => x.url !== m.url)));
            renderBookmarksBar();
        };
        bar.appendChild(b);
    });
}

let sessionTimer = null;
function saveSession() {
    clearTimeout(sessionTimer);
    sessionTimer = setTimeout(() => {
        try {
            const urls = tabs.map(t => t.url).filter(u => u && !u.includes("NT.html") && u !== "about:blank").slice(0, 10);
            localStorage.setItem("proxySession", JSON.stringify({ urls, active: getActiveTab()?.url || null }));
        } catch {}
    }, 500);
}
function restoreSession() {
    try {
        if (!getSetting("restoreSession", true)) return false;
        const s = JSON.parse(localStorage.getItem("proxySession") || "null");
        if (!s || !s.urls || !s.urls.length) return false;
        s.urls.forEach((u, i) => {
            const t = createTab(i === 0);
            if (t && i > 0) { /* navigate after creation */ setTimeout(() => { const tab = tabs.find(x => x.id === t.id); if (tab) { switchTab(t.id); handleSubmit(u); } }, 300 * i); }
            else if (t) handleSubmit(u);
        });
        return true;
    } catch { return false; }
}

function applyTheme() {
    const accent = getSetting("accent", "#3b82f6");
    document.documentElement.style.setProperty("--accent", accent);
    // Keep the toggle knob readable on light accents (e.g. white):
    // dark knob on light track, white knob on dark track.
    document.documentElement.style.setProperty("--toggle-knob", isLightColor(accent) ? "#0a0a0a" : "#ffffff");
}
function isLightColor(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
    if (!m) return false;
    const n = parseInt(m[1], 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    // Relative luminance heuristic
    return (0.299 * r + 0.587 * g + 0.114 * b) > 150;
}
function applyCloak() {
    const preset = CLOAK_PRESETS[getSetting("cloak", "ixl")] || CLOAK_PRESETS.ixl;
    const customTitle = getSetting("cloakTitle", null);
    const customIcon = getSetting("cloakIcon", null);
    document.title = customTitle || preset.title;
    let link = document.querySelector("link[rel='icon']");
    const icon = customIcon || preset.icon;
    if (icon) {
        if (!link) { link = document.createElement("link"); link.rel = "icon"; document.head.appendChild(link); }
        link.href = icon;
    }
}
function openCloaked() {
    // Classic about:blank cloak: opens a blank page embedding this browser.
    const w = window.open("about:blank", "_blank");
    if (!w) { notify("warning", "Popup blocked", "Allow popups to use cloaked window."); return; }
    w.document.write(`<html><head><title>${escapeHtml(document.title)}</title></head><body style="margin:0"><iframe src="${escapeHtml(location.href)}" style="width:100vw;height:100vh;border:none"></iframe></body></html>`);
    w.document.close();
}
function triggerPanic() {
    const url = getSetting("panicUrl", "https://classroom.google.com");
    try {
        tabs.forEach(t => { try { t.frame.go("about:blank"); } catch {} });
    } catch {}
    window.location.href = url;
}
function bindPanicKey() {
    document.removeEventListener("keydown", panicHandler);
    document.addEventListener("keydown", panicHandler);
}
function panicHandler(e) {
    const key = getSetting("panicKey", "`");
    if (e.key === key && !e.ctrlKey && !e.metaKey && document.activeElement?.tagName !== "INPUT") {
        e.preventDefault();
        triggerPanic();
    }
}
function bindGlobalShortcuts() {
    document.removeEventListener("keydown", shortcutHandler);
    document.addEventListener("keydown", shortcutHandler);
}
function shortcutHandler(e) {
    const inInput = document.activeElement && (document.activeElement.tagName === "INPUT" || document.activeElement.tagName === "TEXTAREA");
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "t") { e.preventDefault(); createTab(true); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "l") { e.preventDefault(); document.getElementById("address-bar")?.focus(); document.getElementById("address-bar")?.select(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "r" && !inInput) { e.preventDefault(); getActiveTab()?.frame.reload(); }
    else if (e.altKey && e.key === "ArrowLeft") { e.preventDefault(); getActiveTab()?.frame.back(); }
    else if (e.altKey && e.key === "ArrowRight") { e.preventDefault(); getActiveTab()?.frame.forward(); }
    else if (e.key === "Escape") {
        document.getElementById('history-modal')?.classList.add('hidden');
        document.getElementById('wisp-settings-modal')?.classList.add('hidden');
    }
}

// Push current prefs to the service worker (adblock, transport, servers).
function syncSwConfig() {
    const msg = {
        type: "config",
        wispurl: localStorage.getItem("proxServer") || DEFAULT_WISP,
        servers: getAllWispServers(),
        autoswitch: localStorage.getItem('wispAutoswitch') !== 'false',
        adblock: getSetting("adblock", true),
        transport: getSetting("transport", "auto"),
    };
    navigator.serviceWorker.controller?.postMessage(msg);
}

// =====================================================
// TAB MANAGEMENT
// =====================================================
function createTab(makeActive = true) {
    if (!sharedScramjet) {
        console.error("createTab called before Scramjet initialized");
        return null;
    }
    const frame = sharedScramjet.createFrame();
    const tab = {
        id: nextTabId++,
        title: "New Tab",
        url: "NT.html",
        frame,
        loading: false,
        favicon: null,
        skipTimeout: null,
        loadStartTime: null
    };

    frame.frame.src = getBasePath() + "NT.html";

    frame.addEventListener("urlchange", (e) => {
        tab.url = e.url;
        tab.loading = true;
        tab.loadStartTime = Date.now();

        if (tab.id === activeTabId) {
            showIframeLoading(true, tab.url);
        }

        try {
            const urlObj = new URL(e.url);
            tab.title = urlObj.hostname;
            tab.favicon = `https://www.google.com/s2/favicons?domain=${urlObj.hostname}&sz=32`;
        } catch {
            tab.title = "Browsing";
            tab.favicon = null;
        }
        
        updateTabsUI();
        updateAddressBar();
        updateLoadingBar(tab, 10);
    });

    frame.frame.addEventListener('load', () => {
        tab.loading = false;
        clearTimeout(tab.skipTimeout);

        if (tab.id === activeTabId) {
            showIframeLoading(false);
        }

        try {
            const title = frame.frame.contentWindow.document.title;
            if (title) tab.title = title;
        } catch { }

        try {
            if (frame.frame.contentWindow.location.href.includes('NT.html')) {
                tab.title = "New Tab";
                tab.url = "";
                tab.favicon = null;
            }
        } catch {}

        // Successful load: history + positive traffic signal + session.
        if (tab.url && !tab.url.includes("NT.html") && tab.url !== "about:blank") {
            recordHistory(tab.url, tab.title);
            const ms = tab.loadStartTime ? Date.now() - tab.loadStartTime : 800;
            recordFetchResult(localStorage.getItem("proxServer") || DEFAULT_WISP, true, ms);
            if (tab.id === activeTabId) updateConnectionStatus("online", ms < 15000 ? Math.round(ms) : null);
        }

        updateTabsUI();
        updateAddressBar();
        updateLoadingBar(tab, 100);
        saveSession();
    });

    tabs.push(tab);
    document.getElementById("iframe-container").appendChild(frame.frame);
    if (makeActive) switchTab(tab.id);
    else { updateTabsUI(); saveSession(); }
    return tab;
}

function duplicateTab(tabId) {
    const src = tabs.find(t => t.id === tabId);
    if (!src) return;
    const t = createTab(true);
    if (t && src.url && !src.url.includes("NT.html")) handleSubmit(src.url);
}

// Loading is shown via the thin top loading bar only — the fullscreen
// "Connecting" overlay (and its iframe blur) stays hidden.
function showIframeLoading(show, url = '') {
    const loader = document.getElementById("loading");
    if (loader) loader.style.display = "none";
    getActiveTab()?.frame.frame.classList.remove('loading');
}

function switchTab(tabId) {
    activeTabId = tabId;
    const tab = getActiveTab();

    tabs.forEach(t => t.frame.frame.classList.toggle("hidden", t.id !== tabId));

    if (tab) {
        showIframeLoading(tab.loading, tab.url);
    }

    updateTabsUI();
    updateAddressBar();
    saveSession();
}

function closeTab(tabId) {
    const idx = tabs.findIndex(t => t.id === tabId);
    if (idx === -1) return;

    const tab = tabs[idx];
    clearTimeout(tab.skipTimeout);
    
    if (tab.frame?.frame) {
        tab.frame.frame.src = 'about:blank';
        tab.frame.frame.remove();
    }
    
    tabs.splice(idx, 1);

    if (activeTabId === tabId) {
        if (tabs.length > 0) switchTab(tabs[Math.max(0, idx - 1)].id);
        else window.location.reload();
    } else {
        updateTabsUI();
    }
    saveSession();
}

function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
}

function updateTabsUI() {
    const container = document.getElementById("tabs-container");
    if (!container) return;
    container.innerHTML = "";

    tabs.forEach(tab => {
        const el = document.createElement("div");
        el.className = `tab ${tab.id === activeTabId ? "active" : ""}`;

        const iconHtml = tab.loading 
            ? `<div class="tab-spinner"></div>`
            : tab.favicon 
                ? `<img src="${escapeHtml(tab.favicon)}" class="tab-favicon" onerror="this.style.display='none'">`
                : '';

        el.innerHTML = `${iconHtml}<span class="tab-title"></span><span class="tab-close">&times;</span>`;
        el.querySelector(".tab-title").textContent = tab.title || "New Tab";
        el.title = `${tab.title || "New Tab"}\n${tab.url || ""}\n(double-click to duplicate)`;
        el.onclick = () => switchTab(tab.id);
        el.ondblclick = (e) => { e.stopPropagation(); duplicateTab(tab.id); };
        el.querySelector(".tab-close").onclick = (e) => { e.stopPropagation(); closeTab(tab.id); };
        container.appendChild(el);
    });

    const newBtn = document.createElement("button");
    newBtn.className = "new-tab";
    newBtn.innerHTML = "<i class='fa-solid fa-plus'></i>";
    newBtn.onclick = () => createTab(true);
    container.appendChild(newBtn);
}

function updateAddressBar() {
    const bar = document.getElementById("address-bar");
    const tab = getActiveTab();
    if (bar && tab) {
        bar.value = (tab.url && !tab.url.includes("NT.html") && tab.url !== "about:blank") ? tab.url : "";
    }
    const star = document.getElementById("bookmark-star");
    if (star && tab) {
        const marked = !!(tab.url && getBookmarks().some(m => m.url === tab.url));
        star.innerHTML = `<i class="fa-${marked ? "solid" : "regular"} fa-star"></i>`;
        star.classList.toggle("starred", marked);
    }
}

function handleSubmit(url) {
    const tab = getActiveTab();
    if (!tab) return;
    let input = (url ?? document.getElementById("address-bar").value).trim();
    if (!input) return;

    if (!/^https?:\/\//i.test(input)) {
        input = input.includes('.') && !input.includes(' ')
            ? `https://${input}`
            : `${getSearchEngine().url}${encodeURIComponent(input)}`;
    }
    // Strip tracking params before proxying
    try {
        const u = new URL(input);
        ["utm_source","utm_medium","utm_campaign","utm_term","utm_content","fbclid","gclid","msclkid","mc_cid","mc_eid"].forEach(p => u.searchParams.delete(p));
        input = u.toString();
    } catch {}

    tab.loading = true;
    tab.loadStartTime = Date.now();
    showErrorBox(false);
    showIframeLoading(true, input);
    updateLoadingBar(tab, 10);
    updateConnectionStatus("switching", null);
    const t0 = Date.now();
    try {
        tab.frame.go(input);
        recordHistory(input, input);
        // Optimistic latency sample; real fetch timing happens in SW.
        setTimeout(() => {
            const st = transportStats.get(localStorage.getItem("proxServer"));
            updateConnectionStatus("online", st?.emaMs != null ? Math.round(st.emaMs) : null);
        }, 1500);
    } catch (err) {
        tab.loading = false;
        showIframeLoading(false);
        showErrorBox(true, String(err?.message || err));
        recordFetchResult(localStorage.getItem("proxServer") || DEFAULT_WISP, false, Date.now() - t0);
    }
    saveSession();
}

function updateLoadingBar(tab, percent) {
    if (tab.id !== activeTabId) return;
    const bar = document.getElementById("loading-bar");
    bar.style.width = percent + "%";
    bar.style.opacity = percent === 100 ? "0" : "1";
    if (percent === 100) setTimeout(() => { bar.style.width = "0%"; }, 200);
}

// =====================================================
// SETTINGS & WISP
// =====================================================
function openSettings() {
    const modal = document.getElementById('wisp-settings-modal');
    modal.classList.remove('hidden');

    document.getElementById('close-wisp-modal').onclick = () => modal.classList.add('hidden');
    document.getElementById('save-custom-wisp').onclick = saveCustomWisp;

    modal.onclick = (e) => { if (e.target === modal) modal.classList.add('hidden'); };
    renderServerList();
}

function renderServerList() {
    const list = document.getElementById('server-list');
    list.innerHTML = '';

    const currentUrl = localStorage.getItem('proxServer') ?? DEFAULT_WISP;
    const allWisps = [...WISP_SERVERS, ...getStoredWisps()];

    allWisps.forEach((server, index) => {
        const isActive = server.url === currentUrl;
        const isCustom = index >= WISP_SERVERS.length;

        const item = document.createElement('div');
        item.className = `wisp-option ${isActive ? 'active' : ''}`;

        item.innerHTML = `
            <div class="wisp-option-header">
                <div class="wisp-option-name"></div>
                <div class="server-status">
                    <span class="ping-text">...</span>
                    <div class="status-indicator"></div>
                </div>
            </div>
            <div class="wisp-option-url"></div>
        `;
        item.querySelector('.wisp-option-name').textContent = server.name;
        if (isActive) {
            item.querySelector('.wisp-option-name').insertAdjacentHTML('beforeend', '<i class="fa-solid fa-check" style="margin-left:8px; font-size: 0.7em; color: var(--accent);"></i>');
        }
        item.querySelector('.wisp-option-url').textContent = server.url;
        if (isCustom) {
            const del = document.createElement('button');
            del.className = 'delete-wisp-btn';
            del.innerHTML = '<i class="fa-solid fa-trash"></i>';
            del.onclick = (e) => { e.stopPropagation(); window.deleteCustomWisp(server.url); };
            item.querySelector('.server-status').appendChild(del);
        }

        item.onclick = () => setWisp(server.url);
        list.appendChild(item);
        checkServerHealth(server.url, item);
    });

    // Add Autoswitch Toggle (read live state on each click — no stale closure)
    const toggleContainer = document.createElement('div');
    toggleContainer.className = 'wisp-option';
    toggleContainer.style.cssText = 'margin-top: 10px; cursor: default;';
    const paintToggle = () => {
        const on = localStorage.getItem('wispAutoswitch') !== 'false';
        toggleContainer.innerHTML = `
            <div class="wisp-option-header" style="justify-content: space-between;">
                <div class="wisp-option-name"><i class="fa-solid fa-rotate" style="margin-right:8px"></i> Auto-switch on failure</div>
                <div class="toggle-switch ${on ? 'active' : ''}" id="autoswitch-toggle">
                    <div class="toggle-knob"></div>
                </div>
            </div>
        `;
    };
    paintToggle();

    toggleContainer.onclick = () => {
        const currentlyOn = localStorage.getItem('wispAutoswitch') !== 'false';
        const newState = !currentlyOn;
        localStorage.setItem('wispAutoswitch', String(newState));
        paintToggle();

        syncSwConfig();
        notify('success', 'Settings Saved', `Autoswitch ${newState ? 'Enabled' : 'Disabled'}`);
    };

    list.appendChild(toggleContainer);

    // ---- Advanced section: transport / search / privacy / cloak / safety ----
    const adv = document.createElement('div');
    adv.className = 'settings-adv';
    const transport = getSetting("transport", "auto");
    const engine = getSetting("searchEngine", "brave");
    const adblock = getSetting("adblock", true);
    const cloak = getSetting("cloak", "ixl");
    const panicKey = getSetting("panicKey", "`");
    const panicUrl = getSetting("panicUrl", "https://classroom.google.com");
    const accent = getSetting("accent", "#3b82f6");
    const restore = getSetting("restoreSession", true);
    adv.innerHTML = `
        <div class="section-title" style="margin-top:16px">Transport (advanced)</div>
        <select id="transport-select" class="settings-select">
            <option value="auto">Auto (epoxy → libcurl fallback)</option>
            <option value="epoxy-jsdelivr">Epoxy (jsDelivr)</option>
            <option value="epoxy-unpkg">Epoxy (unpkg)</option>
            <option value="libcurl">Libcurl</option>
        </select>
        <div class="settings-hint">Auto tries Epoxy CDNs first, then Libcurl — different TLS stacks unblock different sites.</div>
        <div class="section-title" style="margin-top:16px">Search engine</div>
        <select id="engine-select" class="settings-select"></select>
        <div class="section-title" style="margin-top:16px">Privacy</div>
        <div class="wisp-option" id="adblock-row" style="cursor:default"><div class="wisp-option-header" style="justify-content:space-between"><div class="wisp-option-name">Block ads + trackers</div><div class="toggle-switch ${adblock ? "active" : ""}" id="adblock-toggle"><div class="toggle-knob"></div></div></div></div>
        <div class="wisp-option" id="restore-row" style="cursor:default;margin-top:6px"><div class="wisp-option-header" style="justify-content:space-between"><div class="wisp-option-name">Restore tabs on restart</div><div class="toggle-switch ${restore ? "active" : ""}" id="restore-toggle"><div class="toggle-knob"></div></div></div></div>
        <div class="settings-hint">Tracking params (utm_*, fbclid, gclid…) are always stripped before proxying.</div>
        <div class="section-title" style="margin-top:16px">Tab cloak</div>
        <select id="cloak-select" class="settings-select"></select>
        <div class="section-title" style="margin-top:16px">Panic key</div>
        <div class="custom-input-group"><input id="panic-key" maxlength="1" value="${escapeHtml(panicKey)}"><input id="panic-url" value="${escapeHtml(panicUrl)}"></div>
        <div class="settings-hint">Press the panic key to instantly jump to the panic URL. Right-click a bookmark to delete it.</div>
        <div class="section-title" style="margin-top:16px">Accent</div>
        <div class="swatches" id="accent-swatches"></div>
    `;
    list.appendChild(adv);

    const tSel = adv.querySelector("#transport-select");
    tSel.value = transport;
    tSel.onchange = async () => {
        setSetting("transport", tSel.value);
        syncSwConfig();
        updateConnectionStatus("switching", null);
        await reconnectTransport(localStorage.getItem("proxServer") || DEFAULT_WISP);
        updateConnectionStatus("online", null);
        notify("success", "Transport updated", tSel.value);
    };
    const eSel = adv.querySelector("#engine-select");
    Object.entries(SEARCH_ENGINES).forEach(([id, e]) => {
        const o = document.createElement("option");
        o.value = id; o.textContent = e.name;
        eSel.appendChild(o);
    });
    eSel.value = engine;
    eSel.onchange = () => { setSetting("searchEngine", eSel.value); notify("success", "Search engine", SEARCH_ENGINES[eSel.value].name); };
    adv.querySelector("#adblock-row").onclick = () => {
        const v = !getSetting("adblock", true);
        setSetting("adblock", v);
        adv.querySelector("#adblock-toggle").classList.toggle("active", v);
        syncSwConfig();
    };
    adv.querySelector("#restore-row").onclick = () => {
        const v = !getSetting("restoreSession", true);
        setSetting("restoreSession", v);
        adv.querySelector("#restore-toggle").classList.toggle("active", v);
    };
    const cSel = adv.querySelector("#cloak-select");
    Object.entries(CLOAK_PRESETS).forEach(([id, p]) => {
        const o = document.createElement("option");
        o.value = id; o.textContent = p.name;
        cSel.appendChild(o);
    });
    cSel.value = cloak;
    cSel.onchange = () => { setSetting("cloak", cSel.value); applyCloak(); };
    adv.querySelector("#panic-key").onchange = (e) => setSetting("panicKey", e.target.value || "`");
    adv.querySelector("#panic-url").onchange = (e) => {
        let u = e.target.value.trim() || "https://classroom.google.com";
        if (!/^https?:\/\//i.test(u)) u = "https://" + u;
        setSetting("panicUrl", u); e.target.value = u;
    };
    const sw = adv.querySelector("#accent-swatches");
    ["#ffffff", "#3b82f6", "#22c55e", "#a855f7", "#ef4444", "#f59e0b"].forEach(c => {
        const b = document.createElement("button");
        b.className = "swatch" + (c === accent ? " sel" : "");
        b.style.background = c;
        b.onclick = () => { setSetting("accent", c); applyTheme(); sw.querySelectorAll(".swatch").forEach(x => x.classList.remove("sel")); b.classList.add("sel"); };
        sw.appendChild(b);
    });
}

function saveCustomWisp() {
    const input = document.getElementById('custom-wisp-input');
    const url = input.value.trim();

    if (!url) return;
    if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
        notify('error', 'Invalid URL', 'URL must start with wss:// or ws://');
        return;
    }

    const customWisps = getStoredWisps();
    if (customWisps.some(w => w.url === url) || WISP_SERVERS.some(w => w.url === url)) {
        notify('warning', 'Already Exists', 'This server is already in the list.');
        return;
    }

    const newServer = { name: `Custom ${customWisps.length + 1}`, url };
    customWisps.push(newServer);
    localStorage.setItem('customWisps', JSON.stringify(customWisps));
    
    // Switch to the newly added server
    setWisp(url);
    
    input.value = '';
}

window.deleteCustomWisp = function (urlToDelete) {
    if (!confirm("Remove this server?")) return;

    let customWisps = getStoredWisps().filter(w => w.url !== urlToDelete);
    localStorage.setItem('customWisps', JSON.stringify(customWisps));

    if (localStorage.getItem('proxServer') === urlToDelete) {
        setWisp(DEFAULT_WISP);
    } else {
        renderServerList();
    }
};

async function checkServerHealth(url, element) {
    const dot = element.querySelector('.status-indicator');
    const text = element.querySelector('.ping-text');
    const start = Date.now();
    let settled = false;

    const markOnline = (latency) => {
        if (settled) return;
        settled = true;
        dot.classList.add('status-success');
        text.textContent = `${latency}ms`;
    };
    const markOffline = () => {
        if (settled) return;
        settled = true;
        dot.classList.add('status-error');
        text.textContent = "Offline";
    };

    // WISP is a raw WebSocket protocol — an HTTP HEAD to /health is meaningless
    // (no-cors always resolves opaque). Just do a real WebSocket open test.
    try {
        const ws = new WebSocket(url);
        const timer = setTimeout(() => { try { ws.close(); } catch {} markOffline(); }, 2500);
        ws.onopen = () => {
            clearTimeout(timer);
            const latency = Date.now() - start;
            try { ws.close(); } catch {}
            markOnline(latency);
        };
        ws.onerror = () => { clearTimeout(timer); try { ws.close(); } catch {} markOffline(); };
    } catch { markOffline(); }
}

async function setWisp(url) {
    const oldUrl = localStorage.getItem('proxServer');
    localStorage.setItem('proxServer', url);

    if (oldUrl !== url) {
        const serverName = [...WISP_SERVERS, ...getStoredWisps()].find(s => s.url === url)?.name ?? 'Custom Server';
        notify('success', 'Proxy Changed', `Switching to ${serverName}...`);
    }

    // Try live reconnect first — no reload needed in most cases.
    updateConnectionStatus("switching", null);
    const ok = await reconnectTransport(url);
    syncSwConfig();
    if (ok) {
        renderServerList();
        const st = transportStats.get(url);
        updateConnectionStatus("online", st?.emaMs != null ? Math.round(st.emaMs) : null);
        // Reload active tab through the new server so the switch takes effect.
        const t = getActiveTab();
        if (t && t.url && !t.url.includes("NT.html")) handleSubmit(t.url);
    } else {
        setTimeout(() => location.reload(), 600);
    }
}

// =====================================================
// UTILITIES
// =====================================================
function toggleDevTools() {
    const win = getActiveTab()?.frame.frame.contentWindow;
    if (!win) return;
    if (win.eruda) {
        win.eruda.show();
        return;
    }
    const script = win.document.createElement('script');
    script.src = "https://cdn.jsdelivr.net/npm/eruda";
    script.onload = () => { win.eruda.init(); win.eruda.show(); };
    win.document.body.appendChild(script);
}

async function checkHashParameters() {
    if (window.location.hash) {
        const hash = decodeURIComponent(window.location.hash.substring(1));
        if (hash) handleSubmit(hash);
        history.replaceState(null, null, location.pathname);
    }
}

// =====================================================
// MAIN INITIALIZATION
// =====================================================
document.addEventListener('DOMContentLoaded', async function () {
    try {
        if (typeof $scramjetLoadController !== "function") {
            throw new Error("Scramjet CDN failed to load ($scramjetLoadController missing).");
        }
        // Proactively find the best server before initializing
        await initializeWithBestServer();
        
        await getSharedScramjet();
        await getSharedConnection();

        if ('serviceWorker' in navigator) {
            const reg = await navigator.serviceWorker.register(getBasePath() + 'sw.js', { scope: getBasePath() });

            // Wait for SW to be ready
            await navigator.serviceWorker.ready;

            const buildSwConfig = () => ({
                type: "config",
                wispurl: localStorage.getItem("proxServer") ?? DEFAULT_WISP,
                servers: getAllWispServers(),
                autoswitch: localStorage.getItem('wispAutoswitch') !== 'false',
                adblock: getSetting("adblock", true),
                transport: getSetting("transport", "auto"),
            });

            // Send config to SW
            const sendConfig = async () => {
                const sw = reg.active || navigator.serviceWorker.controller;
                if (sw) {
                    const cfg = buildSwConfig();
                    console.log("Sending config to SW:", cfg);
                    sw.postMessage(cfg);
                }
            };

            // Try sending immediately, then retry if needed
            sendConfig();
            setTimeout(sendConfig, 500);
            setTimeout(sendConfig, 1500);

            navigator.serviceWorker.addEventListener('message', (event) => {
                const { type, url, name, message, wispUrl, ok, latency } = event.data || {};
                if (type === 'wispChanged') {
                    console.log("SW reported Wisp Change:", event.data);
                    localStorage.setItem("proxServer", url);
                    reconnectTransport(url);
                    notify('info', 'Autoswitched Proxy', `Now using ${name} because the previous server was slow or offline.`);
                } else if (type === 'wispError') {
                    console.error("SW reported Wisp Error:", event.data);
                    updateConnectionStatus("offline", null);
                    notify('error', 'Proxy Error', message);
                } else if (type === 'fetchStats') {
                    // Real-traffic signal from the SW: feed latency-aware routing.
                    if (wispUrl) {
                        recordFetchResult(wispUrl, !!ok, typeof latency === "number" ? latency : 800);
                        if (ok && document.getElementById("conn-status")) {
                            const st = transportStats.get(wispUrl);
                            updateConnectionStatus("online", st?.emaMs != null ? Math.round(st.emaMs) : null);
                        }
                    }
                } else if (type === 'pingResult') {
                    if (event.data?.url && typeof event.data?.latency === "number") {
                        const st = transportStats.get(event.data.url);
                        if (st && st.emaMs === null) st.emaMs = event.data.latency;
                    }
                }
            });

            reg.update();
        }

        await initializeBrowser();
    } catch (err) {
        console.error("Initialization error:", err);
        const loader = document.getElementById("loading");
        if (loader) loader.style.display = "none";
        const errBox = document.getElementById("error");
        const errMsg = document.getElementById("error-message");
        if (errBox) {
            errBox.style.display = "flex";
            if (errMsg) errMsg.textContent = String(err?.message || err);
        } else {
            document.body.insertAdjacentHTML("beforeend",
                `<div style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;color:#e4e4e7;background:#0a0a0a;z-index:99999;font-family:sans-serif"><div style="max-width:420px;text-align:center;padding:20px"><h2>Failed to start</h2><p style="color:#71717a;font-size:13px">${escapeHtml(String(err?.message || err))}</p><button onclick="location.reload()" style="margin-top:12px;padding:8px 16px;background:#1a1a1a;color:#e4e4e7;border:1px solid #2a2a2a;border-radius:6px;cursor:pointer">Retry</button></div></div>`);
        }
    }
});
