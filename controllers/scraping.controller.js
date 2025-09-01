/**
 * Scraping Controller (DuckDuckGo-based)
 * Provides two endpoints:
 *  - GET /api/scraping/search      (paginated single search page)
 *  - GET /api/scraping/search-all  (multi-page comprehensive search)
 *
 * Fully aligned with the Angular front-end interfaces:
 *  ScrapingResponse & ComprehensiveScrapingResponse
 *
 * Key Features:
 *  - Multiple adaptive DuckDuckGo queries (HR focused if hrFocus=true)
 *  - Robust result link extraction from DuckDuckGo HTML endpoints
 *  - Extracts emails from snippets + visited pages
 *  - HR email classification
 *  - Returns stats in the exact structure the frontend expects
 *  - Basic block / throttle detection (returns 429 with needsCaptcha=true style flag)
 *  - Graceful timeouts + abort controllers
 *  - Unified scrapedUrls objects with hr/general/total counts
 *
 * NOTE:
 *  DuckDuckGo does not supply a classic CAPTCHA page like Bing; "captcha" handling here
 *  is heuristic (detects certain block patterns or extremely empty SERPs).
 */

const express = require('express');
const cheerio = require('cheerio');
const router = express.Router();

// ------------------ CONFIG ------------------ //

const MAX_SINGLE_URLS = 20;
const MAX_MULTI_PAGES = 10;
const MAX_MULTI_URLS_PER_PAGE = 20;
const GLOBAL_TIMEOUT_MS = 15000;
const PAGE_TEXT_CHAR_LIMIT = 300_000;

const DUCK_BASE_HTML = 'https://duckduckgo.com/html/?q=';
const DUCK_BASE_LITE = 'https://lite.duckduckgo.com/lite/?q=';

// Regex for emails
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// HR keyword buckets
const HR_EMAIL_KEYWORDS = [
  'hr', 'job', 'jobs', 'career', 'careers', 'recruit', 'recruiter', 'recruitment',
  'talent', 'apply', 'hiring', 'people', 'human', 'resource', 'resources',
  'employment', 'candidature', 'recrutement', 'carriere', 'emploi', 'poste', 'cv'
];

const GENERIC_EXCLUDE_PREFIXES = [
  'info@', 'contact@', 'support@', 'help@', 'noreply@', 'no-reply@', 'newsletter@',
  'marketing@', 'sales@', 'webmaster@', 'admin@', 'postmaster@', 'hello@', 'office@'
];

// Delay helper
const sleep = ms => new Promise(r => setTimeout(r, ms));

// -------------- UTILITIES ------------------ //

function extractEmails(text) {
  if (!text) return [];
  const raw = text.match(EMAIL_REGEX) || [];
  return [...new Set(raw.map(e => e.trim().toLowerCase()))];
}

function classifyEmails(emails, context = '', hrFocus = true) {
  const ctx = (context || '').toLowerCase();
  const hr = [];
  const general = [];

  emails.forEach(email => {
    const lower = email.toLowerCase();
    if (GENERIC_EXCLUDE_PREFIXES.some(p => lower.startsWith(p))) {
      if (!hrFocus) general.push(lower);
      return;
    }

    const hasKeyword = HR_EMAIL_KEYWORDS.some(k => lower.includes(k));
    const namePattern = /^[a-z]+\.[a-z]+@/i.test(lower);
    const contextHas = HR_EMAIL_KEYWORDS.some(k => ctx.includes(k));

    if (hasKeyword || (contextHas && (namePattern || hrFocus)) || (namePattern && hrFocus)) {
      hr.push(lower);
    } else {
      general.push(lower);
    }
  });

  return {
    hr: [...new Set(hr)],
    general: [...new Set(general)],
    all: [...new Set([...hr, ...general])]
  };
}

/**
 * Build an array of DuckDuckGo queries (deduplicated) depending on hrFocus.
 * (Similar strategy as Bing version but adapted wording as needed.)
 */
