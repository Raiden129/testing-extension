(() => {
    const CONFIG = {
        PROBE_TIMEOUT: 2500,
        MAX_ATTEMPTS: 30,
        MAX_SERVER_CAP: 20,
        MAX_CONCURRENT_PROBES: 6,
        CACHE_LIMIT: 2000,
        FAILED_CACHE_LIMIT: 5000,
        MAX_RETRIES_PER_IMAGE: 1,
        DEBUG: true,
        STORAGE_KEY_CACHE: 'bato_fixer_cache_v8',
        STORAGE_KEY_CONTEXT: 'bato_fixer_context_v8',
        STORAGE_KEY_STATS: 'bato_fixer_hoststats_v1',
        HOST_STATS_LIMIT: 400,
        UCB_K: 0.6,
        LATENCY_BASE_MS: 300,
        STATS_HALF_LIFE_MS: 60 * 60 * 1000
    };
    const FALLBACK_PREFIXES = ['n', 'x', 't', 's', 'w', 'm', 'c', 'u', 'k', 'd', 'b'];

    const FALLBACK_ROOTS = [
        'mpfip.org', 'mpizz.org', 'mpmok.org', 'mpqom.org', 'mpqsc.org', 'mprnm.org',
        'mpubn.org', 'mpujj.org', 'mpvim.org', 'mpypl.org',
        'mbdny.org', 'mbrtz.org', 'bato.to', 'mbwbm.org', 'mbznp.org', 'mbqgu.org',
        'mbtba.org', 'mbhiz.org', 'mbwnp.org', 'mbxma.org', 'mbwww.org', 'mbmyj.org',
        'mbeaj.org', 'mbzcp.org', 'mbuul.org', 'mbtmv.org', 'mbimg.org', 'mbopg.org',
        'mbfpu.org'
    ];

    const MASTER_STATIC_SERVERS = `
        n06.mbtmv.org n03.mbuul.org n07.mbdny.org n00.mbfpu.org n11.mbznp.org n06.mbopg.org n08.mbwbm.org n12.mbmyj.org n03.mbqgu.org n09.mbtba.org
        n05.mbxma.org n11.mbfpu.org n04.mbwbm.org n07.mbwnp.org n12.mbimg.org n12.mbqgu.org n14.mbwbm.org n14.mbznp.org n14.mbopg.org n11.mbwbm.org
        n11.mbdny.org n02.mbopg.org b01.mbfpu.org n02.mbmyj.org n11.mbwww.org n09.mbopg.org n00.mbrtz.org n08.mbfpu.org n05.mbwww.org d01.mbmyj.org
        n09.mbhiz.org n07.mbqgu.org n05.mbimg.org n08.mbimg.org n08.mbhiz.org n07.mbwww.org n05.mbmyj.org n03.mbimg.org d01.mbznp.org d01.mbopg.org
        n02.mbuul.org n12.mbfpu.org n01.mbdny.org n10.mbrtz.org n01.mbrtz.org b01.mbwbm.org n15.mbeaj.org n15.mbwww.org n00.mbwww.org n09.mbimg.org
        b01.mbtmv.org n10.mbfpu.org n10.mbhiz.org s01.mpmok.org n06.mbhiz.org n09.mbdny.org n11.mbopg.org n04.mbzcp.org n15.mbtmv.org n03.mbfpu.org
        n03.mbzcp.org d01.mbwbm.org n05.mbfpu.org s06.mpmok.org n03.mbopg.org n10.mbopg.org n10.mbeaj.org n12.mbwbm.org n04.mbuul.org n01.mbtba.org
        n02.mbwww.org n15.mbuul.org n09.mbwww.org n07.mbxma.org n10.mbwnp.org n07.mbopg.org n15.mbwbm.org n02.mbwnp.org b01.mbwww.org n15.mbzcp.org
        b01.mbmyj.org n12.mbeaj.org n10.mbimg.org n06.mbzcp.org n09.mbeaj.org b01.mbzcp.org n07.mbrtz.org
    `.trim().split(/\s+/);

    const STRONG_FALLBACK_PREFIXES = ['n', 'd', 'b'];

    const PREPARED_STATIC_SERVERS = MASTER_STATIC_SERVERS
        .map(host => {
            const m = host.match(/^([a-z]+)(\d+)\.([a-z0-9\-]+)\.([a-z]{2,})$/i);
            if (!m) return null;
            return {
                prefix: m[1].toLowerCase(),
                numberStr: m[2],
                root: m[3].toLowerCase(),
                tld: m[4].toLowerCase()
            };
        })
        .filter(Boolean);

    const IGNORE_PATTERNS = [
        '/rec?', 'pubadx', 'adform', 'criteo', 'doubleclick',
        'googlesyndication', 'monetix', '/ads/', 'googleapis.com'
    ];

    const SUBDOMAIN_RE = /^https?:\/\/([a-z]+)(\d+)\.([a-z0-9\-]+)\.([a-z]{2,})(\/.*)$/i;
    const BATO_PATTERN = /^https?:\/\/[a-z]+\d+\.[a-z0-9\-]+\.[a-z]{2,}\/?/i;

    let serverCache = new Map();
    let failedCache = new Set();
    let knownGoodServers = new Set();
    let hostStats = new Map();
    const brokenImageRegistry = new Set();

    let dynamicNetProfile = null;
    let lastProfileCompute = 0;

    // --- Concurrency Control ---
    class Semaphore {
        constructor(max) {
            this.max = max;
            this.counter = 0;
            this.queue = [];
        }
        async acquire() {
            if (this.counter < this.max) {
                this.counter++;
                return Promise.resolve();
            }
            return new Promise(resolve => this.queue.push(resolve));
        }
        release() {
            this.counter--;
            if (this.queue.length > 0) {
                this.counter++;
                this.queue.shift()();
            }
        }
    }
    const globalLimiter = new Semaphore(CONFIG.MAX_CONCURRENT_PROBES);

    const processingQueue = { high: [], low: [], isProcessing: false };
    let storageDirty = false;
    let storageSaveTimeout;

    const perf = { successes: 0, failures: 0, probesMade: 0, broadcastSuccess: 0 };

    function log(...args) {
        if (!CONFIG.DEBUG) return;
        console.debug('[BatoFixer]', ...args);
    }
    function logInfo(img, msg) {
        if (!CONFIG.DEBUG) return;
        const shortSrc = img?.src ? img.src.split('/').slice(-3).join('/') : 'unknown';
        console.info('[BatoFixer][INFO]', msg, shortSrc);
    }
    function logWarn(img, msg) {
        if (!CONFIG.DEBUG) return;
        const shortSrc = img?.src ? img.src.split('/').slice(-3).join('/') : 'unknown';
        console.warn('[BatoFixer][WARN]', msg, shortSrc);
    }

    function loadFromStorage() {
        try {
            const c = localStorage.getItem(CONFIG.STORAGE_KEY_CACHE);
            if (c) {
                serverCache = new Map(JSON.parse(c));
                log('Loaded serverCache:', serverCache.size, 'entries');
            }
            const k = localStorage.getItem(CONFIG.STORAGE_KEY_CONTEXT);
            if (k) {
                knownGoodServers = new Set(JSON.parse(k));
                log('Loaded knownGoodServers:', knownGoodServers.size, 'servers');
            }
            const s = localStorage.getItem(CONFIG.STORAGE_KEY_STATS);
            if (s) {
                hostStats = new Map(JSON.parse(s));
                log('Loaded hostStats:', hostStats.size, 'hosts');
            }
        } catch (e) {
            log('Storage load error:', e);
        }
    }

    function saveToStorage() {
        if (!storageDirty) return;
        try {
            if (failedCache.size > CONFIG.FAILED_CACHE_LIMIT) failedCache.clear();
            if (serverCache.size > CONFIG.CACHE_LIMIT) {
                const entries = Array.from(serverCache.entries());
                serverCache = new Map(entries.slice(-CONFIG.CACHE_LIMIT));
            }
            if (knownGoodServers.size > CONFIG.MAX_SERVER_CAP) {
                const servers = Array.from(knownGoodServers);
                knownGoodServers = new Set(servers.slice(-CONFIG.MAX_SERVER_CAP));
            }
            if (hostStats.size > CONFIG.HOST_STATS_LIMIT) {
                const entries = Array.from(hostStats.entries());
                entries.sort((a, b) => {
                    const av = a[1] && a[1].lastUpdatedAt ? a[1].lastUpdatedAt : 0;
                    const bv = b[1] && b[1].lastUpdatedAt ? b[1].lastUpdatedAt : 0;
                    return bv - av;
                });
                hostStats = new Map(entries.slice(0, CONFIG.HOST_STATS_LIMIT));
            }
            localStorage.setItem(CONFIG.STORAGE_KEY_CACHE, JSON.stringify([...serverCache]));
            localStorage.setItem(CONFIG.STORAGE_KEY_CONTEXT, JSON.stringify([...knownGoodServers]));
            localStorage.setItem(CONFIG.STORAGE_KEY_STATS, JSON.stringify([...hostStats]));
            log('Storage saved:', { serverCache: serverCache.size, knownGood: knownGoodServers.size });
            storageDirty = false;
        } catch (e) {
            log('Storage save error:', e);
        }
    }

    function markStorageDirty() {
        storageDirty = true;
        if (!storageSaveTimeout) {
            storageSaveTimeout = setTimeout(() => { saveToStorage(); storageSaveTimeout = null; }, 2000);
        }
    }

    function getOrInitHostStat(host) {
        let stat = hostStats.get(host);
        if (!stat) {
            stat = {
                successes: 0,
                failures: 0,
                lastSuccessAt: 0,
                avgLatencyMs: 0,
                lastUpdatedAt: Date.now()
            };
            hostStats.set(host, stat);
        }
        return stat;
    }

    function decayHostStat(stat, now) {
        const last = stat.lastUpdatedAt || now;
        const dt = now - last;
        if (dt <= 0) return;
        const halfLife = CONFIG.STATS_HALF_LIFE_MS;
        if (!halfLife || halfLife <= 0) return;
        const factor = Math.pow(0.5, dt / halfLife);
        stat.successes *= factor;
        stat.failures *= factor;
        stat.lastUpdatedAt = now;
    }

    function recordHostResult(host, success, latencyMs) {
        if (!host) return;
        const now = Date.now();
        const stat = getOrInitHostStat(host);
        decayHostStat(stat, now);

        if (success) {
            stat.successes += 1;
            stat.lastSuccessAt = now;
        } else {
            stat.failures += 1;
        }

        if (latencyMs && latencyMs > 0) {
            if (!stat.avgLatencyMs) stat.avgLatencyMs = latencyMs;
            else stat.avgLatencyMs = stat.avgLatencyMs * 0.7 + latencyMs * 0.3;
        }

        stat.lastUpdatedAt = now;
        markStorageDirty();
    }

    function computeNetworkProfile() {
        const profile = {
            probeTimeoutMs: CONFIG.PROBE_TIMEOUT,
            maxConcurrentProbes: CONFIG.MAX_CONCURRENT_PROBES,
            waveSize: 3
        };

        try {
            const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
            if (conn) {
                const et = (conn.effectiveType || '').toLowerCase();
                const down = typeof conn.downlink === 'number' ? conn.downlink : 0;

                if (et === '4g' && down >= 5) {
                    profile.probeTimeoutMs = Math.max(CONFIG.PROBE_TIMEOUT, 2200);
                    profile.maxConcurrentProbes = CONFIG.MAX_CONCURRENT_PROBES;
                    profile.waveSize = 3;
                } else if (et === '4g' || et === '3g' || down > 0) {
                    profile.probeTimeoutMs = Math.max(CONFIG.PROBE_TIMEOUT * 1.8, 3500);
                    profile.maxConcurrentProbes = Math.max(2, Math.min(CONFIG.MAX_CONCURRENT_PROBES, 4));
                    profile.waveSize = 2;
                } else if (et === '2g' || et === 'slow-2g') {
                    profile.probeTimeoutMs = Math.max(CONFIG.PROBE_TIMEOUT * 2.5, 6000);
                    profile.maxConcurrentProbes = 2;
                    profile.waveSize = 1;
                }
            }
        } catch (e) {
            log('networkProfile:connection-error', e);
        }

        const latencies = [];
        hostStats.forEach(stat => {
            if (!stat || !stat.avgLatencyMs || stat.avgLatencyMs <= 0) return;
            latencies.push(stat.avgLatencyMs);
        });

        if (latencies.length > 0) {
            latencies.sort((a, b) => a - b);
            const idx = Math.floor(latencies.length * 0.75);
            const typical = latencies[Math.min(idx, latencies.length - 1)];

            const minTimeout = CONFIG.PROBE_TIMEOUT;
            const maxTimeout = 8000;
            const suggested = typical * 3;
            profile.probeTimeoutMs = Math.max(minTimeout, Math.min(maxTimeout, Math.max(profile.probeTimeoutMs, suggested)));

            if (typical > 3500) {
                profile.waveSize = 1;
                profile.maxConcurrentProbes = Math.min(profile.maxConcurrentProbes, 2);
            } else if (typical > 2200) {
                profile.waveSize = Math.min(profile.waveSize, 2);
                profile.maxConcurrentProbes = Math.min(profile.maxConcurrentProbes, 3);
            }
        }
        profile.maxConcurrentProbes = Math.max(1, Math.min(CONFIG.MAX_CONCURRENT_PROBES, Math.floor(profile.maxConcurrentProbes || 1)));

        if (globalLimiter && typeof globalLimiter.max === 'number') {
            globalLimiter.max = profile.maxConcurrentProbes;
        }

        return profile;
    }

    function getNetworkProfile() {
        const now = Date.now();
        if (!dynamicNetProfile || now - lastProfileCompute > 5000) {
            dynamicNetProfile = computeNetworkProfile();
            lastProfileCompute = now;
            log('networkProfile:update', dynamicNetProfile);
        }
        return dynamicNetProfile;
    }

    function computeHostScore(host, totalTries, now) {
        const stat = hostStats.get(host);
        const s = stat ? stat.successes : 0;
        const f = stat ? stat.failures : 0;
        const tries = Math.max(0, s + f);
        const successRate = tries > 0 ? (s / tries) : 0.5;

        const globalTries = Math.max(1, totalTries || tries || 1);
        const ucb = successRate + CONFIG.UCB_K * Math.sqrt(Math.log(globalTries + 1) / (tries + 1));

        let latencyFactor = 1;
        if (stat && stat.avgLatencyMs && stat.avgLatencyMs > 0) {
            const C = CONFIG.LATENCY_BASE_MS;
            latencyFactor = C / (C + stat.avgLatencyMs);
        }

        let recencyBoost = 0;
        if (stat && stat.lastSuccessAt) {
            const ageMs = now - stat.lastSuccessAt;
            const windowMs = 30 * 60 * 1000;
            if (ageMs < windowMs) {
                recencyBoost = 0.2 * (1 - ageMs / windowMs);
            }
        }

        return ucb * latencyFactor + recencyBoost;
    }

    function getStatus(img) {
        return img.dataset.batoStatus || '';
    }

    function setStatus(img, status) {
        if (status) img.dataset.batoStatus = status;
        else delete img.dataset.batoStatus;
    }

    function isBatoImage(src) {
        return src && BATO_PATTERN.test(src);
    }

    function shouldIgnore(src) {
        if (!src || !isBatoImage(src)) return true;
        return IGNORE_PATTERNS.some(p => src.includes(p));
    }

    function parseSubdomain(src) {
        const m = src.match(SUBDOMAIN_RE);
        if (!m) return null;
        return {
            prefix: m[1].toLowerCase(),
            numberStr: m[2],
            root: m[3].toLowerCase(),
            tld: m[4].toLowerCase(),
            path: m[5]
        };
    }

    function getHostKeyFromUrl(url) {
        return url.split('/').slice(0, 3).join('/');
    }

    function getServerSignature(p, n, r, t) { return `${p}|${n}|${r}|${t}`; }

    function getCacheKeyFromSrc(src) {
        const parsed = parseSubdomain(src);
        if (!parsed) return null;
        const pathParts = parsed.path.split('/').filter(Boolean).slice(0, 3).join('/');
        return `${parsed.root}-${pathParts}`;
    }

    function registerGoodServer(input) {
        let prefix, numberStr, root, tld;
        if (typeof input === 'string') [prefix, numberStr, root, tld] = input.split('|');
        else if (input && 'prefix' in input) ({ prefix, numberStr, root, tld } = input);
        if (!prefix) return;

        const sig = getServerSignature(prefix, numberStr, root, tld);
        const host = `${prefix}${numberStr}.${root}.${tld}`;
        const isNew = !knownGoodServers.has(sig);
        if (!isNew) {
            knownGoodServers.delete(sig);
            knownGoodServers.add(sig);
            return;
        }

        knownGoodServers.add(sig);
        log('Registered good server:', host, `(total: ${knownGoodServers.size})`);
        markStorageDirty();
    }

    function addToQueue(img, priority = 'low') {
        if (shouldIgnore(img.src) || img.dataset.batoQueued) return;

        brokenImageRegistry.add(img);
        if (priority === 'auto') {
            const rect = img.getBoundingClientRect();
            priority = (rect.bottom > -100 && rect.top < window.innerHeight + 500) ? 'high' : 'low';
        }

        img.dataset.batoQueued = priority;
        setStatus(img, 'queued');
        processingQueue[priority].push(img);
        logInfo(img, `STEP2: queued for fixing (priority: ${priority})`);
        processQueue();
    }

    async function processQueue() {
        if (processingQueue.isProcessing) return;
        processingQueue.isProcessing = true;
        log('queue:start');

        while (processingQueue.high.length > 0 || processingQueue.low.length > 0) {
            const batch = [];
            const fill = (q) => {
                while (batch.length < 8 && q.length > 0) {
                    const img = q.shift();
                    if (img.isConnected) {
                        delete img.dataset.batoQueued;
                        batch.push(img);
                    } else {
                        brokenImageRegistry.delete(img);
                    }
                }
            };
            fill(processingQueue.high);
            fill(processingQueue.low);

            if (batch.length === 0) break;

            log('queue:batch', { size: batch.length });
            batch.forEach(img => fixImage(img));
            await new Promise(r => setTimeout(r, 10));
        }

        processingQueue.isProcessing = false;
        log('queue:done');
    }

    
    function probeSingle(url) {
        const hostKey = getHostKeyFromUrl(url);
        const parsed = parseSubdomain(url);
        const host = parsed ? `${parsed.prefix}${parsed.numberStr}.${parsed.root}.${parsed.tld}` : hostKey.replace(/^https?:\/\//, '');
        let cancelFn = () => {};

        const promise = (async () => {
            if (failedCache.has(hostKey)) {
                return Promise.reject('cached');
            }

            await globalLimiter.acquire();
            perf.probesMade++;
            const start = Date.now();

            const profile = getNetworkProfile();
            const timeoutMs = profile && profile.probeTimeoutMs ? profile.probeTimeoutMs : CONFIG.PROBE_TIMEOUT;

            return new Promise((resolve, reject) => {
                const img = new Image();
                img.referrerPolicy = 'no-referrer';
                
                let isFinished = false;
                let checkTimer = null;

                const cleanup = () => {
                    isFinished = true;
                    img.onload = null;
                    img.onerror = null;
                    if (checkTimer) {
                        clearInterval(checkTimer);
                        checkTimer = null;
                    }
                    globalLimiter.release(); 
                };
                cancelFn = () => {
                    if (!isFinished) {
                        img.src = ''; 
                        cleanup();
                        reject('cancelled');
                    }
                };

                const markSuccess = () => {
                    if (isFinished) return;
                    clearTimeout(timer);
                    if (checkTimer) {
                        clearInterval(checkTimer);
                        checkTimer = null;
                    }
                    recordHostResult(host, true, Date.now() - start);
                    cleanup();
                    img.src = '';
                    resolve(url);
                };

                checkTimer = setInterval(() => {
                    if (img.naturalWidth > 1) markSuccess();
                }, 150);

                const timer = setTimeout(() => {
                    if (!isFinished) {
                        failedCache.add(hostKey);
                        if (failedCache.size > CONFIG.FAILED_CACHE_LIMIT) failedCache.clear();
                        recordHostResult(host, false, timeoutMs);
                        perf.failures++;
                        cleanup();
                        img.src = ''; 
                        reject('timeout');
                    }
                }, timeoutMs);

                img.onload = () => {
                    if (img.width > 1) markSuccess();
                    else if (!isFinished) {
                        clearTimeout(timer);
                        if (checkTimer) {
                            clearInterval(checkTimer);
                            checkTimer = null;
                        }
                        failedCache.add(hostKey);
                        recordHostResult(host, false, Date.now() - start);
                        perf.failures++;
                        cleanup();
                        reject('empty');
                    }
                };

                img.onerror = () => {
                    if (isFinished) return;
                    clearTimeout(timer);
                    if (checkTimer) {
                        clearInterval(checkTimer);
                        checkTimer = null;
                    }
                    failedCache.add(hostKey);
                    recordHostResult(host, false, Date.now() - start);
                    perf.failures++;
                    cleanup();
                    reject('error');
                };

                img.src = url;
            });
        })();

        return { promise, cancel: () => cancelFn() };
    }

    function findFastestCandidate(candidates) {
        const profile = getNetworkProfile();
        const WAVE_SIZE = profile && profile.waveSize ? profile.waveSize : 3;

        if (candidates.length === 0) return Promise.reject('No candidates');

        return new Promise((resolve, reject) => {
            let active = 0;
            let index = 0;
            let resolved = false;
            const runningProbes = new Set();

            const killLosers = () => {
                runningProbes.forEach(probe => probe.cancel());
                runningProbes.clear();
            };

            const spawn = () => {
                if (resolved) return;

                if (index >= candidates.length) {
                    if (active === 0 && !resolved) reject('All failed');
                    return;
                }

                const url = candidates[index++];
                const hostKey = getHostKeyFromUrl(url);
                
                // Skip cached failures immediately
                if (failedCache.has(hostKey)) {
                    spawn();
                    return;
                }

                active++;
                
                const probe = probeSingle(url);
                runningProbes.add(probe);

                probe.promise.then(validUrl => {
                    if (!resolved) {
                        resolved = true;
                        killLosers();
                        resolve(validUrl);
                    }
                }).catch((reason) => {
                    runningProbes.delete(probe);
                    active--;
                    if (reason !== 'cancelled') {
                        spawn();
                    }
                });
            };

            // Start the initial wave
            for (let i = 0; i < Math.min(WAVE_SIZE, candidates.length); i++) {
                spawn();
            }
        });
    }

    function generateCandidates(parsed, options = {}) {
        const deep = !!options.deep;
        const cand = [];
        const add = (p, n, r, t, prio) => {
            const url = `https://${p}${String(n).padStart(2, '0')}.${r}.${t}${parsed.path}`;
            cand.push({ url, p: prio, host: `${p}${String(n).padStart(2, '0')}.${r}.${t}` });
        };

        PREPARED_STATIC_SERVERS.forEach((srv, idx) => {
            add(srv.prefix, srv.numberStr, srv.root, srv.tld, -2 + idx * 0.01);
        });

        Array.from(knownGoodServers).reverse().forEach((sig, i) => {
            const [p, n, r, t] = sig.split('|');
            if (p !== parsed.prefix || n !== parsed.numberStr) add(p, n, r, t, -1 + (i * 0.01));
        });

        const pathKey = getCacheKeyFromSrc(`https://${parsed.prefix}${parsed.numberStr}.${parsed.root}.${parsed.tld}${parsed.path}`);
        if (pathKey && serverCache.has(pathKey)) {
            const c = serverCache.get(pathKey);
            add(c.prefix, c.number, c.root, c.tld, -0.5);
            log('cache:hit', { key: pathKey, host: `${c.prefix}${c.number}.${c.root}.${c.tld}` });
        }

        if (parsed.prefix === 'k') ['n', 'x', 't'].forEach(l => add(l, parsed.numberStr, parsed.root, parsed.tld, 1));
        ['03', '01', '02', '04', '05', '00'].forEach((n, i) => {
            if (n !== parsed.numberStr) add(parsed.prefix, n, parsed.root, parsed.tld, 2 + i * 0.1);
        });
        FALLBACK_PREFIXES
            .filter(l => l !== parsed.prefix && l !== 'k')
            .forEach((l, i) => add(l, parsed.numberStr, parsed.root, parsed.tld, 3 + i * 0.1));

        const preferredNumbers = ['03', '01', '02', '04', '05', '00', '06', '07', '08', '09', '10', '11', '12', '14'];
        const orderedRoots = deep
            ? [
                ...FALLBACK_ROOTS.filter(r => r.startsWith('mb') || r === 'bato.to'),
                ...FALLBACK_ROOTS.filter(r => !(r.startsWith('mb') || r === 'bato.to'))
            ]
            : FALLBACK_ROOTS;

        orderedRoots.forEach((root, rootIndex) => {
            const parts = root.split('.');
            const r = parts[0];
            const t = parts[1];
            if (!r || !t || r === parsed.root) return;

            STRONG_FALLBACK_PREFIXES.forEach((prefix, pIndex) => {
                preferredNumbers.forEach((n, i) => {
                    if (prefix === parsed.prefix && n === parsed.numberStr && r === parsed.root && t === parsed.tld) return;
                    add(prefix, n, r, t, 2 + rootIndex * 0.1 + pIndex * 0.02 + i * 0.001);
                });
            });

            add(parsed.prefix, parsed.numberStr, r, t, 5 + rootIndex * 0.1);

            preferredNumbers.forEach((n, i) => {
                if (n === parsed.numberStr) return;
                add(parsed.prefix, n, r, t, 5.5 + rootIndex * 0.1 + i * 0.01);
            });
        });

        const unique = new Set();
        const maxAttempts = deep ? CONFIG.MAX_ATTEMPTS * 2 : CONFIG.MAX_ATTEMPTS;

        let totalTries = 0;
        hostStats.forEach(stat => {
            const s = stat && stat.successes ? stat.successes : 0;
            const f = stat && stat.failures ? stat.failures : 0;
            totalTries += Math.max(0, s + f);
        });
        const now = Date.now();
        const hostScoreCache = new Map();

        function getScoreForHost(host) {
            if (hostScoreCache.has(host)) return hostScoreCache.get(host);
            const score = computeHostScore(host, totalTries, now);
            hostScoreCache.set(host, score);
            return score;
        }

        cand.forEach(c => {
            c.score = getScoreForHost(c.host);
        });

        const sorted = cand.sort((a, b) => {
            if (a.score !== b.score) return b.score - a.score; 
            return a.p - b.p; 
        });

        const final = sorted
            .filter(c => !unique.has(c.url) && unique.add(c.url))
            .map(c => c.url)
            .slice(0, maxAttempts);

        log('candidate:list', {
            mode: deep ? 'deep' : 'normal',
            count: final.length,
            sample: sorted.slice(0,5).map(c => ({ host: c.host, score: c.score.toFixed(3) }))
        });
        return final;
    }

    function applyFix(img, url) {
        const ok = parseSubdomain(url);
        if (!ok) return;

        const host = `${ok.prefix}${ok.numberStr}.${ok.root}.${ok.tld}`;
        log('fix:applied', host);
        logInfo(img, `STEP3: applied working server ${host}`);

        const pathKey = getCacheKeyFromSrc(img.dataset.originalSrc || img.src);
        if (pathKey) {
            serverCache.set(pathKey, { prefix: ok.prefix, number: ok.numberStr, root: ok.root, tld: ok.tld });
            markStorageDirty();
        }
        registerGoodServer(ok);
        perf.successes++;

        img.referrerPolicy = 'no-referrer';
        img.src = url;
        if (img.srcset) img.srcset = url;

        img.dataset.batoFixing = 'done';
        img.dataset.batoFixed = 'true';
        setStatus(img, 'done');
        delete img.dataset.batoFixStart;
        brokenImageRegistry.delete(img);

        let broadcastCount = 0;
        brokenImageRegistry.forEach(otherImg => {
            if (otherImg === img || otherImg.dataset.batoFixing === 'done') return;
            const p = parseSubdomain(otherImg.src);
            if (!p || (p.prefix === ok.prefix && p.numberStr === ok.numberStr)) return;

            if (!otherImg.dataset.originalSrc) otherImg.dataset.originalSrc = otherImg.src;
            otherImg.dataset.batoFixing = 'broadcasting';
            setStatus(otherImg, 'broadcast');

            otherImg.addEventListener('error', function onFail() {
                otherImg.dataset.batoFixing = 'failed';
                setStatus(otherImg, 'failed');
                logWarn(otherImg, 'broadcast:error');
                addToQueue(otherImg, 'high');
            }, { once: true });

            otherImg.addEventListener('load', function onSuccess() {
                if (otherImg.naturalWidth > 0) {
                    otherImg.dataset.batoFixing = 'done';
                    setStatus(otherImg, 'done');
                    brokenImageRegistry.delete(otherImg);
                    perf.broadcastSuccess++;
                    logInfo(otherImg, 'broadcast:success');
                }
            }, { once: true });

            otherImg.referrerPolicy = 'no-referrer';
            otherImg.src = `https://${host}${p.path}`;
            broadcastCount++;
        });

        if (broadcastCount > 0) {
            log('STEP3: broadcasting working server to other broken images', { count: broadcastCount, host });
        }
    }

    async function fixImage(img) {
        const status = getStatus(img);
        if (status === 'probing' || status === 'broadcast' || status === 'done') return;

        logInfo(img, 'STEP3: start fix (contextual + search)');
        img.dataset.batoFixing = 'probing';
        img.dataset.batoFixStart = Date.now().toString();
        setStatus(img, 'probing');

        const parsed = parseSubdomain(img.src);
        if (!parsed) {
            logWarn(img, 'STEP3: cannot parse image URL, giving up');
            img.dataset.batoFixing = 'failed';
            setStatus(img, 'failed');
            return;
        }

        const retries = parseInt(img.dataset.batoRetries || '0', 10) || 0;
        const deep = retries > 0;
        const candidates = generateCandidates(parsed, { deep });
        if (candidates.length === 0) {
            logWarn(img, 'STEP3: no candidate servers found');
            img.dataset.batoFixing = 'failed';
            setStatus(img, 'failed');
            return;
        }

        try {
            const validUrl = await findFastestCandidate(candidates);
            applyFix(img, validUrl);
        } catch (err) {
            logWarn(img, `STEP3: all candidate servers failed (${err})`);
            img.dataset.batoFixing = 'failed';
            setStatus(img, 'failed');
        }
    }

    function preemptiveKtoN(img) {
        if (shouldIgnore(img.src)) return false;
        if (img.dataset.batoPreemptiveApplied === 'true') return false;

        const parsed = parseSubdomain(img.src);
        if (!parsed || parsed.prefix !== 'k') return false;

        const pathKey = parsed.path.split('/').filter(Boolean).slice(0, 3).join('/');
        const cacheKey = `${parsed.root}-${pathKey}`;

        let newPrefix = 'n';
        let newNumber = parsed.numberStr;
        let newRoot = parsed.root;
        let newTld = parsed.tld;

        if (serverCache.has(cacheKey)) {
            const cached = serverCache.get(cacheKey);
            log('STEP1: using cached server for path', {
                cacheKey,
                host: `${cached.prefix}${cached.number}.${cached.root}.${cached.tld}`
            });
            newPrefix = cached.prefix || newPrefix;
            newNumber = cached.number || newNumber;
            newRoot = cached.root || newRoot;
            newTld = cached.tld || newTld;
        }

        const newHost = `${newPrefix}${String(newNumber).padStart(2, '0')}.${newRoot}.${newTld}`;
        const newUrl = `https://${newHost}${parsed.path}`;

        logInfo(img, `STEP1: preemptive k→${newPrefix} switch to ${newHost}`);

        img.dataset.originalSrc = img.dataset.originalSrc || img.src;
        img.referrerPolicy = 'no-referrer';

        if (img.srcset) {
            img.dataset.originalSrcset = img.dataset.originalSrcset || img.srcset;
            const baseRe = /https?:\/\/[a-z]+\d+\.[a-z0-9\-]+\.[a-z]{2,}/gi;
            img.srcset = img.srcset.replace(baseRe, `https://${newHost}`);
        }

        img.dataset.batoPreemptiveApplied = 'true';
        img.src = newUrl;
        return true;
    }

    function init() {
        log('init', 'BatoFixer v8 (Fixes ALL bato CDN images - thumbs, avatars, covers, panels)');
        loadFromStorage();

        document.addEventListener('load', e => {
            if (e.target.tagName === 'IMG' && !shouldIgnore(e.target.src) && e.target.naturalWidth > 0) {
                const p = parseSubdomain(e.target.src);
                if (p) {
                    logInfo(e.target, 'server:harvest');
                    registerGoodServer(p);
                }
            }
        }, true);

        document.querySelectorAll('img').forEach(img => {
            if (shouldIgnore(img.src)) return;

            // Step 1: simple k→n swap (legacy behavior).
            preemptiveKtoN(img);

            if (img.complete) {
                if (img.naturalWidth === 0) {
                    logWarn(img, 'img:broken-on-load');
                    addToQueue(img, 'high');
                } else {
                    const p = parseSubdomain(img.src);
                    if (p) registerGoodServer(p);
                }
            } else {
                img.addEventListener('error', () => addToQueue(img, 'high'), { once: true });
            }
        });

        new MutationObserver(mutations => {
            mutations.forEach(m => m.addedNodes.forEach(n => {
                if (n.tagName === 'IMG' && !shouldIgnore(n.src)) {
                    // Step 1 for new images: simple k→n swap.
                    preemptiveKtoN(n);
                    if (!n.complete) n.addEventListener('error', () => addToQueue(n, 'high'), { once: true });
                } else if (n.querySelectorAll) {
                    n.querySelectorAll('img').forEach(i => {
                        if (!shouldIgnore(i.src) && !i.complete) {
                            // Step 1 for discovered images: simple k→n swap.
                            preemptiveKtoN(i);
                            i.addEventListener('error', () => addToQueue(i, 'high'), { once: true });
                        }
                    });
                }
            }));
        }).observe(document.body, { childList: true, subtree: true });

        setInterval(() => {
            const now = Date.now();
            document.querySelectorAll('[data-bato-status="probing"], [data-bato-status="broadcast"]').forEach(img => {
                if ((now - parseInt(img.dataset.batoFixStart || 0)) > 20000) {
                    const retries = parseInt(img.dataset.batoRetries || '0', 10) || 0;
                    if (retries < CONFIG.MAX_RETRIES_PER_IMAGE) {
                        img.dataset.batoRetries = String(retries + 1);
                        logWarn(img, `watchdog:retry-${retries + 1}`);
                        img.dataset.batoFixing = '';
                        setStatus(img, 'queued');
                        img.dataset.batoFixStart = Date.now().toString();
                        addToQueue(img, 'high');
                    } else {
                        logWarn(img, 'watchdog:failed');
                        img.dataset.batoFixing = 'failed';
                        setStatus(img, 'failed');
                        brokenImageRegistry.add(img);
                    }
                }
            });
            if (storageDirty) saveToStorage();

            if (CONFIG.DEBUG && perf.probesMade % 50 === 0 && perf.probesMade > 0) {
                log('stats', {
                    successes: perf.successes,
                    failures: perf.failures,
                    probes: perf.probesMade,
                    broadcast: perf.broadcastSuccess,
                    registry: brokenImageRegistry.size,
                    goodServers: knownGoodServers.size
                });
            }
        }, 5000);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
