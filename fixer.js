(() => {
    // --- Configuration ---
    const CONFIG = {
        PROBE_TIMEOUT: 2500,        
        MAX_ATTEMPTS: 30,           
        MAX_SERVER_CAP: 20,         
        MAX_CONCURRENT_PROBES: 12,  
        CACHE_LIMIT: 2000,
        FAILED_CACHE_LIMIT: 5000,
        DEBUG: false,
        STORAGE_KEY_CACHE: 'bato_fixer_cache_v7', 
        STORAGE_KEY_CONTEXT: 'bato_fixer_context_v7'
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

    const SUBDOMAIN_RE = /^https?:\/\/([a-z]+)(\d+)\.([a-z0-9\-]+)\.([a-z]{2,})(\/.*)$/i;
    const BATO_PATTERN = /^https?:\/\/[a-z]+\d+\.[a-z0-9\-]+\.[a-z]{2,}\/media\//i;

    // --- State Management ---
    let serverCache = new Map();
    let failedCache = new Set();
    let knownGoodServers = new Set(); 
    const brokenImageRegistry = new Set(); 

    // --- High-Speed Concurrency Control ---
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
                const resolve = this.queue.shift();
                resolve();
            }
        }
    }
    const globalLimiter = new Semaphore(CONFIG.MAX_CONCURRENT_PROBES);

    const processingQueue = {
        high: [],
        low: [],
        isProcessing: false
    };

    let storageDirty = false;
    let storageSaveTimeout;

    const perf = { successes: 0, failures: 0, probesMade: 0 };

    function log(...args) { if (CONFIG.DEBUG) console.log('[BatoFixer]', ...args); }

    // --- Storage ---
    function loadFromStorage() {
        try {
            const c = localStorage.getItem(CONFIG.STORAGE_KEY_CACHE);
            if (c) serverCache = new Map(JSON.parse(c));
            const k = localStorage.getItem(CONFIG.STORAGE_KEY_CONTEXT);
            if (k) knownGoodServers = new Set(JSON.parse(k));
        } catch (e) {}
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
            storageDirty = false;
        } catch (e) {}
    }

    function markStorageDirty() {
        storageDirty = true;
        if (!storageSaveTimeout) {
            storageSaveTimeout = setTimeout(() => { saveToStorage(); storageSaveTimeout = null; }, 2000);
        }
    }

    // --- Helpers ---
    function isBatoImage(src) { return src && BATO_PATTERN.test(src); }
    function shouldIgnore(src) {
        if (!src || !isBatoImage(src)) return true;
        return IGNORE_PATTERNS.some(p => src.includes(p));
    }
    function parseSubdomain(src) {
        const m = src.match(SUBDOMAIN_RE);
        if (!m) return null;
        return { prefix: m[1].toLowerCase(), numberStr: m[2], root: m[3].toLowerCase(), tld: m[4].toLowerCase(), path: m[5] };
    }
    function getServerSignature(p, n, r, t) { return `${p}|${n}|${r}|${t}`; }
    function getCacheKeyFromSrc(src) {
        const parsed = parseSubdomain(src);
        if (!parsed) return null;
        const mediaIndex = parsed.path.indexOf('/media/');
        if (mediaIndex === -1) return null;
        return `${parsed.root}-${parsed.path.substring(mediaIndex).split('/').slice(0, 4).join('/')}`;
    }

    function registerGoodServer(input) {
        let prefix, numberStr, root, tld;
        if (typeof input === 'string') [prefix, numberStr, root, tld] = input.split('|');
        else if (input && 'prefix' in input) ({ prefix, numberStr, root, tld } = input);
        if (!prefix) return;
        const sig = getServerSignature(prefix, numberStr, root, tld);
        if (knownGoodServers.has(sig)) knownGoodServers.delete(sig); // Touch (LRU)
        knownGoodServers.add(sig);
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
        processQueue();
    }

    async function processQueue() {
        if (processingQueue.isProcessing) return;
        processingQueue.isProcessing = true;
        while (processingQueue.high.length > 0 || processingQueue.low.length > 0) {
            const batch = [];
            const fill = (q) => {
                while (batch.length < 5 && q.length > 0) { 
                    const img = q.shift();
                    if (img.isConnected) { delete img.dataset.batoQueued; batch.push(img); }
                    else brokenImageRegistry.delete(img);
                }
            };
            fill(processingQueue.high);
            fill(processingQueue.low);
            if (batch.length === 0) break;
            
            // Start fixes in parallel
            batch.forEach(img => fixImage(img)); 
            await new Promise(r => setTimeout(r, 50)); 
        }
        processingQueue.isProcessing = false;
    }

    // --- Fast Probing Logic ---

    async function probeSingle(url) {
        const hostKey = url.split('/').slice(0, 3).join('/');
        if (failedCache.has(hostKey)) return Promise.reject('cached');

        await globalLimiter.acquire();
        perf.probesMade++;

        try {
            return await new Promise((resolve, reject) => {
                const img = new Image();
                img.referrerPolicy = 'no-referrer';
                let timer = setTimeout(() => {
                    img.src = ''; failedCache.add(hostKey); reject('timeout');
                }, CONFIG.PROBE_TIMEOUT);

                img.onload = () => {
                    clearTimeout(timer);
                    if (img.width > 1) resolve(url);
                    else { failedCache.add(hostKey); reject('empty'); }
                };
                img.onerror = () => {
                    clearTimeout(timer);
                    failedCache.add(hostKey); reject('error');
                };
                img.src = url;
            });
        } finally {
            globalLimiter.release();
        }
    }

    function findFastestCandidate(candidates) {
        return new Promise((resolve, reject) => {
            let active = 0;
            let index = 0;
            let resolved = false;
            let failures = 0;

            const spawn = () => {
                if (resolved) return;
                if (index >= candidates.length) {
                    if (active === 0 && !resolved) reject('All failed');
                    return;
                }

                const url = candidates[index++];
                if (failedCache.has(url.split('/').slice(0,3).join('/'))) {
                    failures++;
                    spawn(); 
                    return;
                }

                active++;
                probeSingle(url).then(validUrl => {
                    if (!resolved) {
                        resolved = true;
                        resolve(validUrl);
                    }
                }).catch(() => {
                    active--;
                    failures++;
                    spawn(); 
                });
            };

            const waveSize = Math.min(6, candidates.length); 
            for (let i = 0; i < waveSize; i++) spawn();
        });
    }

    function generateCandidates(parsed) {
        const cand = [];
        const add = (p, n, r, t, prio) => cand.push({ url: `https://${p}${String(n).padStart(2, '0')}.${r}.${t}${parsed.path}`, p: prio });

        // 1. KNOWN SERVERS (Highest Priority: -1.0 to -0.8)
        Array.from(knownGoodServers).reverse().forEach((sig, i) => {
            const [p, n, r, t] = sig.split('|');
            if (p !== parsed.prefix || n !== parsed.numberStr) add(p, n, r, t, -1 + (i*0.01));
        });

        // 2. CACHE (Priority 0)
        const pathKey = getCacheKeyFromSrc(`https://${parsed.prefix}${parsed.numberStr}.${parsed.root}.${parsed.tld}${parsed.path}`);
        if (pathKey && serverCache.has(pathKey)) {
            const c = serverCache.get(pathKey);
            add(c.prefix, c.number, c.root, c.tld, 0);
        }

        // 3. BRUTE FORCE HEURISTICS (Priority 1+)
        if (parsed.prefix === 'k') ['n','x','t'].forEach(l => add(l, parsed.numberStr, parsed.root, parsed.tld, 1));
        ['03','01','02','04','05','00'].forEach((n,i) => { if(n !== parsed.numberStr) add(parsed.prefix, n, parsed.root, parsed.tld, 2+i*0.1); });
        FALLBACK_PREFIXES.filter(l => l !== parsed.prefix && l !== 'k').forEach((l,i) => add(l, parsed.numberStr, parsed.root, parsed.tld, 3+i*0.1));
        FALLBACK_ROOTS.forEach(root => { const [r,t] = root.split('.'); if(r !== parsed.root) add(parsed.prefix, parsed.numberStr, r, t, 4); });

        const unique = new Set();
        return cand.sort((a,b) => a.p - b.p)
                   .filter(c => !unique.has(c.url) && unique.add(c.url))
                   .map(c => c.url)
                   .slice(0, CONFIG.MAX_ATTEMPTS); 
    }

    function applyFix(img, url) {
        const ok = parseSubdomain(url);
        if (!ok) return;

        // Save context
        const pathKey = getCacheKeyFromSrc(img.dataset.originalSrc || img.src);
        if (pathKey) {
            serverCache.set(pathKey, { prefix: ok.prefix, number: ok.numberStr, root: ok.root, tld: ok.tld });
            markStorageDirty();
        }
        registerGoodServer(ok);
        perf.successes++;

        // Apply
        img.referrerPolicy = 'no-referrer';
        img.src = url;
        if (img.srcset) img.srcset = url;
        
        img.dataset.batoFixing = 'done';
        img.dataset.batoFixed = 'true';
        delete img.dataset.batoFixStart;
        brokenImageRegistry.delete(img);

        // Broadcast
        const sig = getServerSignature(ok.prefix, ok.numberStr, ok.root, ok.tld);
        const host = `${ok.prefix}${ok.numberStr}.${ok.root}.${ok.tld}`;
        
        // Massive Broadcast with Fallback
        brokenImageRegistry.forEach(otherImg => {
            if (otherImg === img || otherImg.dataset.batoFixing === 'done') return;
            const p = parseSubdomain(otherImg.src);
            if (!p || (p.prefix === ok.prefix && p.numberStr === ok.numberStr)) return;
            
            if (!otherImg.dataset.originalSrc) otherImg.dataset.originalSrc = otherImg.src;
            
            // [FIXED] Do NOT mark as done immediately. 
            // Mark as 'broadcasting' and let the load event confirm it.
            otherImg.dataset.batoFixing = 'broadcasting';
            
            otherImg.addEventListener('error', function onBroadcastFail() {
                 otherImg.dataset.batoFixing = 'failed';
                 // Re-queue the image for a full individual scan
                 addToQueue(otherImg, 'high');
            }, { once: true });

            otherImg.addEventListener('load', function onBroadcastSuccess() {
                 if (otherImg.naturalWidth > 0) {
                     otherImg.dataset.batoFixing = 'done';
                     brokenImageRegistry.delete(otherImg);
                 }
            }, { once: true });

            otherImg.src = `https://${host}${p.path}`;
        });
    }

    async function fixImage(img) {
        if (img.dataset.batoFixing === 'true' || img.dataset.batoFixing === 'done') return;
        img.dataset.batoFixing = 'true';
        img.dataset.batoFixStart = Date.now().toString();

        const parsed = parseSubdomain(img.src);
        if (!parsed) { img.dataset.batoFixing = 'failed'; return; }

        try {
            const candidates = generateCandidates(parsed);
            const winner = await findFastestCandidate(candidates);
            applyFix(img, winner);
        } catch (e) {
            img.dataset.batoFixing = 'failed';
            perf.failures++;
            // Note: It stays in brokenImageRegistry, so a future broadcast might save it.
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
        img.dataset.originalSrc = img.src;
        img.dataset.batoPreemptive = 'true';
        img.referrerPolicy = 'no-referrer';

        const slowTimer = setTimeout(() => {
             if (img.dataset.batoPreemptive === 'true' && !img.complete) {
                 addToQueue(img, 'high'); 
             }
        }, 1500);

        const cleanup = () => { clearTimeout(slowTimer); };

        img.addEventListener('error', () => {
            cleanup();
            img.src = img.dataset.originalSrc;
            img.dataset.batoPreemptive = 'failed';
            addToQueue(img, 'high');
        }, { once: true });

        img.addEventListener('load', () => {
            cleanup();
            if (img.naturalWidth > 0) {
                img.dataset.batoPreemptive = '';
                img.dataset.batoFixing = 'done';
                perf.successes++;
            } else {
                img.dispatchEvent(new Event('error')); 
            }
        }, { once: true });

        img.src = newUrl;
        return true;
    }

    function init() {
        log('BatoFixer v7 (Robust)');
        loadFromStorage();

        // Harvester
        document.addEventListener('load', e => {
            if (e.target.tagName === 'IMG' && isBatoImage(e.target.src) && e.target.naturalWidth > 0) {
                const p = parseSubdomain(e.target.src);
                if (p) registerGoodServer(p);
            }
        }, true);

        // Initial Scan
        document.querySelectorAll('img').forEach(img => {
            if (isBatoImage(img.src)) {
                if (img.complete) {
                    if (img.naturalWidth === 0) addToQueue(img, 'high');
                    else registerGoodServer(parseSubdomain(img.src));
                } else {
                    img.addEventListener('error', () => addToQueue(img, 'high'), { once: true });
                }
            }
        });

        // Observer
        new MutationObserver(mutations => {
            mutations.forEach(m => m.addedNodes.forEach(n => {
                if (n.tagName === 'IMG' && isBatoImage(n.src)) {
                    if (!n.complete) n.addEventListener('error', () => addToQueue(n, 'high'), { once: true });
                }
                if (n.querySelectorAll) n.querySelectorAll('img').forEach(i => {
                    if (isBatoImage(i.src) && !i.complete) i.addEventListener('error', () => addToQueue(i, 'high'), { once: true });
                });
            }));
        }).observe(document.body, { childList: true, subtree: true });

        setInterval(() => {
            const now = Date.now();
            document.querySelectorAll('[data-bato-fixing="true"]').forEach(img => {
                if ((now - parseInt(img.dataset.batoFixStart||0)) > 20000) {
                    img.dataset.batoFixing = 'failed';
                    brokenImageRegistry.add(img);
                }
            });
            if (storageDirty) saveToStorage();
        }, 5000);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