function buildDuckQueries(baseQuery, hrFocus, country) {
  const q = baseQuery.trim();
  const geo = country ? country.trim() : 'morocco';

  const core = [
    `"${q}" email ${geo}`,
    `"${q}" "contact" ${geo}`,
    `"${q}" "contact us" ${geo}`
  ];

  const hrSet = [
    `"${q}" ("hr" OR "recruitment" OR "careers" OR "jobs") ${geo} email`,
    `"${q}" recrutement emploi carriere email ${geo}`,
    `"${q}" "send your cv" ${geo}`,
    `"${q}" "submit your cv" ${geo}`,
    `"${q}" "postuler" ${geo} email`,
    `"${q}" site:linkedin.com email ${geo}`,
    `"${q}" site:indeed.com email ${geo}`
  ];

  const all = hrFocus ? [...core, ...hrSet] : core;
  return [...new Set(all)];
}

function isLikelyHRPage(url, title) {
  const target = (url + ' ' + (title || '')).toLowerCase();
  return HR_EMAIL_KEYWORDS.some(k => target.includes(k));
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = GLOBAL_TIMEOUT_MS) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...opts,
      headers: {
        'User-Agent': opts.userAgent ||
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        ...(opts.headers || {})
      },
      signal: controller.signal
    });
    clearTimeout(id);
    return res;
  } catch (e) {
    clearTimeout(id);
    throw e;
  }
}

/**
 * DuckDuckGo sometimes rewrites external links through /l/?kh=1&uddg=<encodedURL>
 * This resolves that indirection.
 */
function resolveDuckRedirect(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.hostname.includes('duckduckgo.com') && url.pathname.startsWith('/l/')) {
      const uddg = url.searchParams.get('uddg');
      if (uddg) {
        const decoded = decodeURIComponent(uddg);
        if (/^https?:\/\//i.test(decoded)) return decoded;
      }
    }
    return rawUrl;
  } catch {
    return rawUrl;
  }
}

/**
 * Clean page HTML and return trimmed body text (for email extraction).
 */
