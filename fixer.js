(() => {

const PROBE_TIMEOUT   = 5000;
const MAX_ATTEMPTS    = 20;
const MAX_SERVER_NUM  = 15;
const RETRY_DELAY     = 1000;
const BATCH_SIZE      = 3;
const CACHE_LIMIT     = 2000;
const DEBUG           = false;
const MAX_CONCURRENT_PROBES = 4;


const STORAGE_KEY_CACHE   = 'bato_fixer_cache_v2';
const STORAGE_KEY_CONTEXT = 'bato_fixer_context_v2';

const FALLBACK_PREFIXES = ['n', 'x', 't', 's', 'w', 'm', 'c', 'u', 'k'];
const FALLBACK_ROOTS = [
  'mbdny.org','mbrtz.org','bato.to','mbwbm.org','mbznp.org','mbqgu.org',
  'mbtba.org','mbhiz.org','mbwnp.org','mbxma.org','mbwww.org','mbmyj.org',
  'mbeaj.org','mbzcp.org','mbuul.org','mbtmv.org','mbimg.org','mbopg.org',
  'mbfpu.org'
];
const IGNORE_PATTERNS = [
  '/rec?','pubadx','adform','criteo','doubleclick',
  'googlesyndication','monetix','/ads/','googleapis.com'
];

const SUBDOMAIN_RE = /^https?:\/\/([a-z]+)(\d+)\.([a-z0-9\-]+)\.([a-z]{2,})(\/.*)$/i;
const BATO_PATTERN = /^https?:\/\/[a-z]+\d+\.[a-z0-9\-]+\.[a-z]{2,}\/media\//i;

let serverCache       = new Map();
let failedCache       = new Set();
let knownGoodServers  = new Set();
let discoveredServers = [];

const processingQueue = {
  high: [],
  low: [],
  isProcessing: false
};

let activeProbes = 0;
let storageDirty = false;
let storageSaveTimeout;

const perf = {
  startTime: Date.now(),
  imagesProcessed: 0,
  probesMade: 0,
  successes: 0,
  failures: 0,
  batoImagesFound: 0,
  totalImagesScanned: 0
};

function log(...args){ if (DEBUG) console.log('[BatoFixer]', ...args); }

function logImage(img,msg){
  if (!DEBUG) return;
  const src = img.src ? img.src.slice(0,60)+'…' : 'no-src';
  const nat = img.complete ? `${img.naturalWidth}×${img.naturalHeight}` : 'not complete';
  console.log('[BatoFixer]', msg, {
    src, natural:nat,
    complete: img.complete,
    dataset : {...img.dataset}
  });
}

function logPerf() {
  if (DEBUG && perf.imagesProcessed > 0) {
    const uptime = (Date.now() - perf.startTime) / 1000;
    console.log(`[BatoFixer Perf] ${perf.imagesProcessed} images (${perf.batoImagesFound} bato), ${perf.probesMade} probes, ${perf.successes} successes, ${perf.failures} failures in ${uptime.toFixed(1)}s`);
  }
}

setInterval(logPerf, 60000);

function loadFromStorage(){
  try{
    const c = localStorage.getItem(STORAGE_KEY_CACHE);
    if (c) serverCache = new Map(JSON.parse(c));
    const k = localStorage.getItem(STORAGE_KEY_CONTEXT);
    if (k) knownGoodServers = new Set(JSON.parse(k));
    log(`Loaded ${knownGoodServers.size} known servers, ${serverCache.size} cache entries`);
  }catch(e){
    if (DEBUG) console.error('[BatoFixer] Storage load error:', e);
  }
}

function saveToStorage(){
  if (!storageDirty) return;
  
  try{
    if (serverCache.size > CACHE_LIMIT) {
      const entries = Array.from(serverCache.entries());
      serverCache = new Map(entries.slice(-CACHE_LIMIT));
    }
    
    if (knownGoodServers.size > 50) {
      const servers = Array.from(knownGoodServers);
      knownGoodServers = new Set(servers.slice(-50));
    }
    
    localStorage.setItem(STORAGE_KEY_CACHE, JSON.stringify([...serverCache]));
    localStorage.setItem(STORAGE_KEY_CONTEXT, JSON.stringify([...knownGoodServers]));
    storageDirty = false;
    log('Saved to storage');
  }catch(e){
    if (DEBUG) console.error('[BatoFixer] Storage save error:', e);
  }
}

function markStorageDirty() {
  storageDirty = true;
  if (!storageSaveTimeout) {
    storageSaveTimeout = setTimeout(() => {
      saveToStorage();
      storageSaveTimeout = null;
    }, 2000);
  }
}

function isBatoImage(src) {
  if (!src) return false;
  return BATO_PATTERN.test(src);
}

function shouldIgnore(src) {
  if (!src) return true;
  if (!isBatoImage(src)) return true;
  return IGNORE_PATTERNS.some(p => src.includes(p));
}

function parseSubdomain(src){
  const m = src.match(SUBDOMAIN_RE);
  if (!m) return null;
  return {
    prefix   : m[1].toLowerCase(),
    numberStr: m[2],
    numberInt: +m[2],
    root     : m[3].toLowerCase(),
    tld      : m[4].toLowerCase(),
    path     : m[5]
  };
}

function getServerSignature(p,n,r,t){
  return `${p}|${n}|${r}|${t}`;
}

function getCacheKeyFromSrc(src) {
  const parsed = parseSubdomain(src);
  if (!parsed) return null;
  
  const mediaIndex = parsed.path.indexOf('/media/');
  if (mediaIndex === -1) return null;
  
  const pathPart = parsed.path.substring(mediaIndex);
  const segments = pathPart.split('/').slice(0, 4).join('/');
  
  return `${parsed.root}-${segments}`;
}

function addToQueue(img, priority = 'low') {
  if (shouldIgnore(img.src)) return;
  if (img.dataset.batoQueued) return;
  
  if (priority === 'auto') {
    const rect = img.getBoundingClientRect();
    const windowHeight = window.innerHeight;
    const windowWidth = window.innerWidth;
    
    priority = (
      rect.bottom > -100 && 
      rect.top < windowHeight + 500 &&
      rect.right > -100 && 
      rect.left < windowWidth + 500
    ) ? 'high' : 'low';
  }
  
  img.dataset.batoQueued = priority;
  
  if (priority === 'high') {
    if (!processingQueue.high.includes(img)) {
      processingQueue.high.push(img);
    }
  } else {
    if (!processingQueue.low.includes(img)) {
      processingQueue.low.push(img);
    }
  }
  
  processQueue();
}

async function processQueue() {
  if (processingQueue.isProcessing) return;
  processingQueue.isProcessing = true;
  
  while (processingQueue.high.length > 0 || processingQueue.low.length > 0) {
    const batch = [];
    
    while (batch.length < BATCH_SIZE && processingQueue.high.length > 0) {
      const img = processingQueue.high.shift();
      if (img.isConnected && !shouldIgnore(img.src)) {
        delete img.dataset.batoQueued;
        batch.push(img);
      }
    }
    
    while (batch.length < BATCH_SIZE && processingQueue.low.length > 0) {
      const img = processingQueue.low.shift();
      if (img.isConnected && !shouldIgnore(img.src)) {
        delete img.dataset.batoQueued;
        batch.push(img);
      }
    }
    
    if (batch.length === 0) break;
    
    await Promise.allSettled(
      batch.map(img => {
        if (img.isConnected) {
          return processImage(img);
        }
      })
    );
    
    // Yield to main thread
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  
  processingQueue.isProcessing = false;
}

function registerGoodServer(input){
  let prefix, numberStr, root, tld;

  if (typeof input === 'string'){
    [prefix, numberStr, root, tld] = input.split('|');
  }else if (input && 'prefix' in input){
    ({prefix, numberStr, root, tld} = input);
  }else if (input && 'p' in input){
    prefix = input.p; numberStr = input.n; root = input.r; tld = input.t;
  }

  if (!prefix || !numberStr || !root || !tld) return;

  const sig = getServerSignature(prefix, numberStr, root, tld);
  if (knownGoodServers.has(sig)) return;

  knownGoodServers.add(sig);
  if (!discoveredServers.includes(sig)) discoveredServers.push(sig);
  markStorageDirty();
  log(`Registered good server: ${sig}`);
}

async function controlledProbe(url, timeout = PROBE_TIMEOUT) {
  const hostKey = url.split('/').slice(0,3).join('/');
  if (failedCache.has(hostKey)) {
    return Promise.reject('cached-fail');
  }
  
  // Wait if too many active probes
  while (activeProbes >= MAX_CONCURRENT_PROBES) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  
  activeProbes++;
  perf.probesMade++;
  
  try {
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.referrerPolicy = 'no-referrer';
      let timeoutId = setTimeout(() => {
        img.src = '';
        failedCache.add(hostKey);
        activeProbes--;
        reject('timeout');
      }, timeout);
      
      img.onload = () => {
        clearTimeout(timeoutId);
        if (img.width > 1 || img.height > 1) {
          activeProbes--;
          resolve(true);
        } else {
          failedCache.add(hostKey);
          activeProbes--;
          reject('empty');
        }
      };
      
      img.onerror = () => {
        clearTimeout(timeoutId);
        failedCache.add(hostKey);
        activeProbes--;
        reject('error');
      };
      
      img.src = url;
    });
  } catch (error) {
    activeProbes--;
    throw error;
  }
}

function getDiscoveredCandidates(parsed){
  const out = [];
  for (const sig of discoveredServers){
    const [p,n,r,t] = sig.split('|');
    out.push(`https://${parsed.prefix}${n}.${parsed.root}.${parsed.tld}${parsed.path}`);
    if (parsed.root === r || parsed.tld === t) {
      out.push(`https://${p}${n}.${parsed.root}.${parsed.tld}${parsed.path}`);
    }
    out.push(`https://${p}${n}.${r}.${t}${parsed.path}`);
  }
  return [...new Set(out)];
}

function generateCandidates(parsed){
  const cand = [];
  const pathKey = getCacheKeyFromSrc(`https://${parsed.prefix}${parsed.numberStr}.${parsed.root}.${parsed.tld}${parsed.path}`);
  
  const add = (p, n, r, t, prio) => {
    const nStr = ('' + n).padStart(2, '0');
    cand.push({
      url: `https://${p}${nStr}.${r}.${t}${parsed.path}`,
      priority: prio
    });
  };

  /* -1 known good servers */
  knownGoodServers.forEach(sig => {
    const [p, n, r, t] = sig.split('|');
    if (p !== parsed.prefix || n !== parsed.numberStr || r !== parsed.root) {
      add(p, n, r, t, -1);
    }
  });

  /* 0 server cache */
  if (pathKey && serverCache.has(pathKey)){
    const c = serverCache.get(pathKey);
    add(c.prefix, c.number, c.root, c.tld, 0);
  }

  /* 1 k-prefix special */
  if (parsed.prefix === 'k') {
    ['n','x','t'].forEach(l => add(l, parsed.numberStr, parsed.root, parsed.tld, 1));
  }

  /* 2 same prefix common numbers */
  ['03','01','02','04','05','00'].forEach((num, i) => {
    if (num !== parsed.numberStr) {
      add(parsed.prefix, num, parsed.root, parsed.tld, 2 + i * 0.1);
    }
  });

  /* 3 alternate prefixes */
  FALLBACK_PREFIXES.filter(l => l !== parsed.prefix && l !== 'k')
                   .forEach((l, i) => add(l, parsed.numberStr, parsed.root, parsed.tld, 3 + i * 0.1));

  /* 4 alternate roots */
  FALLBACK_ROOTS.forEach(root => {
    const [r, t] = root.split('.');
    if (r !== parsed.root) {
      add(parsed.prefix, parsed.numberStr, r, t, 4);
      if (parsed.prefix === 'k') add('n', parsed.numberStr, r, t, 4);
    }
  });

  /* 5 higher numbers */
  for (let i = 6; i <= MAX_SERVER_NUM; i++) {
    if (i !== parsed.numberInt) {
      add(parsed.prefix, i, parsed.root, parsed.tld, 5);
    }
  }

  return [...new Set(
    cand.sort((a, b) => a.priority - b.priority).map(c => c.url)
  )].slice(0, MAX_ATTEMPTS);
}

function rewriteSrcset(srcset, working){
  if (!srcset) return null;
  const p = parseSubdomain(working);
  if (!p) return null;
  const base = `https://${p.prefix}${p.numberStr}.${p.root}.${p.tld}`;
  return srcset.replace(/https?:\/\/[a-z]+\d+\.[a-z0-9\-]+\.[a-z]{2,}/gi, base);
}

function applyFix(img, url, originalParsed){
  const ok = parseSubdomain(url);
  if (!ok) return;
  
  const pathKey = getCacheKeyFromSrc(img.dataset.originalSrc || img.src);
  if (pathKey) {
    serverCache.set(pathKey, {
      prefix: ok.prefix,
      number: ok.numberStr,
      root: ok.root,
      tld: ok.tld
    });
    markStorageDirty();
  }
  
  registerGoodServer(ok);
  perf.successes++;
  
  img.referrerPolicy = 'no-referrer';
  img.src = url;
  
  if (img.srcset) {
    const ns = rewriteSrcset(img.srcset, url);
    if (ns) img.srcset = ns;
  }
  
  img.dataset.batoFixing = 'done';
  img.dataset.batoFixed = 'true';
  logImage(img, 'Image fixed successfully');
  
  // Broadcast to other broken images
  const sig = getServerSignature(ok.prefix, ok.numberStr, ok.root, ok.tld);
  broadcastToBrokenImages(sig, img);
}

function broadcastToBrokenImages(sig, skip = null) {
  const [p, n, r, t] = sig.split('|');
  const host = `${p}${n}.${r}.${t}`;
  
  const brokenSelectors = [
    'img[data-bato-fixing="failed"]',
    'img[data-bato-preemptive="failed"]'
  ];
  
  const brokenImages = document.querySelectorAll(brokenSelectors.join(', '));
  
  for (const img of brokenImages) {
    if (img === skip) continue;
    if (img.dataset.batoFixing === 'done') continue;
    if (shouldIgnore(img.src)) continue;
    
    const parsed = parseSubdomain(img.src);
    if (!parsed) continue;
    if (parsed.prefix === p && parsed.numberStr === n && parsed.root === r && parsed.tld === t) continue;
    
    const hostPattern = `https://${host}`;
    if (failedCache.has(hostPattern)) continue;
    
    // Save original if not already saved
    if (!img.dataset.originalSrc) img.dataset.originalSrc = img.src;
    if (!img.dataset.originalSrcset && img.srcset) {
      img.dataset.originalSrcset = img.srcset;
    }
    
    const newUrl = `https://${host}${parsed.path}`;
    img.dataset.batoTestingNewServer = sig;
    img.referrerPolicy = 'no-referrer';
    img.src = newUrl;
    
    if (img.srcset) {
      const ns = rewriteSrcset(img.srcset, newUrl);
      if (ns) img.srcset = ns;
    }
    
    const onError = () => {
      if (img.dataset.batoTestingNewServer === sig) {
        img.removeEventListener('error', onError);
        if (img.dataset.originalSrc) img.src = img.dataset.originalSrc;
        if (img.dataset.originalSrcset) img.srcset = img.dataset.originalSrcset;
        img.dataset.batoTestingNewServer = '';
        failedCache.add(hostPattern);
      }
    };
    
    const onLoad = () => {
      if (img.dataset.batoTestingNewServer === sig) {
        img.removeEventListener('load', onLoad);
        img.dataset.batoTestingNewServer = '';
        img.dataset.batoFixing = 'done';
        img.dataset.batoFixed = 'true';
        registerGoodServer(sig);
        perf.successes++;
      }
    };
    
    img.addEventListener('error', onError, { once: true });
    img.addEventListener('load', onLoad, { once: true });
  }
}

async function fixImage(img) {
  if (img.dataset.batoFixing === 'true' || img.dataset.batoFixing === 'done') return;
  if (shouldIgnore(img.src)) return;
  
  img.dataset.batoFixing = 'true';
  const parsed = parseSubdomain(img.src);
  if (!parsed) {
    img.dataset.batoFixing = 'failed';
    return;
  }
  
  try {
    // Try discovered candidates first
    const discoveredCandidates = getDiscoveredCandidates(parsed);
    const allCandidates = [...discoveredCandidates, ...generateCandidates(parsed)];
    const uniqueCandidates = [...new Set(allCandidates)].slice(0, MAX_ATTEMPTS);
    
    for (let i = 0; i < uniqueCandidates.length; i += BATCH_SIZE) {
      const batch = uniqueCandidates.slice(i, i + BATCH_SIZE);
      const filteredBatch = batch.filter(url => {
        const hostKey = url.split('/').slice(0, 3).join('/');
        return !failedCache.has(hostKey);
      });
      
      if (filteredBatch.length === 0) continue;
      
      const results = await Promise.allSettled(
        filteredBatch.map(url => controlledProbe(url))
      );
      
      for (let j = 0; j < results.length; j++) {
        if (results[j].status === 'fulfilled' && results[j].value === true) {
          applyFix(img, filteredBatch[j], parsed);
          return;
        }
      }
      
      // Small delay between batches
      if (i + BATCH_SIZE < uniqueCandidates.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    throw new Error('No working candidate found');
  } catch (error) {
    img.dataset.batoFixing = 'failed';
    perf.failures++;
    logImage(img, `Fix failed: ${error.message}`);
  }
}

function preemptiveFix(img) {
  if (shouldIgnore(img.src)) return false;
  const parsed = parseSubdomain(img.src);
  if (!parsed) return false;
  if (img.complete && img.naturalWidth > 0) return false;
  
  let candidate = null;
  
  // 1. Try discovered servers
  for (const sig of discoveredServers) {
    const [p, n, r, t] = sig.split('|');
    if (p !== parsed.prefix || n !== parsed.numberStr || r !== parsed.root) {
      candidate = { p, n, r, t };
      break;
    }
  }
  
  // 2. Try known good servers
  if (!candidate) {
    for (const sig of knownGoodServers) {
      const [p, n, r, t] = sig.split('|');
      if (p !== parsed.prefix || n !== parsed.numberStr || r !== parsed.root) {
        candidate = { p, n, r, t };
        break;
      }
    }
  }
  
  // 3. Try cache
  if (!candidate) {
    const pathKey = getCacheKeyFromSrc(img.src);
    if (pathKey && serverCache.has(pathKey)) {
      const c = serverCache.get(pathKey);
      candidate = { p: c.prefix, n: c.number, r: c.root, t: c.tld };
    } else if (parsed.prefix === 'k') {
      candidate = { p: 'n', n: parsed.numberStr, r: parsed.root, t: parsed.tld };
    } else {
      return false;
    }
  }
  
  img.addEventListener('load', function onLoad() {
    img.removeEventListener('load', onLoad);
    if (img.dataset.batoPreemptive === 'true') {
      img.dataset.batoPreemptive = '';
      img.dataset.batoFixed = 'true';
      img.dataset.batoFixing = 'done';
      registerGoodServer(candidate);
      perf.successes++;
      logImage(img, 'Pre-emptive fix succeeded');
    }
  }, { once: true });
  
  const newUrl = `https://${candidate.p}${candidate.n}.${candidate.r}.${candidate.t}${parsed.path}`;
  img.dataset.originalSrc = img.src;
  img.referrerPolicy = 'no-referrer';
  img.src = newUrl;
  
  if (img.srcset) {
    img.dataset.originalSrcset = img.srcset;
    const ns = rewriteSrcset(img.srcset, newUrl);
    if (ns) img.srcset = ns;
  }
  
  img.dataset.batoPreemptive = 'true';
  return true;
}

async function processImage(img) {
  perf.imagesProcessed++;
  
  if (shouldIgnore(img.src)) return;
  
  const parsed = parseSubdomain(img.src);
  if (!parsed) return;
  
  if (img.complete && img.naturalWidth > 0) {
    registerGoodServer(parsed);
    return;
  }
  

  const alreadyBroken = img.complete && img.naturalWidth === 0;
  
  if (alreadyBroken) {
    if (!preemptiveFix(img)) {
      await fixImage(img);
    }
    return;
  }
  

  const shouldTryPreemptive = 
    parsed.prefix === 'k' ||
    (!img.complete && (knownGoodServers.size > 0 || discoveredServers.length > 0));
  
  if (shouldTryPreemptive) {
    if (preemptiveFix(img)) {
      // Schedule a check to see if preemptive fix worked
      setTimeout(() => checkImageStatus(img), 2000);
    } else {
      setTimeout(() => checkImageStatus(img), 1500);
    }
  } else {
    setTimeout(() => checkImageStatus(img), 1000);
  }
  
  // Add error listener
  img.addEventListener('error', () => {
    if (shouldIgnore(img.src)) return;
    setTimeout(() => {
      if (img.dataset.batoFixing !== 'done' && img.dataset.batoFixing !== 'true') {
        fixImage(img);
      }
    }, 100);
  }, { once: true });
}

function checkImageStatus(img) {
  if (shouldIgnore(img.src)) return;
  
  // Learn from successful loads
  if (img.complete && img.naturalWidth > 0) {
    const p = parseSubdomain(img.src);
    if (p) registerGoodServer(p);
    return;
  }
  
  // Handle preemptive fix failures
  if (img.dataset.batoPreemptive === 'true' && img.complete && img.naturalWidth === 0) {
    if (img.dataset.originalSrc) {
      img.src = img.dataset.originalSrc;
      if (img.dataset.originalSrcset) img.srcset = img.dataset.originalSrcset;
    }
    img.dataset.batoPreemptive = 'failed';
    fixImage(img);
    return;
  }
  
  // Handle broken images
  if (img.complete && img.naturalWidth === 0 && img.dataset.batoFixing !== 'done') {
    fixImage(img);
  }
}

function initialScan() {
  const allImages = document.querySelectorAll('img');
  perf.totalImagesScanned = allImages.length;
  
  const visibleImages = [];
  const hiddenImages = [];
  
  for (const img of allImages) {
    if (!isBatoImage(img.src)) continue;
    
    perf.batoImagesFound++;
    img.dataset.batoScanned = 'true';
    
    const rect = img.getBoundingClientRect();
    const windowHeight = window.innerHeight;
    const windowWidth = window.innerWidth;
    

    if (rect.bottom > -100 && 
        rect.top < windowHeight + 500 &&
        rect.right > -100 && 
        rect.left < windowWidth + 500) {
      visibleImages.push(img);
    } else {
      hiddenImages.push(img);
    }
  }
  
  log(`Found ${perf.batoImagesFound} Bato images (${visibleImages.length} visible, ${hiddenImages.length} hidden)`);
  

  for (const img of visibleImages) {
    addToQueue(img, 'high');
  }
  
  if (hiddenImages.length > 0) {
    setTimeout(() => {
      for (const img of hiddenImages) {
        addToQueue(img, 'low');
      }
    }, 1000);
  }
}

function createOptimizedObserver() {
  let mutationTimeout;
  
  const processMutations = (mutations) => {
    const addedImages = new Set();
    
    for (const mutation of mutations) {
      if (mutation.addedNodes.length) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === 1) { // Element
            if (node.tagName === 'IMG' && isBatoImage(node.src)) {
              addedImages.add(node);
            }
            if (node.querySelectorAll) {
              node.querySelectorAll('img').forEach(img => {
                if (isBatoImage(img.src)) {
                  addedImages.add(img);
                }
              });
            }
          }
        }
      }
      
      if (mutation.type === 'attributes' && 
          mutation.target.tagName === 'IMG' &&
          (mutation.attributeName === 'src' || mutation.attributeName === 'srcset')) {
        const img = mutation.target;
        if (isBatoImage(img.src)) {
          addedImages.add(img);
        }
      }
    }
    
    for (const img of addedImages) {
      if (!img.dataset.batoScanned) {
        img.dataset.batoScanned = 'true';
        perf.batoImagesFound++;
        addToQueue(img, 'auto');
      }
    }
  };
  
  const observer = new MutationObserver((mutations) => {
    // Debounce mutations
    clearTimeout(mutationTimeout);
    mutationTimeout = setTimeout(() => {
      requestAnimationFrame(() => {
        processMutations(mutations);
      });
    }, 50);
  });
  
  return observer;
}

