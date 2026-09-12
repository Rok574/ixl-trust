
const ADBLOCK = {
    blocked: [
  "googlevideo.com/videoplayback",
  "youtube.com/get_video_info",
  "youtube.com/api/stats/ads",
  "youtube.com/pagead",
  "youtube.com/api/stats",
  "youtube.com/get_midroll",
  "youtube.com/ptracking",
  "youtube.com/youtubei/v1/player",
  "youtube.com/s/player",
  "youtube.com/api/timedtext",
  "facebook.com/ads",
  "facebook.com/tr",
  "fbcdn.net/ads",
  "graph.facebook.com/ads",
  "graph.facebook.com/pixel",
  "ads-api.twitter.com",
  "analytics.twitter.com",
  "twitter.com/i/ads",
  "ads.yahoo.com",
  "advertising.com",
  "adtechus.com",
  "amazon-adsystem.com",
  "adnxs.com",
  "doubleclick.net",
  "googlesyndication.com",
  "googleadservices.com",
  "rubiconproject.com",
  "pubmatic.com",
  "criteo.com",
  "openx.net",
  "taboola.com",
  "outbrain.com",
  "moatads.com",
  "casalemedia.com",
  "unityads.unity3d.com",
  "/ads/",
  "/adserver/",
  "/banner/",
  "/promo/",
  "/tracking/",
  "/beacon/",
  "/metrics/",
  "adsafeprotected.com",
  "chartbeat.com",
  "scorecardresearch.com",
  "quantserve.com",
  "krxd.net",
  "demdex.net"
]   
};

function isAdBlocked(url) {
    // Substring match (case-insensitive). The old version built an anchored
    // regex and escaped '.' AFTER expanding '*', so it never matched.
    const urlStr = String(url).toLowerCase();
    for (const pattern of ADBLOCK.blocked) {
        if (urlStr.includes(String(pattern).toLowerCase())) {
            return true;
        }
    }
    return false;
}

const swPath = self.location.pathname;
const basePath = swPath.substring(0, swPath.lastIndexOf('/') + 1);
self.basePath = self.basePath || basePath;

self.$scramjet = {
    files: {
        wasm: "https://cdn.jsdelivr.net/gh/Destroyed12121/Staticsj@main/JS/scramjet.wasm.wasm",
        sync: "https://cdn.jsdelivr.net/gh/Destroyed12121/Staticsj@main/JS/scramjet.sync.js",
    }
};

importScripts("https://cdn.jsdelivr.net/gh/Destroyed12121/Staticsj@main/JS/scramjet.all.js");
importScripts("https://cdn.jsdelivr.net/npm/@mercuryworkshop/bare-mux/dist/index.js");

const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker({
    prefix: basePath + "scramjet/"
});

self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// Wisp configuration - receives from script.js via postMessage
let wispConfig = {
    wispurl: null,
    servers: [],
    autoswitch: true,
    adblock: true,
    transport: "auto",
};