function cleanAndExtractBody(html) {
  const $ = cheerio.load(html);
  $('script,style,noscript,iframe,svg,canvas,meta,link,header,footer,nav,aside,form').remove();
  let text = $('body').text() || '';
  text = text.replace(/\r/g, ' ')
    .replace(/\t/g, ' ')
    .replace(/[ \u00A0]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .slice(0, PAGE_TEXT_CHAR_LIMIT);
  return text;
}

/**
 * Extract DuckDuckGo result links from both HTML and LITE versions.
 * We attempt HTML endpoint first; if insufficient, try lite.
 */
async function getDuckLinksForQuery(qStr, maxUrlsPerQuery) {
  const links = new Set();

  // 1. Standard HTML endpoint
  try {
    const res = await fetchWithTimeout(DUCK_BASE_HTML + encodeURIComponent(qStr));
    const html = await res.text();
    const $ = cheerio.load(html);
    $('a.result__a').each((_, a) => {
      const href = $(a).attr('href');
      if (href && /^https?:\/\//i.test(href)) links.add(href);
    });
    // Also decode redirect style links
    $('a[href*="/l/?"]').each((_, a) => {
      const href = $(a).attr('href');
      if (href) {
        const resolved = resolveDuckRedirect(href);
        if (/^https?:\/\//i.test(resolved)) links.add(resolved);
      }
    });
  } catch {
    // ignore, will attempt lite
  }

  // 2. Lite endpoint if we still need more
  if (links.size < maxUrlsPerQuery) {
    try {
      const resLite = await fetchWithTimeout(DUCK_BASE_LITE + encodeURIComponent(qStr));
      const liteHtml = await resLite.text();
      const $lite = cheerio.load(liteHtml);
      $lite('a').each((_, a) => {
        const href = $lite(a).attr('href');
        if (!href) return;
        if (/^https?:\/\//i.test(href)) {
          links.add(href);
        } else if (href.startsWith('/l/?')) {
            const resolved = resolveDuckRedirect('https://duckduckgo.com' + href);
            if (/^https?:\/\//i.test(resolved)) links.add(resolved);
        }
      });
    } catch {
      // ignore
    }
  }

  // Filter internal DDG / duplicates / tracking
  const cleaned = [...links].filter(u =>
    !u.includes('duckduckgo.com') &&
    !u.includes('lite.duckduckgo.com') &&
    /^https?:\/\//i.test(u)
  );

  return cleaned.slice(0, maxUrlsPerQuery * 2); // oversample then slice later
}

// -------------- CORE SCRAPING LOGIC (shared) -------------- //

/**
 * Executes multiple DuckDuckGo queries, collects snippet emails and visits top result URLs.
 * Returns a unified structure for both endpoints.
 */
async function runDuckEmailHunt({
  query,
  hrFocus,
  country,
  maxQueries,
  maxUrlsPerQuery,
  globalUrlBudget
}) {
  const queries = buildDuckQueries(query, hrFocus, country).slice(0, maxQueries);

  const snippetHREmails = new Set();
  const snippetGeneralEmails = new Set();
  const pageHREmails = new Set();
  const pageGeneralEmails = new Set();

  const scrapedUrls = [];
  const failedUrls = [];
  const allSearchUrls = [];
  let totalVisited = 0;
  let blockedDetected = false;

  for (let qi = 0; qi < queries.length; qi++) {
    if (globalUrlBudget !== undefined && totalVisited >= globalUrlBudget) break;

    const qStr = queries[qi];
    if (qi > 0) await sleep(800 + Math.random() * 600);

    let queryLinks = [];
    try {
      queryLinks = await getDuckLinksForQuery(qStr, maxUrlsPerQuery);
    } catch (err) {
      failedUrls.push({
        url: 'duckduckgo:?q=' + qStr,
        error: `Search fetch failed: ${err.name === 'AbortError' ? 'timeout' : err.message}`,
        searchPage: qi + 1,
        type: 'search'
      });
      continue;
    }

    // Heuristic block detection: zero links for a reasonably common query
    if (queryLinks.length === 0) {
      blockedDetected = true;
    }

    // Attempt snippet email extraction using simplified SERP text (lite or html)
    // We'll refetch HTML endpoint for snippet text (cost: 1 extra request only if needed)
    try {
      const respSnippet = await fetchWithTimeout(DUCK_BASE_HTML + encodeURIComponent(qStr));
      const html = await respSnippet.text();
      const snippetText = cleanAndExtractBody(html);
      const snippetEmails = extractEmails(snippetText);
      if (snippetEmails.length) {
        const classified = classifyEmails(snippetEmails, snippetText, hrFocus);
        classified.hr.forEach(e => snippetHREmails.add(e));
        classified.general.forEach(e => snippetGeneralEmails.add(e));
      }
    } catch {
      // silent
    }

    // Visit result pages
    for (const rawLink of queryLinks.slice(0, maxUrlsPerQuery)) {
      if (globalUrlBudget !== undefined && totalVisited >= globalUrlBudget) break;

      const finalUrl = resolveDuckRedirect(rawLink);
      allSearchUrls.push(finalUrl);

      try {
        totalVisited++;
        const pageResp = await fetchWithTimeout(finalUrl);
        if (!pageResp.ok) throw new Error(`HTTP ${pageResp.status}`);

        const pageHtml = await pageResp.text();
        const cleanedText = cleanAndExtractBody(pageHtml);
        const pageEmails = extractEmails(cleanedText);

        const classified = classifyEmails(pageEmails, cleanedText, hrFocus);
        classified.hr.forEach(e => pageHREmails.add(e));
        classified.general.forEach(e => pageGeneralEmails.add(e));

        // mailto:
        const $$ = cheerio.load(pageHtml);
        $$('a[href^="mailto:"]').each((_, a) => {
          const m = $$(a).attr('href');
          if (!m) return;
          const mail = m.replace(/^mailto:/i, '').split('?')[0].trim().toLowerCase();
          if (mail && EMAIL_REGEX.test(mail)) {
            const c = classifyEmails([mail], '', hrFocus);
            c.hr.forEach(e => pageHREmails.add(e));
            c.general.forEach(e => pageGeneralEmails.add(e));
          }
        });

        scrapedUrls.push({
          url: finalUrl,
          searchPage: qi + 1,
          isHRPage: isLikelyHRPage(finalUrl, ''),
          emailCount: {
            hr: classified.hr.length,
            general: classified.general.length,
            total: classified.all.length
          },
          emails: {
            hr: classified.hr,
            general: classified.general,
            all: classified.all
          }
        });
      } catch (err) {
        failedUrls.push({
          url: finalUrl,
          error: err.name === 'AbortError' ? 'timeout' : err.message,
          searchPage: qi + 1,
          type: 'page'
        });
      }
    }
  }

  const hrEmails = [...new Set([...snippetHREmails, ...pageHREmails])];
  const generalEmails = [...new Set(
    [...snippetGeneralEmails, ...pageGeneralEmails].filter(e => !hrEmails.includes(e))
  )];

  return {
    captchaTriggered: false, // DuckDuckGo rarely uses explicit captcha; using blockedDetected indicator
    blockedDetected,
    hrEmails,
    generalEmails,
    scrapedUrls,
    failedUrls,
    allSearchUrls,
    stats: {
      snippetHr: snippetHREmails.size,
      snippetGeneral: snippetGeneralEmails.size,
      pageHr: pageHREmails.size,
      pageGeneral: pageGeneralEmails.size
    }
  };
}

// -------------- ENDPOINT: /search (paginated) -------------- //

router.get('/search', async (req, res) => {
  const {
    query,
    urls = 5,
    page = 1,
    limit = 10,
    country = 'morocco',
    hrFocus = 'true'
  } = req.query;

  if (!query) {
    return res.status(400).json({
      error: 'Missing parameter: query',
      usage: '/api/scraping/search?query=term&urls=10&page=1&limit=20&country=morocco&hrFocus=true'
    });
  }

  const urlCount = Math.min(Math.max(parseInt(urls, 10), 1), MAX_SINGLE_URLS);
  const pageNum = Math.max(parseInt(page, 10), 1);
  const pageSize = Math.min(Math.max(parseInt(limit, 10), 1), 50);
  const focus = hrFocus === 'true';

  const start = Date.now();

  try {
    const result = await runDuckEmailHunt({
      query,
      hrFocus: focus,
      country,
      maxQueries: 3,
      maxUrlsPerQuery: urlCount,
      globalUrlBudget: urlCount
    });

    // Treat blockedDetected similar to captcha for UX
    if (result.blockedDetected && result.hrEmails.length === 0 && result.generalEmails.length === 0) {
      return res.status(429).json({
        error: 'Search blocked or yielded no accessible results',
        needsCaptcha: false,
        blocked: true,
        hint: 'DuckDuckGo returned zero links; try different query wording or reduce frequency.'
      });
    }

    const ordered = focus
      ? [...result.hrEmails, ...result.generalEmails]
      : [...result.hrEmails, ...result.generalEmails].sort();

    const totalEmails = ordered.length;
    const totalPages = Math.max(1, Math.ceil(totalEmails / pageSize));
    const startIdx = (pageNum - 1) * pageSize;
    const paginated = ordered.slice(startIdx, startIdx + pageSize);
    const duration = ((Date.now() - start) / 1000).toFixed(2);

    res.json({
      query,
      pagination: {
        currentPage: pageNum,
        totalPages,
        pageSize,
        totalEmails,
        hasNextPage: pageNum < totalPages,
        hasPrevPage: pageNum > 1,
        emailsOnCurrentPage: paginated.length
      },
      scraping: {
        urlsRequested: urlCount,
        urlsFound: result.allSearchUrls.length,
        urlsScraped: result.scrapedUrls.length,
        urlsFailed: result.failedUrls.length,
        emailsFromSnippets: result.stats.snippetHr + result.stats.snippetGeneral,
        emailsFromWebsites: result.stats.pageHr + result.stats.pageGeneral,
        hrEmailsFound: result.hrEmails.length,
        generalEmailsFound: result.generalEmails.length,
        duration
      },
      emails: paginated,
      allEmails: ordered,
      details: {
        scrapedUrls: result.scrapedUrls,
        failedUrls: result.failedUrls
      }
    });

  } catch (err) {
    console.error('SEARCH ERROR:', err);
    res.status(500).json({
      error: 'Scraping failed',
      message: err.message || 'Unknown error'
    });
  }
});

// -------------- ENDPOINT: /search-all (multi-page) -------------- //

router.get('/search-all', async (req, res) => {
  const {
    query,
    maxPages = 3,
    urlsPerPage = 5,
    maxUrls = 50,
    country = 'morocco',
    hrFocus = 'true'
  } = req.query;

  if (!query) {
    return res.status(400).json({
      error: 'Missing parameter: query',
      usage: '/api/scraping/search-all?query=term&maxPages=5&urlsPerPage=8&maxUrls=40&country=morocco&hrFocus=true'
    });
  }

  const pages = Math.min(Math.max(parseInt(maxPages, 10), 1), MAX_MULTI_PAGES);
  const urlsEach = Math.min(Math.max(parseInt(urlsPerPage, 10), 1), MAX_MULTI_URLS_PER_PAGE);
  const totalUrlLimit = Math.min(Math.max(parseInt(maxUrls, 10), 1), 100);
  const focus = hrFocus === 'true';

  const start = Date.now();

  try {
    const result = await runDuckEmailHunt({
      query,
      hrFocus: focus,
      country,
      maxQueries: pages,
      maxUrlsPerQuery: urlsEach,
      globalUrlBudget: totalUrlLimit
    });

    if (result.blockedDetected && result.hrEmails.length === 0 && result.generalEmails.length === 0) {
      return res.status(429).json({
        error: 'Search blocked or yielded no accessible results',
        blocked: true,
        hint: 'DuckDuckGo returned zero links for all constructed queries.'
      });
    }

    const ordered = focus
      ? [...result.hrEmails, ...result.generalEmails]
      : [...result.hrEmails, ...result.generalEmails].sort();

    const totalRawEmails = result.hrEmails.length + result.generalEmails.length;
    const duration = ((Date.now() - start) / 1000).toFixed(2);

    const pageBreakdown = {};
    result.scrapedUrls.forEach(r => {
      const sp = r.searchPage || 1;
      if (!pageBreakdown[sp]) pageBreakdown[sp] = { hr: 0, general: 0, total: 0 };
      pageBreakdown[sp].hr += r.emailCount.hr;
      pageBreakdown[sp].general += r.emailCount.general;
      pageBreakdown[sp].total += r.emailCount.total;
    });

    res.json({
      query,
      summary: {
        searchPagesProcessed: pages,
        urlsPerPageTarget: urlsEach,
        totalUrlsFound: result.allSearchUrls.length,
        totalUrlsScraped: result.scrapedUrls.length,
        totalUrlsFailed: result.failedUrls.length,
        totalUniqueEmails: ordered.length,
        totalRawEmails,
        scrapingDuration: `${duration}s`,
        emailsFromSnippets: result.stats.snippetHr + result.stats.snippetGeneral,
        emailsFromWebsites: result.stats.pageHr + result.stats.pageGeneral,
        hrEmailsFound: result.hrEmails.length,
        generalEmailsFound: result.generalEmails.length
      },
      emails: ordered,
      breakdown: {
        emailsByType: {
          hr: result.hrEmails,
          general: result.generalEmails
        },
        emailsBySearchPage: pages === 1 ? null : pageBreakdown,
        scrapedUrls: result.scrapedUrls,
        failedUrls: result.failedUrls,
        allSearchUrls: result.allSearchUrls
      }
    });

  } catch (err) {
    console.error('SEARCH-ALL ERROR:', err);
    res.status(500).json({
      error: 'Comprehensive scraping failed',
      message: err.message || 'Unknown error'
    });
  }
});

// -------------- HEALTH -------------- //
router.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    engine: 'duckduckgo',
    endpoints: {
      '/search': {
        description: 'Single-page (paginated) DuckDuckGo email scraping',
        params: {
          query: 'string (required)',
          urls: 'int (1-20) max URLs to visit (default 5)',
          page: 'int pagination page (default 1)',
          limit: 'int emails per page (default 10)',
          country: 'string (default morocco)',
          hrFocus: 'true|false (default true)'
        }
      },
      '/search-all': {
        description: 'Multi-page comprehensive DuckDuckGo email scraping',
        params: {
          query: 'string (required)',
          maxPages: 'int (1-10) number of constructed queries (default 3)',
          urlsPerPage: 'int (1-20) max URLs visited per query (default 5)',
          maxUrls: 'int (1-100) global URL cap (default 50)',
          country: 'string (default morocco)',
          hrFocus: 'true|false (default true)'
        }
      }
    }
  });
});

module.exports = router;
