(() => {
  
  // --- CONFIGURATION ---
  const PROBE_TIMEOUT = 5000; 
  const MAX_ATTEMPTS = 30;
  const MAX_SERVER_NUM = 15;
  const RETRY_DELAY = 1000; 
  const BATCH_SIZE = 4;
  const CACHE_LIMIT = 2000;
  
  // Storage Keys
  const STORAGE_KEY_CACHE = 'bato_fixer_cache_v1';
  const STORAGE_KEY_CONTEXT = 'bato_fixer_context_v1';

  const FALLBACK_PREFIXES = ['n', 'x', 't', 's', 'w', 'm', 'c', 'u', 'k'];
  
  const FALLBACK_ROOTS = [
    'mbdny.org', 'mbrtz.org', 'bato.to', 'mbwbm.org', 'mbznp.org', 'mbqgu.org',
    'mbtba.org', 'mbhiz.org', 'mbwnp.org', 'mbxma.org', 'mbwww.org', 'mbmyj.org',
    'mbeaj.org', 'mbzcp.org', 'mbuul.org', 'mbtmv.org', 'mbimg.org', 
    'mbopg.org', 'mbfpu.org' 
  ];

  const IGNORE_PATTERNS = [
    '/rec?', 'pubadx', 'adform', 'criteo', 'doubleclick', 'googlesyndication', 'monetix', '/ads/'
  ];
  
  const SUBDOMAIN_RE = /^https?:\/\/([a-z]+)(\d+)\.([a-z0-9\-]+)\.([a-z]{2,})(\/.*)$/i;
  
  // --- STATE ---
  let serverCache = new Map();
  let failedCache = new Set(); 
  const processingImages = new WeakSet();
  let knownGoodServers = new Set();
  let brokenImages = new WeakSet(); // Track known broken images

  // --- STORAGE HELPERS ---
  function loadFromStorage() {
    try {
      const cached = localStorage.getItem(STORAGE_KEY_CACHE);
      if (cached) {
        serverCache = new Map(JSON.parse(cached));
      }

      const context = localStorage.getItem(STORAGE_KEY_CONTEXT);
      if (context) {
        knownGoodServers = new Set(JSON.parse(context));
      }
    } catch (e) {
      // Storage load failed
    }
  }

  function saveToStorage() {
    try {
      // Limit size before saving to prevent storage quotas issues
      if (serverCache.size > CACHE_LIMIT) {
        const entries = Array.from(serverCache.entries()).slice(-CACHE_LIMIT);
        serverCache = new Map(entries);
      }
      localStorage.setItem(STORAGE_KEY_CACHE, JSON.stringify(Array.from(serverCache.entries())));
      
      // Only keep the last 20 good servers to keep it fresh
      if (knownGoodServers.size > 20) {
         const recent = Array.from(knownGoodServers).slice(-20);
         knownGoodServers = new Set(recent);
      }
      localStorage.setItem(STORAGE_KEY_CONTEXT, JSON.stringify(Array.from(knownGoodServers)));
    } catch (e) {
      // Storage save failed
    }
  }

  function getServerSignature(p, n, r, t) {
    return `${p}|${n}|${r}|${t}`;
  }

  function shouldIgnore(src) {
    if (!src) return true;
    return IGNORE_PATTERNS.some(pattern => src.includes(pattern));
  }

  function parseSubdomain(src) {
    const m = src.match(SUBDOMAIN_RE);
    if (!m) return null;
    return {
      prefix: m[1].toLowerCase(),
      numberStr: m[2], 
      numberInt: parseInt(m[2], 10),
      root: m[3].toLowerCase(),
      tld: m[4].toLowerCase(),
      path: m[5]
    };
  }

  function probeUrl(url, timeout = PROBE_TIMEOUT) {
    return new Promise((resolve, reject) => {
      const cacheKey = url.split('/').slice(0, 3).join('/');
      
      if (failedCache.size > CACHE_LIMIT) failedCache.clear();

      if (failedCache.has(cacheKey)) {
        reject('cached-fail');
        return;
      }
      
      const img = new Image();
      img.referrerPolicy = "no-referrer";
      
      let timedOut = false;
      const t = setTimeout(() => {
        timedOut = true;
        img.src = "";
        failedCache.add(cacheKey);
        reject('timeout');
      }, timeout);

      img.onload = () => {
        if (!timedOut) {
          clearTimeout(t);
          if (img.width > 1 || img.height > 1) {
            resolve(true);
          } else {
            failedCache.add(cacheKey);
            reject('empty');
          }
        }
      };
      
      img.onerror = () => {
        if (!timedOut) {
          clearTimeout(t);
          failedCache.add(cacheKey);
          reject('error');
        }
      };
      
      img.src = url;
    });
  }

  function generateCandidates(parsed) {
    const candidates = [];
    const pathKey = parsed.path.split('/').slice(0, 3).join('/'); 
    
    const add = (p, n, r, t, priority) => {
      const nStr = typeof n === 'string' ? n : String(n).padStart(2, '0');
      const url = `https://${p}${nStr}.${r}.${t}${parsed.path}`;
      candidates.push({ url, priority });
    };

    knownGoodServers.forEach(sig => {
      const [p, n, r, t] = sig.split('|');
      if (p !== parsed.prefix || n !== parsed.numberStr || r !== parsed.root) {
        add(p, n, r, t, -1);
      }
    });

    const cacheKey = `${parsed.root}-${pathKey}`;
    if (serverCache.has(cacheKey)) {
      const cached = serverCache.get(cacheKey);
      add(cached.prefix, cached.number, cached.root, cached.tld, 0);
    }

    if (parsed.prefix === 'k') {
      add('n', parsed.numberStr, parsed.root, parsed.tld, 1);
      add('x', parsed.numberStr, parsed.root, parsed.tld, 1);
      add('t', parsed.numberStr, parsed.root, parsed.tld, 1);
    }

    FALLBACK_PREFIXES.forEach(letter => {
      if (letter !== parsed.prefix && letter !== 'k' && letter !== 'n') {
        add(letter, parsed.numberStr, parsed.root, parsed.tld, 2);
      }
    });

    for (let i = 0; i <= Math.min(5, MAX_SERVER_NUM); i++) {
      if (i !== parsed.numberInt) {
        add(parsed.prefix, i, parsed.root, parsed.tld, 3);
      }
    }

    FALLBACK_ROOTS.forEach(root => {
      const parts = root.split('.');
      if (parts.length === 2 && parts[0] !== parsed.root) {
        add(parsed.prefix, parsed.numberStr, parts[0], parts[1], 4);
        if (parsed.prefix === 'k') add('n', parsed.numberStr, parts[0], parts[1], 4);
      }
    });

    for (let i = 6; i <= MAX_SERVER_NUM; i++) {
      if (i !== parsed.numberInt) {
        add(parsed.prefix, i, parsed.root, parsed.tld, 5);
      }
    }

    const sorted = candidates
      .sort((a, b) => a.priority - b.priority)
      .map(c => c.url);
    
    return [...new Set(sorted)].slice(0, MAX_ATTEMPTS);
  }

  function rewriteSrcset(srcset, workingUrl) {
    if (!srcset) return null;
    const workingParsed = parseSubdomain(workingUrl);
    if (!workingParsed) return null;
    const newBase = `https://${workingParsed.prefix}${workingParsed.numberStr}.${workingParsed.root}.${workingParsed.tld}`;
    return srcset.replace(/https?:\/\/[a-z]+\d+\.[a-z0-9\-]+\.([a-z]{2,})/gi, newBase);
  }

  function applyFix(img, url, originalParsed) {
    const successParsed = parseSubdomain(url);
    
    if (successParsed) {
      const pathKey = originalParsed.path.split('/').slice(0, 3).join('/');
      const cacheKey = `${originalParsed.root}-${pathKey}`;
      serverCache.set(cacheKey, {
        prefix: successParsed.prefix,
        number: successParsed.numberStr, 
        root: successParsed.root,
        tld: successParsed.tld
      });

      const newSig = getServerSignature(
        successParsed.prefix, successParsed.numberStr, successParsed.root, successParsed.tld
      );
      
      // Add to known good servers
      knownGoodServers.add(newSig);
      
      // Try this new server on other broken images IMMEDIATELY
      tryNewServerOnBrokenImages(newSig, img); // Skip the image we just fixed
      
      saveToStorage(); // PERSIST ON SUCCESS
    }

    img.referrerPolicy = "no-referrer";
    img.src = url;
    if (img.srcset) {
      const newSrcset = rewriteSrcset(img.srcset, url);
      if (newSrcset) img.srcset = newSrcset;
    }

    img.dataset.batoFixing = "done";
    img.dataset.batoFixed = "true";
    processingImages.delete(img);
    brokenImages.delete(img); // Remove from broken images set
  }

  // NEW FUNCTION: Immediately try new server on other broken images
  function tryNewServerOnBrokenImages(newServerSig, skipImage = null) {
    const [p, n, r, t] = newServerSig.split('|');
    
    // Find all broken images
    document.querySelectorAll('img').forEach(img => {
      // Skip if this is the image we just fixed
      if (skipImage && img === skipImage) return;
      
      // Skip if already fixed or being processed
      if (img.dataset.batoFixing === "done" || processingImages.has(img)) return;
      
      // Only try on images we know are broken
      if (!brokenImages.has(img) && 
          img.dataset.batoPreemptive !== "failed" && 
          !(img.complete && img.naturalWidth === 0)) {
        return;
      }
      
      if (shouldIgnore(img.src)) return;

      const parsed = parseSubdomain(img.src);
      if (!parsed) return;
      
      // Skip if already same server
      if (parsed.prefix === p && parsed.numberStr === n && parsed.root === r && parsed.tld === t) return;
      
      // Don't try if this server already failed for this image type
      const cacheKey = `${r}-${parsed.path.split('/').slice(0, 3).join('/')}`;
      if (serverCache.has(cacheKey)) {
        const cached = serverCache.get(cacheKey);
        if (cached.prefix === p && cached.number === n && cached.root === r && cached.tld === t) {
          return; // Already in cache for this path
        }
      }
      
      // Don't try servers in failed cache
      const serverPattern = `https://${p}${n}.${r}.${t}`;
      if (failedCache.has(serverPattern)) return;
      
      // Construct the new URL
      const newUrl = `https://${p}${n}.${r}.${t}${parsed.path}`;
      
      // Try it immediately without probing
      console.log(`[BatoFixer] Trying newly learned server ${p}${n}.${r}.${t} on broken image`);
      
      // Mark as testing
      img.dataset.batoTestingNewServer = newServerSig;
      
      // Save original if not already saved
      if (!img.dataset.originalSrc) {
        img.dataset.originalSrc = img.src;
      }
      
      // Change the src
      img.referrerPolicy = "no-referrer";
      img.src = newUrl;
      
      if (img.srcset) {
        if (!img.dataset.originalSrcset) {
          img.dataset.originalSrcset = img.srcset;
        }
        const newSrcset = rewriteSrcset(img.srcset, newUrl);
        if (newSrcset) img.srcset = newSrcset;
      }
      
      // Set up error handler if this doesn't work
      const errorHandler = function() {
        if (img.dataset.batoTestingNewServer === newServerSig) {
          img.removeEventListener('error', errorHandler);
          img.dataset.batoTestingNewServer = "";
          
          // Revert to original
          if (img.dataset.originalSrc) {
            img.src = img.dataset.originalSrc;
          }
          if (img.dataset.originalSrcset) {
            img.srcset = img.dataset.originalSrcset;
          }
          
          // Add to failed cache for this server pattern
          failedCache.add(serverPattern);
        }
      };
      
      img.addEventListener('error', errorHandler, { once: true });
      
      // Set up success handler
      const loadHandler = function() {
        if (img.dataset.batoTestingNewServer === newServerSig) {
          img.removeEventListener('load', loadHandler);
          img.dataset.batoTestingNewServer = "";
          
          // Mark as fixed
          img.dataset.batoFixing = "done";
          img.dataset.batoFixed = "true";
          brokenImages.delete(img);
          
          // Add to known good servers (if not already)
          knownGoodServers.add(newServerSig);
          saveToStorage();
          
          console.log(`[BatoFixer] New server worked for broken image!`);
        }
      };
      
      img.addEventListener('load', loadHandler, { once: true });
    });
  }

  async function fixImage(img, isRetry = false) {
    if (processingImages.has(img)) return;
    if (img.dataset.batoFixing === "done" || (img.dataset.batoFixing === "true" && !isRetry)) return;
    
    if (shouldIgnore(img.src)) return;

    processingImages.add(img);
    img.dataset.batoFixing = "true";

    const parsed = parseSubdomain(img.src);
    if (!parsed) {
      processingImages.delete(img);
      return;
    }

    const candidates = generateCandidates(parsed);
    const probeWithUrl = (url, timeout) => probeUrl(url, timeout).then(() => url);

    try {
      for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
        const batch = candidates.slice(i, i + BATCH_SIZE);
        
        const promises = batch.map(url => {
          const serverPattern = url.split('/').slice(0, 3).join('/');
          if (failedCache.has(serverPattern)) return Promise.reject('cached-fail');
          const timeout = PROBE_TIMEOUT + (i > 5 ? 1000 : 0);
          return probeWithUrl(url, timeout);
        });

        if (promises.length === 0) continue;

        try {
          const workingUrl = await Promise.any(promises);
          applyFix(img, workingUrl, parsed);
          return; 
        } catch (aggregateError) {
          
        }
      }
      throw 'all-candidates-failed';

    } catch (e) {
      if (!isRetry) {
        img.dataset.batoFixing = "retry";
        processingImages.delete(img);
        setTimeout(() => {
          if (img.complete && img.naturalWidth === 0) fixImage(img, true);
        }, RETRY_DELAY);
      } else {
        img.dataset.batoFixing = "failed";
        processingImages.delete(img);
      }
    }
  }

  function preemptiveFix(img) {
    if (shouldIgnore(img.src)) return false;

    const parsed = parseSubdomain(img.src);
    if (!parsed) return false;
    
    let bestCandidate = null;
    
    for (const sig of knownGoodServers) {
        const [p, n, r, t] = sig.split('|');
        if (p !== parsed.prefix || n !== parsed.numberStr || r !== parsed.root) {
            bestCandidate = { p, n, r, t };
            break; 
        }
    }

    if (!bestCandidate) {
        const pathKey = parsed.path.split('/').slice(0, 3).join('/');
        const cacheKey = `${parsed.root}-${pathKey}`;

        if (serverCache.has(cacheKey)) {
            const cached = serverCache.get(cacheKey);
            bestCandidate = { p: cached.prefix, n: cached.number, r: cached.root, t: cached.tld };
        } else if (parsed.prefix === 'k') {
             bestCandidate = { p: 'n', n: parsed.numberStr, r: parsed.root, t: parsed.tld };
        } else {
             return false;
        }
    }
    
    img.addEventListener('load', function() {
      if (img.dataset.batoPreemptive === "true") {
         img.dataset.batoPreemptive = ""; 
         img.dataset.batoFixed = "true";  
         img.dataset.batoFixing = "done"; 
      }
    }, { once: true });

    const newUrl = `https://${bestCandidate.p}${bestCandidate.n}.${bestCandidate.r}.${bestCandidate.t}${parsed.path}`;
    
    img.dataset.originalSrc = img.src;
    img.referrerPolicy = "no-referrer";
    img.src = newUrl;
    
    if (img.srcset) {
      img.dataset.originalSrcset = img.srcset;
      const newSrcset = rewriteSrcset(img.srcset, newUrl);
      if (newSrcset) img.srcset = newSrcset;
    }
    
    img.dataset.batoPreemptive = "true";
    return true;
  }

  function checkImage(img) {
    if (shouldIgnore(img.src)) return;

    if (img.dataset.batoPreemptive === "true" && img.complete && img.naturalWidth === 0) {
      // Mark as broken
      brokenImages.add(img);
      
      if (img.dataset.originalSrc) {
        img.src = img.dataset.originalSrc;
        if (img.dataset.originalSrcset) img.srcset = img.dataset.originalSrcset;
      }
      img.dataset.batoPreemptive = "failed";
      fixImage(img);
      return;
    }
    
    if (img.complete && img.naturalWidth === 0 && img.dataset.batoFixing !== "done") {
      // Mark as broken
      brokenImages.add(img);
      fixImage(img);
    }
  }

  function processNewImage(img) {
    if (shouldIgnore(img.src)) return;

    const parsed = parseSubdomain(img.src);
    
    if (parsed) {
        // Try preemptive fix if we have ANY data (Context OR Cache) OR if it is a 'k' server
        if (knownGoodServers.size > 0 || serverCache.size > 0 || parsed.prefix === 'k') {
             preemptiveFix(img);
             setTimeout(() => checkImage(img), 2000);
        }
    }
    
    img.addEventListener('error', function() {
      if (shouldIgnore(img.src)) return;
      
      setTimeout(() => {
        if (img.dataset.batoFixing !== "done") {
          // Mark as broken
          brokenImages.add(img);
          fixImage(img);
        }
      }, 100);
    }, { once: false });
  }

  function init() {
    // 1. Load data from previous sessions
    loadFromStorage();

    // Enhanced load event listener
    document.addEventListener('load', (e) => {
        if (e.target.tagName === 'IMG') {
            if (shouldIgnore(e.target.src)) return;

            const parsed = parseSubdomain(e.target.src);
            if (parsed) {
                const sig = getServerSignature(parsed.prefix, parsed.numberStr, parsed.root, parsed.tld);
                if (!knownGoodServers.has(sig)) {
                    knownGoodServers.add(sig);
                    saveToStorage(); // PERSIST DISCOVERY
                    
                    // NEW: Immediately try this new server on broken images
                    tryNewServerOnBrokenImages(sig);
                }
            }
        }
    }, true);

    // Check all existing images
    document.querySelectorAll('img').forEach(img => {
      processNewImage(img);
      setTimeout(() => checkImage(img), 1000);
    });

    const observer = new MutationObserver((mutations) => {
      mutations.forEach(mutation => {
        mutation.addedNodes.forEach(node => {
          if (node.tagName === 'IMG') {
            processNewImage(node);
            setTimeout(() => checkImage(node), 1000);
          }
          if (node.querySelectorAll) {
            node.querySelectorAll('img').forEach(img => {
              if (!img.dataset.batoFixing) {
                processNewImage(img);
                setTimeout(() => checkImage(img), 1000);
              }
            });
          }
        });
        
        if (mutation.type === 'attributes' && 
            (mutation.attributeName === 'src' || mutation.attributeName === 'srcset') && 
            mutation.target.tagName === 'IMG') {
          
          const img = mutation.target;
          
          const isPreemptive = img.dataset.batoPreemptive === "true";
          const needsFix = img.dataset.batoFixing !== "done" && !img.dataset.batoFixed;

          if (needsFix && !isPreemptive) {
            if (shouldIgnore(img.src)) return;

            img.dataset.batoFixing = "";
            img.dataset.batoPreemptive = "";
            setTimeout(() => {
              processNewImage(img);
              checkImage(img);
            }, 500);
          }
        }
      });
    });

    observer.observe(document.body, { 
      childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset'] 
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
