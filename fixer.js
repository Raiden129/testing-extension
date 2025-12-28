(() => {
    // --- Configuration ---
    const CONFIG = {
        PROBE_TIMEOUT: 2500,
        MAX_ATTEMPTS: 30,
        MAX_SERVER_CAP: 20,
        MAX_CONCURRENT_PROBES: 12,
        CACHE_LIMIT: 2000,
        FAILED_CACHE_LIMIT: 5000,
        DEBUG: false,  // Set to true for detailed console logs
        STORAGE_KEY_CACHE: 'bato_fixer_cache_v8',
        STORAGE_KEY_CONTEXT: 'bato_fixer_context_v8'
    };

    const FALLBACK_PREFIXES = ['n', 'x', 't', 's', 'w', 'm', 'c', 'u', 'k'];
    const FALLBACK_ROOTS = [
        'mbdny.org', 'mbrtz.org', 'bato.to', 'mbwbm.org', 'mbznp.org', 'mbqgu.org',
        'mbtba.org', 'mbhiz.org', 'mbwnp.org', 'mbxma.org', 'mbwww.org', 'mbmyj.org',
        'mbeaj.org', 'mbzcp.org', 'mbuul.org', 'mbtmv.org', 'mbimg.org', 'mbopg.org',
        'mbfpu.org'
    ];

    const IGNORE_PATTERNS = [
        '/rec?', 'pubadx', 'adform', 'criteo', 'doubleclick',
        'googlesyndication', 'monetix', '/ads/', 'googleapis.com'
    ];

    // Broad pattern: matches any image on letter+number.domain.tld (any path)
    const SUBDOMAIN_RE = /^https?:\/\/([a-z]+)(\d+)\.([a-z0-9\-]+)\.([a-z]{2,})(\/.*)$/i;
    const BATO_PATTERN = /^https?:\/\/[a-z]+\d+\.[a-z0-9\-]+\.[a-z]{2,}\/?/i;

    // --- State Management ---
    let serverCache = new Map();
    let failedCache = new Set();
    let knownGoodServers = new Set();
    const brokenImageRegistry = new Set();

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

    const perf = { successes: 0, failures: 0, probesMade: 0, preemptiveSuccess: 0, preemptiveFail: 0, broadcastSuccess: 0 };

    // --- Logging ---
    function log(...args) {
        if (CONFIG.DEBUG) console.log('%c[BatoFixer]', 'color: #ff6b35; font-weight: bold;', ...args);
    }
    function logInfo(img, msg) {
        if (!CONFIG.DEBUG) return;
        const shortSrc = img?.src ? img.src.split('/').slice(-3).join('/') : 'unknown';
        console.log(`%c[Info] ${msg}`, 'color: #4caf50;', shortSrc, img);
    }
    function logWarn(img, msg) {
        if (!CONFIG.DEBUG) return;
        const shortSrc = img?.src ? img.src.split('/').slice(-3).join('/') : 'unknown';
        console.warn(`[Warn] ${msg}`, shortSrc, img);
    }

    // --- Storage ---
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
            localStorage.setItem(CONFIG.STORAGE_KEY_CACHE, JSON.stringify([...serverCache]));
            localStorage.setItem(CONFIG.STORAGE_KEY_CONTEXT, JSON.stringify([...knownGoodServers]));
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

    // --- Helpers ---
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
        if (knownGoodServers.has(sig)) knownGoodServers.delete(sig); // LRU touch
        knownGoodServers.add(sig);
        log('Registered good server:', host, `(total: ${knownGoodServers.size})`);
        markStorageDirty();
    }

    // --- Queue System ---
    function addToQueue(img, priority = 'low') {
        if (shouldIgnore(img.src) || img.dataset.batoQueued) return;

        brokenImageRegistry.add(img);
        if (priority === 'auto') {
            const rect = img.getBoundingClientRect();
            priority = (rect.bottom > -100 && rect.top < window.innerHeight + 500) ? 'high' : 'low';
        }

        img.dataset.batoQueued = priority;
        processingQueue[priority].push(img);
        logInfo(img, `Queued as ${priority}`);
        processQueue();
    }

    async function processQueue() {
        if (processingQueue.isProcessing) return;
        processingQueue.isProcessing = true;
        log('Starting queue processing...');

        while (processingQueue.high.length > 0 || processingQueue.low.length > 0) {
            const batch = [];
            const fill = (q) => {
                while (batch.length < 5 && q.length > 0) {
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

            log(`Processing batch of ${batch.length} images`);
            batch.forEach(img => fixImage(img));
            await new Promise(r => setTimeout(r, 50));
        }

        processingQueue.isProcessing = false;
        log('Queue processing finished');
    }

    // --- Probing Logic ---
    async function probeSingle(url) {
        const hostKey = url.split('/').slice(0, 3).join('/');
        if (failedCache.has(hostKey)) {
            log('Probe skipped (negative cache):', hostKey);
            return Promise.reject('cached');
        }

        await globalLimiter.acquire();
        perf.probesMade++;
        log(`Probing: ${hostKey}`);

        try {
            return await new Promise((resolve, reject) => {
                const img = new Image();
                img.referrerPolicy = 'no-referrer';
                let timer = setTimeout(() => {
                    img.src = '';
                    failedCache.add(hostKey);
                    log('Probe timeout:', hostKey);
                    reject('timeout');
                }, CONFIG.PROBE_TIMEOUT);

                img.onload = () => {
                    clearTimeout(timer);
                    if (img.width > 1) {
                        log('%cProbe success!', 'color: #4caf50; font-weight: bold;', hostKey);
                        resolve(url);
                    } else {
                        failedCache.add(hostKey);
                        log('Probe empty image:', hostKey);
                        reject('empty');
                    }
                };

                img.onerror = () => {
                    clearTimeout(timer);
                    failedCache.add(hostKey);
                    log('Probe error:', hostKey);
                    reject('error');
                };

                img.src = url;
            });
        } finally {
            globalLimiter.release();
        }
    }

    function findFastestCandidate(candidates) {
        log(`Finding fastest among ${candidates.length} candidates`);
        if (candidates.length === 0) return Promise.reject('No candidates');

        return new Promise((resolve, reject) => {
            let active = 0, index = 0, resolved = false;

            const spawn = () => {
                if (resolved || index >= candidates.length) {
                    if (active === 0 && !resolved) reject('All failed');
                    return;
                }
                const url = candidates[index++];
                const hostKey = url.split('/').slice(0, 3).join('/');
                if (failedCache.has(hostKey)) { spawn(); return; }

                active++;
                probeSingle(url).then(validUrl => {
                    if (!resolved) {
                        resolved = true;
                        log('%cWinner found!', 'color: #ffeb3b; background: #333; font-weight: bold;', hostKey);
                        resolve(validUrl);
                    }
                }).catch(() => {
                    active--;
                    spawn();
                });
            };

            const waveSize = Math.min(6, candidates.length);
            for (let i = 0; i < waveSize; i++) spawn();
        });
    }

    function generateCandidates(parsed) {
        const cand = [];
        const add = (p, n, r, t, prio) => {
            const url = `https://${p}${String(n).padStart(2, '0')}.${r}.${t}${parsed.path}`;
            cand.push({ url, p: prio, host: `${p}${String(n).padStart(2, '0')}.${r}.${t}` });
        };

        // 1. Known good servers (highest priority)
        Array.from(knownGoodServers).reverse().forEach((sig, i) => {
            const [p, n, r, t] = sig.split('|');
            if (p !== parsed.prefix || n !== parsed.numberStr) add(p, n, r, t, -1 + (i * 0.01));
        });

        // 2. Per-path cache
        const pathKey = getCacheKeyFromSrc(`https://${parsed.prefix}${parsed.numberStr}.${parsed.root}.${parsed.tld}${parsed.path}`);
        if (pathKey && serverCache.has(pathKey)) {
            const c = serverCache.get(pathKey);
            add(c.prefix, c.number, c.root, c.tld, 0);
            log('Cache hit:', pathKey, '→', `${c.prefix}${c.number}.${c.root}.${c.tld}`);
        }

        // 3. Heuristics
        if (parsed.prefix === 'k') ['n','x','t'].forEach(l => add(l, parsed.numberStr, parsed.root, parsed.tld, 1));
        ['03','01','02','04','05','00'].forEach((n,i) => { if(n !== parsed.numberStr) add(parsed.prefix, n, parsed.root, parsed.tld, 2+i*0.1); });
        FALLBACK_PREFIXES.filter(l => l !== parsed.prefix && l !== 'k').forEach((l,i) => add(l, parsed.numberStr, parsed.root, parsed.tld, 3+i*0.1));
        FALLBACK_ROOTS.forEach(root => { const [r,t] = root.split('.'); if(r !== parsed.root) add(parsed.prefix, parsed.numberStr, r, t, 4); });

        const unique = new Set();
        const final = cand.sort((a,b) => a.p - b.p)
            .filter(c => !unique.has(c.url) && unique.add(c.url))
            .map(c => c.url)
            .slice(0, CONFIG.MAX_ATTEMPTS);

        log(`Generated ${final.length} candidates (top 5):`, cand.slice(0,5).map(c => c.host));
        return final;
    }

    function applyFix(img, url) {
        const ok = parseSubdomain(url);
        if (!ok) return;

        const host = `${ok.prefix}${ok.numberStr}.${ok.root}.${ok.tld}`;
        log('%cFixed image!', 'color: #4caf50; font-weight: bold;', host);

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
        delete img.dataset.batoFixStart;
        brokenImageRegistry.delete(img);

        // Broadcast to other broken images
        let broadcastCount = 0;
        brokenImageRegistry.forEach(otherImg => {
            if (otherImg === img || otherImg.dataset.batoFixing === 'done') return;
            const p = parseSubdomain(otherImg.src);
            if (!p || (p.prefix === ok.prefix && p.numberStr === ok.numberStr)) return;

            if (!otherImg.dataset.originalSrc) otherImg.dataset.originalSrc = otherImg.src;
            otherImg.dataset.batoFixing = 'broadcasting';

            otherImg.addEventListener('error', function onFail() {
                otherImg.dataset.batoFixing = 'failed';
                logWarn(otherImg, 'Broadcast failed → requeue');
                addToQueue(otherImg, 'high');
            }, { once: true });

            otherImg.addEventListener('load', function onSuccess() {
                if (otherImg.naturalWidth > 0) {
                    otherImg.dataset.batoFixing = 'done';
                    brokenImageRegistry.delete(otherImg);
                    perf.broadcastSuccess++;
                    logInfo(otherImg, 'Broadcast success');
                }
            }, { once: true });

            otherImg.src = `https://${host}${p.path}`;
            broadcastCount++;
        });

        if (broadcastCount > 0) log(`Broadcasting fix to ${broadcastCount} images`);
    }

    async function fixImage(img) {
        if (img.dataset.batoFixing === 'true' || img.dataset.batoFixing === 'done') return;

        logInfo(img, 'Starting full fix');
        img.dataset.batoFixing = 'true';
        img.dataset.batoFixStart = Date.now().toString();

        const parsed = parseSubdomain(img.src);
        if (!parsed) {
            img.dataset.batoFixing = 'failed';
            logWarn(img, 'Parse failed');
            return;
        }

        try {
            const candidates = generateCandidates(parsed);
            const winner = await findFastestCandidate(candidates);
            applyFix(img, winner);
        } catch (e) {
            img.dataset.batoFixing = 'failed';
            perf.failures++;
            logWarn(img, 'All probes failed');
        }
    }

    function preemptiveFix(img) {
        if (knownGoodServers.size === 0) return false;
        const parsed = parseSubdomain(img.src);
        if (!parsed) return false;

        const servers = Array.from(knownGoodServers);
        const sig = servers[servers.length - 1];
        const [p, n, r, t] = sig.split('|');
        if (p === parsed.prefix && n === parsed.numberStr) return false;

        const newUrl = `https://${p}${n}.${r}.${t}${parsed.path}`;
        const host = `${p}${n}.${r}.${t}`;

        logInfo(img, `Preemptive fix → ${host}`);
        img.dataset.originalSrc = img.src;
        img.dataset.batoPreemptive = 'true';
        img.referrerPolicy = 'no-referrer';

        const slowTimer = setTimeout(() => {
            if (img.dataset.batoPreemptive === 'true' && !img.complete) {
                logWarn(img, 'Preemptive slow → full fix');
                addToQueue(img, 'high');
            }
        }, 1500);

        const cleanup = () => clearTimeout(slowTimer);

        img.addEventListener('error', () => {
            cleanup();
            img.src = img.dataset.originalSrc;
            img.dataset.batoPreemptive = 'failed';
            perf.preemptiveFail++;
            logWarn(img, 'Preemptive failed');
            addToQueue(img, 'high');
        }, { once: true });

        img.addEventListener('load', () => {
            cleanup();
            if (img.naturalWidth > 0) {
                img.dataset.batoPreemptive = '';
                img.dataset.batoFixing = 'done';
                perf.preemptiveSuccess++;
                perf.successes++;
                logInfo(img, 'Preemptive success!');
                registerGoodServer({ prefix: p, numberStr: n, root: r, tld: t });
            } else {
                img.dispatchEvent(new Event('error'));
            }
        }, { once: true });

        img.src = newUrl;
        return true;
    }

    function init() {
        log('%cBatoFixer v8 (Fixes ALL bato CDN images - thumbs, avatars, covers, panels)', 'font-size: 16px; color: #ff6b35; font-weight: bold;');
        loadFromStorage();

        // Harvest good servers from any successful load
        document.addEventListener('load', e => {
            if (e.target.tagName === 'IMG' && isBatoImage(e.target.src) && e.target.naturalWidth > 0) {
                const p = parseSubdomain(e.target.src);
                if (p) {
                    logInfo(e.target, 'Harvested good server');
                    registerGoodServer(p);
                }
            }
        }, true);

        // Initial scan
        document.querySelectorAll('img').forEach(img => {
            if (!isBatoImage(img.src)) return;

            if (img.complete) {
                if (img.naturalWidth === 0) {
                    logWarn(img, 'Broken on load → queue');
                    addToQueue(img, 'high');
                } else {
                    const p = parseSubdomain(img.src);
                    if (p) registerGoodServer(p);
                }
            } else {
                img.addEventListener('error', () => addToQueue(img, 'high'), { once: true });
            }

            // Preemptive on any broken-looking image
            if (img.naturalWidth === 0 && knownGoodServers.size > 0) {
                preemptiveFix(img);
            }
        });

        // Dynamic content
        new MutationObserver(mutations => {
            mutations.forEach(m => m.addedNodes.forEach(n => {
                if (n.tagName === 'IMG' && isBatoImage(n.src)) {
                    if (!n.complete) n.addEventListener('error', () => addToQueue(n, 'high'), { once: true });
                    if (knownGoodServers.size > 0) preemptiveFix(n);
                }
                if (n.querySelectorAll) {
                    n.querySelectorAll('img').forEach(i => {
                        if (isBatoImage(i.src) && !i.complete) {
                            i.addEventListener('error', () => addToQueue(i, 'high'), { once: true });
                            if (knownGoodServers.size > 0) preemptiveFix(i);
                        }
                    });
                }
            }));
        }).observe(document.body, { childList: true, subtree: true });

        // Cleanup & stats
        setInterval(() => {
            const now = Date.now();
            document.querySelectorAll('[data-bato-fixing="true"]').forEach(img => {
                if ((now - parseInt(img.dataset.batoFixStart || 0)) > 20000) {
                    logWarn(img, 'Fix hung >20s → failed');
                    img.dataset.batoFixing = 'failed';
                    brokenImageRegistry.add(img);
                }
            });
            if (storageDirty) saveToStorage();

            if (CONFIG.DEBUG && perf.probesMade % 50 === 0 && perf.probesMade > 0) {
                log('Stats:', {
                    successes: perf.successes,
                    failures: perf.failures,
                    probes: perf.probesMade,
                    preemptive: `${perf.preemptiveSuccess}/${perf.preemptiveSuccess + perf.preemptiveFail}`,
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