// Transport fallback chain (mirrors script.js): Epoxy first, Libcurl second.
const SW_TRANSPORTS = [
    { id: "epoxy-jsdelivr", url: "https://cdn.jsdelivr.net/npm/@mercuryworkshop/epoxy-transport@2.1.28/dist/index.mjs", args: (w) => [{ wisp: w }] },
    { id: "epoxy-unpkg", url: "https://unpkg.com/@mercuryworkshop/epoxy-transport@2.1.28/dist/index.mjs", args: (w) => [{ wisp: w }] },
    { id: "libcurl", url: "https://cdn.jsdelivr.net/npm/@mercuryworkshop/libcurl-transport@1.5.0/dist/index.mjs", args: (w) => [{ websocket: w }] },
];
let activeSwTransport = null;
async function swSetTransport(connection, wispUrl) {
    const pref = wispConfig.transport || "auto";
    const ordered = pref === "auto" ? SW_TRANSPORTS
        : [...SW_TRANSPORTS.filter(t => t.id === pref), ...SW_TRANSPORTS.filter(t => t.id !== pref)];
    let lastErr = null;
    for (const t of ordered) {
        try {
            await connection.setTransport(t.url, t.args(wispUrl));
            activeSwTransport = t.id;
            return t.id;
        } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error("SW: all transports failed");
}

// BareMuxConnection only manages the transport — it has no .fetch().
// Actual fetching goes through BareClient, which talks to the same
// SharedWorker. (This was the "scramjet.client.fetch is not a function" bug.)
async function ensureBareClient() {
    if (scramjet.client && typeof scramjet.client.fetch === "function") {
        return scramjet.client;
    }
    const connection = scramjet._bareConnection || new BareMux.BareMuxConnection(basePath + "bareworker.js");
    await swSetTransport(connection, wispConfig.wispurl);
    scramjet._bareConnection = connection;

    let client = null;
    try { client = new BareMux.BareClient(basePath + "bareworker.js"); } catch {}
    if (!client || typeof client.fetch !== "function") {
        try { client = new BareMux.BareClient(); } catch {}
    }
    if (!client || typeof client.fetch !== "function") {
        throw new Error("BareClient unavailable (fetch missing)");
    }
    scramjet.client = client;
    return client;
}
function resetBareClient() {
    try { scramjet.client = null; } catch {}
    try { scramjet._bareConnection = null; } catch {}
}

const TRACKING_PARAMS = ["utm_source","utm_medium","utm_campaign","utm_term","utm_content","fbclid","gclid","msclkid","mc_cid","mc_eid","igshid","vero_id"];
function stripTracking(urlStr) {
    try {
        const u = new URL(urlStr);
        let changed = false;
        TRACKING_PARAMS.forEach(p => { if (u.searchParams.has(p)) { u.searchParams.delete(p); changed = true; } });
        return changed ? u.toString() : urlStr;
    } catch { return urlStr; }
}
function isCacheableStatic(urlStr, method) {
    if (method !== "GET") return false;
    try {
        const u = new URL(urlStr);
        return /\.(js|css|png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf|eot)(\?|#|$)/i.test(u.pathname);
    } catch { return false; }
}
function reportStats(wispUrl, ok, latency) {
    try {
        self.clients.matchAll().then(clients => {
            clients.forEach(c => c.postMessage({ type: "fetchStats", wispUrl, ok, latency }));
        });
    } catch {}
}

// Server health tracking for autoswitching
let serverHealth = new Map();
let currentServerStartTime = null;
let proactiveCheckInFlight = false;
const MAX_CONSECUTIVE_FAILURES = 2;
const PING_TIMEOUT = 3000;

let resolveConfigReady;
const configReadyPromise = new Promise(resolve => resolveConfigReady = resolve);

// Ping a wisp server to check if it's responsive.
// NOTE: ServiceWorkers have no WebSocket constructor in most browsers, so
// probe the underlying host over HTTPS instead. Offline hosts reject; online
// hosts resolve (possibly opaque with no-cors). This is only a liveness hint —
// real failure counting still happens on fetch errors below.
async function pingServer(url) {
    const start = Date.now();
    try {
        const httpsUrl = String(url)
            .replace(/^wss:\/\//i, "https://")
            .replace(/^ws:\/\//i, "http://");
        // Strip the /wisp/ path — we just want the host to answer *something*.
        const probe = new URL(httpsUrl);
        probe.pathname = "/";
        probe.search = "";
        probe.hash = "";

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), PING_TIMEOUT);
        try {
            await fetch(probe.toString(), { method: "HEAD", mode: "no-cors", signal: controller.signal });
        } finally {
            clearTimeout(timer);
        }
        return { url, success: true, latency: Date.now() - start };
    } catch {
        return { url, success: false, latency: null };
    }
}

// Update server health status from actual proxied traffic. Probe failures are
// only hints and must not make a working server look broken.
function updateServerHealth(url, success) {
    const health = serverHealth.get(url) || { consecutiveFailures: 0, successes: 0, lastSuccess: 0 };
    
    if (success) {
        health.consecutiveFailures = 0;
        health.successes++;
        health.lastSuccess = Date.now();
    } else {
        health.consecutiveFailures++;
    }
    
    serverHealth.set(url, health);
    return health;
}

function switchToServer(url, latency = null) {
    if (url === wispConfig.wispurl) return;
    
    console.log(`SW: Switching from ${wispConfig.wispurl} to ${url}`);
    wispConfig.wispurl = url;
    currentServerStartTime = Date.now();
    
    // Notify all clients
    self.clients.matchAll().then(clients => {
        clients.forEach(client => {
            client.postMessage({
                type: 'wispChanged',
                url: url,
                name: wispConfig.servers.find(s => s.url === url)?.name || 'Unknown Server',
                latency: latency
            });
        });
    });

    // Reset connection to force reconnection with new server
    resetBareClient();
}

// Proactively check server health and switch if needed
async function proactiveServerCheck() {
    if (!wispConfig.autoswitch || !wispConfig.servers || wispConfig.servers.length === 0) return;
    if (proactiveCheckInFlight) return;
    proactiveCheckInFlight = true;

    try {
        const currentUrl = wispConfig.wispurl;

        // Probes are only candidates; actual proxied failures decide whether
        // the current server should be abandoned.
        const results = await Promise.all(
            wispConfig.servers.map(s => pingServer(s.url))
        );
        const currentHealth = serverHealth.get(currentUrl);
        if (currentHealth && currentHealth.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            const bestWorking = results
                .filter(r => r.success && r.url !== currentUrl)
                .sort((a, b) => a.latency - b.latency)[0];

            if (bestWorking) {
                switchToServer(bestWorking.url, bestWorking.latency);
            }
        }
    } finally {
        proactiveCheckInFlight = false;
    }
}

self.addEventListener("message", ({ data }) => {
    if (data.type === "config") {
        if (data.wispurl) {
            if (data.wispurl !== wispConfig.wispurl && scramjet) {
                // Server changed live: drop cached client so next request reconnects.
                resetBareClient();
            }
            wispConfig.wispurl = data.wispurl;
            console.log("SW: Received wispurl", data.wispurl);
            currentServerStartTime = Date.now();
        }
        if (data.servers && data.servers.length > 0) {
            wispConfig.servers = data.servers;
            console.log("SW: Received servers", data.servers.length);
            if (wispConfig.autoswitch) {
                setTimeout(proactiveServerCheck, 500);
            }
        }
        if (typeof data.autoswitch !== 'undefined') {
            wispConfig.autoswitch = data.autoswitch;
            if (wispConfig.autoswitch && wispConfig.servers?.length > 0) {
                setTimeout(proactiveServerCheck, 500);
            }
        }
        if (typeof data.adblock !== 'undefined') wispConfig.adblock = !!data.adblock;
        if (typeof data.transport !== 'undefined' && data.transport !== wispConfig.transport) {
            wispConfig.transport = data.transport;
            resetBareClient();
        }
        // Resolve config ready when we have at least wispurl
        if (wispConfig.wispurl && resolveConfigReady) {
            resolveConfigReady();
            resolveConfigReady = null;
        }
    } else if (data.type === "reconnect") {
        // Drop cached client + apply new wisp immediately.
        if (data.wispurl) wispConfig.wispurl = data.wispurl;
        resetBareClient();
        currentServerStartTime = Date.now();
        if (wispConfig.wispurl && resolveConfigReady) {
            resolveConfigReady();
            resolveConfigReady = null;
        }
    } else if (data.type === "ping") {
        pingServer(wispConfig.wispurl).then(result => {
            self.clients.matchAll().then(clients => {
                clients.forEach(client => {
                    client.postMessage({ type: 'pingResult', ...result });
                });
            });
        });
    }
});

self.addEventListener("fetch", (event) => {
    event.respondWith((async () => {
        // Check if request URL matches ad blocking patterns (toggleable)
        if (wispConfig.adblock !== false && isAdBlocked(event.request.url)) {
            console.log("SW: Blocked ad request:", event.request.url);
            return new Response(new ArrayBuffer(0), { status: 204 });
        }

        await scramjet.loadConfig();
        if (scramjet.route(event)) {
            return scramjet.fetch(event);
        }
        return fetch(event.request);
    })());
});

scramjet.addEventListener("request", async (e) => {
    e.response = (async () => {
        await configReadyPromise;

        if (!wispConfig.wispurl) {
            return new Response("Wisp URL not configured", { status: 500 });
        }

        let bare;
        try {
            bare = await ensureBareClient();
        } catch (err) {
            console.error("SW: all transports failed:", err);
            return new Response("Proxy transport failed: " + String(err?.message || err), { status: 502 });
        }

        // Strip tracking params from the destination URL before fetching.
        const cleanUrl = stripTracking(e.url);

        // Cache-first for static proxied assets (faster repeat loads).
        if (isCacheableStatic(cleanUrl, e.method)) {
            try {
                const cache = await caches.open("sj-static-v1");
                const cached = await cache.match(cleanUrl);
                if (cached) return cached;
            } catch {}
        }

        const MAX_RETRIES = 1;
        let lastErr;
        const t0 = Date.now();

        const fetchFromBare = typeof bare.fetch === "function" ? bare.fetch.bind(bare) : null;
        if (!fetchFromBare) {
            const unavailable = new Error("BareClient fetch unavailable");
            updateServerHealth(wispConfig.wispurl, false);
            reportStats(wispConfig.wispurl, false, Date.now() - t0);
            console.error("Scramjet Fetch Error:", unavailable);
            return new Response("Scramjet Fetch Error: " + unavailable.message, { status: 502 });
        }

        for (let i = 0; i <= MAX_RETRIES; i++) {
            try {
                const res = await fetchFromBare(cleanUrl, {
                    method: e.method,
                    body: e.body,
                    headers: e.requestHeaders,
                    credentials: "include",
                    mode: e.mode === "cors" ? e.mode : "same-origin",
                    cache: e.cache,
                    redirect: "manual",
                    duplex: "half",
                });
                const ms = Date.now() - t0;
                updateServerHealth(wispConfig.wispurl, true);
                reportStats(wispConfig.wispurl, true, ms);
                // Populate static cache on clean 200s.
                try {
                    if (isCacheableStatic(cleanUrl, e.method) && res && res.status === 200) {
                        const cache = await caches.open("sj-static-v1");
                        cache.put(cleanUrl, res.clone());
                        // Trim cache to ~100 entries.
                        const keys = await cache.keys();
                        if (keys.length > 100) await cache.delete(keys[0]);
                    }
                } catch {}
                return res;
            } catch (err) {
                lastErr = err;
                const errMsg = String(err?.message || err || "").toLowerCase();
                const isRetryable = errMsg.includes("connect") ||
                    errMsg.includes("eof") ||
                    errMsg.includes("handshake") ||
                    errMsg.includes("reset") ||
                    errMsg.includes("network") ||
                    errMsg.includes("failed to fetch");

                if (!isRetryable || i === MAX_RETRIES || e.method !== 'GET') break;

                console.warn(`Scramjet retry ${i + 1}/${MAX_RETRIES} for ${e.url} due to: ${errMsg}`);
                await new Promise(r => setTimeout(r, 250 * (i + 1)));
            }
        }

        // Update server health on failure
        updateServerHealth(wispConfig.wispurl, false);
        reportStats(wispConfig.wispurl, false, Date.now() - t0);

        // Check if we should switch to a different server
        if (wispConfig.autoswitch && wispConfig.servers && wispConfig.servers.length > 1) {
            const currentHealth = serverHealth.get(wispConfig.wispurl);
            
            // Only switch if server has been unstable for a while
            if (currentHealth && currentHealth.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                // Find a working server that isn't the current one
                for (const server of wispConfig.servers) {
                    if (server.url === wispConfig.wispurl) continue;
                    const serverH = serverHealth.get(server.url);
                    // Prefer servers with no failures or fewer failures
                    if (!serverH || serverH.consecutiveFailures < MAX_CONSECUTIVE_FAILURES) {
                        // Ping to verify it's actually working
                        const pingResult = await pingServer(server.url);
                        if (pingResult.success) {
                            console.log(`SW: Auto-switching to ${server.url} due to failures on current server`);
                            switchToServer(server.url, pingResult.latency);
                            break;
                        }
                    }
                }
            }
        }

        console.error("Scramjet Final Fetch Error:", lastErr);
        return new Response("Scramjet Fetch Error: " + String(lastErr?.message || lastErr || "unknown"), { status: 502 });
    })();
});