function setupVisibilityObserver() {
  if (!('IntersectionObserver' in window)) return null;
  
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const img = entry.target;
        if (isBatoImage(img.src) && !img.dataset.batoProcessed) {
          img.dataset.batoProcessed = 'true';
          addToQueue(img, 'high');
        }
        observer.unobserve(img);
      }
    });
  }, {
    root: null,
    rootMargin: '500px',
    threshold: 0.01
  });
  
  return observer;
}

function init() {
  log('Initializing BatoFixer');
  loadFromStorage();

  const visibilityObserver = setupVisibilityObserver();
  
  // Initial scan
  initialScan();
  
  const mutationObserver = createOptimizedObserver();
  mutationObserver.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'srcset']
  });

  document.addEventListener('load', (e) => {
    if (e.target.tagName === 'IMG' && isBatoImage(e.target.src)) {
      const p = parseSubdomain(e.target.src);
      if (p) registerGoodServer(p);
    }
  }, true);
  
  // Set up periodic cleanup
  setInterval(() => {
    const now = Date.now();
    document.querySelectorAll('[data-bato-fixing="true"]').forEach(img => {
      const startTime = parseInt(img.dataset.batoFixStart || '0');
      if (now - startTime > 30000) { // 30 seconds timeout
        img.dataset.batoFixing = 'failed';
        delete img.dataset.batoFixStart;
      }
    });
    
    if (storageDirty) {
      saveToStorage();
    }
  }, 10000);
  
  log('BatoFixer ready');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
})();
