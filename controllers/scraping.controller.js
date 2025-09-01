/**
 * Scraping Controller (Bing-based) – Robust Selectors + HTML Cleaning + Plain Text Email Extraction
 *
 * Endpoints:
 *  - GET /api/scraping/search
 *  - GET /api/scraping/search-all
 *
 * Features (original contract preserved):
 *  - Adaptive Bing queries (HR focus optional)
 *  - Robust multi-selector link extraction (works better on Vercel)
 *  - Optional JSON "url" pattern extraction if normal selectors fail
 *  - Cleans SERP & page HTML (removes script/style/header/footer/nav/etc.) before email extraction
 *  - Plain text + mailto: email extraction (regex)
 *  - HR email classification (unchanged logic)
 *  - CAPTCHA / soft-block detection (basic)
 *  - Stats + pagination identical to original structure
 *
 * NOTE: Generic emails (info@, contact@ ...) are still excluded when hrFocus=true (original behavior).
 */

const express = require('express');
const cheerio = require('cheerio');
const router = express.Router();

// ------------------ CONFIG ------------------ //

const MAX_SINGLE_URLS = 20;
const MAX_MULTI_PAGES = 10;
const MAX_MULTI_URLS_PER_PAGE = 20;
const GLOBAL_TIMEOUT_MS = 15000;
const PAGE_CLEAN_CHAR_LIMIT = 250_000;

// Regex for emails (strict)
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

// SERP link selectors (robust, ordered – we stop early if we accumulate enough)
const SERP_LINK_SELECTORS = [
  'li.b_algo h2 a',
  '.b_algo h2 a',
  '#b_results li.b_algo h2 a',
  '#b_results h2 a',
  '#b_results a[href^="http"]',
  'main h2 a[href^="http"]',
  'main a[href^="http"]'
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
 * Build an array of Bing queries (deduplicated) depending on hrFocus.
 */
function buildBingQueries(baseQuery, hrFocus, country) {
  const q = baseQuery.trim();
  const geo = country ? country.trim() : 'morocco';

  const core = [
    `"${q}" email contact ${geo}`,
    `"${q}" ("email us" OR "contact us") ${geo}`
  ];

  const hrSet = [
    `"${q}" ("hr@" OR "careers@" OR "jobs@" OR "recruitment@") ${geo}`,
    `"${q}" careers jobs apply cv email ${geo}`,
    `"${q}" ("send your cv" OR "submit your cv" OR "postuler") ${geo}`,
    `"${q}" recrutement emploi carriere email ${geo}`,
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
          // Rotating pool optional – for simplicity one modern UA
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': opts.accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
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

async function resolveBingRedirect(url) {
  try {
    if (!url.includes('bing.com/ck/a?')) return url;
    const match = url.match(/u=([^&]+)/);
    if (!match) return url;
    let decoded = decodeURIComponent(match[1]);
    if (decoded.startsWith('a1') && !decoded.startsWith('http')) {
      try {
        decoded = Buffer.from(decoded.slice(2), 'base64').toString('utf-8');
      } catch {
        return url;
      }
    }
    return decoded.startsWith('http') ? decoded : url;
  } catch {
    return url;
  }
}

/* Clean a Cheerio root: remove noise nodes before extracting text/emails */
function cleanCheerio($) {
  const REMOVE = [
    'script','style','noscript','iframe','svg','canvas','meta','link',
    'header','footer','nav','aside','form','input','button','select',
    'textarea','template'
  ];
  REMOVE.forEach(sel => $(sel).remove());

  // Remove large nav / megamenus heuristically (lists with many links & little text diversity)
  $('ul,ol').each((_, el) => {
    const linkCount = $(el).find('a').length;
    if (linkCount > 30) $(el).remove();
  });
}

/* Extract links from SERP using robust selectors, fallback to JSON pattern if empty */
function extractSerpLinks(html) {
  const $ = cheerio.load(html);
  cleanCheerio($);
  const linkSet = new Set();

  for (const sel of SERP_LINK_SELECTORS) {
    $(sel).each((_, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      if (!/^https?:\/\//i.test(href)) return;
      if (href.includes('bing.com')) return;
      linkSet.add(href);
    });
    if (linkSet.size >= 50) break; // avoid runaway
  }

  // JSON pattern fallback (some Bing variants embed urls in inline JSON)
  if (linkSet.size === 0) {
    const jsonMatches = html.match(/"url":"https?:\\?\/\\?\/[^"]+?"/g) || [];
    jsonMatches.forEach(m => {
      let url = m.slice(7, -1).replace(/\\\//g, '/');
      if (url.startsWith('http') && !url.includes('bing.com')) {
        linkSet.add(url);
      }
    });
  }

  return [...linkSet];
}

/* Clean plain page HTML and return body text + emails */
function extractPageEmails(html, hrFocus) {
  const $ = cheerio.load(html);
  cleanCheerio($);
  let text = $('body').text() || '';
  // Normalize & trim
  text = text.replace(/\r/g, ' ')
             .replace(/\t/g, ' ')
             .replace(/[ \u00A0]{2,}/g, ' ')
             .replace(/\n{3,}/g, '\n\n')
             .slice(0, PAGE_CLEAN_CHAR_LIMIT);
  const emails = extractEmails(text);
  return { text, emails };
}

// -------------- CORE SCRAPING LOGIC (shared) -------------- //

async function runBingEmailHunt({
  query,
  hrFocus,
  country,
  maxQueries,
  maxUrlsPerQuery,
  globalUrlBudget
}) {
  const queries = buildBingQueries(query, hrFocus, country).slice(0, maxQueries);

  const snippetHREmails = new Set();
  const snippetGeneralEmails = new Set();
  const pageHREmails = new Set();
  const pageGeneralEmails = new Set();

  const scrapedUrls = [];
  const failedUrls = [];
  const allSearchUrls = [];
  let totalVisited = 0;
  let captchaTriggered = false;

  for (let qi = 0; qi < queries.length; qi++) {
    if (globalUrlBudget !== undefined && totalVisited >= globalUrlBudget) break;

    const qStr = queries[qi];
    if (qi > 0) await sleep(900 + Math.random() * 600);

    const bingUrl =
      `https://www.bing.com/search?q=${encodeURIComponent(qStr)}` +
      `&count=15&mkt=en-US&setlang=en-US&cc=US&ensearch=1&safeSearch=Off`;

    let html;
    try {
      const resp = await fetchWithTimeout(bingUrl);
      html = await resp.text();
    } catch (err) {
      failedUrls.push({
        url: bingUrl,
        error: `Search fetch failed: ${err.name === 'AbortError' ? 'timeout' : err.message}`,
        searchPage: qi + 1,
        type: 'search'
      });
      continue;
    }

    const lower = html.toLowerCase();
    if (lower.includes('captcha') && html.includes('b_captcha')) {
      captchaTriggered = true;
      const snippetEmails = extractEmails(html);
      const classified = classifyEmails(snippetEmails, html, hrFocus);
      classified.hr.forEach(e => snippetHREmails.add(e));
      classified.general.forEach(e => snippetGeneralEmails.add(e));
      break;
    }

    // SERP cleaning & snippet email capture
    const $ = cheerio.load(html);
    cleanCheerio($);
    const snippetText = $('body').text();
    const snippetEmails = extractEmails(snippetText);
    if (snippetEmails.length) {
      const classified = classifyEmails(snippetEmails, snippetText, hrFocus);
      classified.hr.forEach(e => snippetHREmails.add(e));
      classified.general.forEach(e => snippetGeneralEmails.add(e));
    }

    // Robust link extraction
    const links = extractSerpLinks(html);

    for (const raw of links.slice(0, maxUrlsPerQuery)) {
      if (globalUrlBudget !== undefined && totalVisited >= globalUrlBudget) break;

      const finalUrl = await resolveBingRedirect(raw);
      allSearchUrls.push(finalUrl);

      try {
        totalVisited++;
        const pageResp = await fetchWithTimeout(finalUrl);
        if (!pageResp.ok) throw new Error(`HTTP ${pageResp.status}`);
        const pageHtml = await pageResp.text();

        const { text: cleanedText, emails: pageEmails } = extractPageEmails(pageHtml, hrFocus);

        const classified = classifyEmails(pageEmails, cleanedText, hrFocus);
        classified.hr.forEach(e => pageHREmails.add(e));
        classified.general.forEach(e => pageGeneralEmails.add(e));

        // mailto fallback
        const $$ = cheerio.load(pageHtml);
        $$('a[href^="mailto:"]').each((_, a) => {
          const mailHref = $$(a).attr('href');
          if (!mailHref) return;
          const mail = mailHref.replace(/^mailto:/i, '').split('?')[0].trim().toLowerCase();
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
    captchaTriggered,
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
    const result = await runBingEmailHunt({
      query,
      hrFocus: focus,
      country,
      maxQueries: 3,
      maxUrlsPerQuery: urlCount,
      globalUrlBudget: urlCount
    });

    if (result.captchaTriggered) {
      return res.status(429).json({
        error: 'Captcha detected',
        needsCaptcha: true,
        captchaUrl: `https://www.bing.com/search?q=${encodeURIComponent(query)}`
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
    const result = await runBingEmailHunt({
      query,
      hrFocus: focus,
      country,
      maxQueries: pages,
      maxUrlsPerQuery: urlsEach,
      globalUrlBudget: totalUrlLimit
    });

    if (result.captchaTriggered) {
      return res.status(429).json({
        error: 'Captcha detected',
        needsCaptcha: true,
        captchaUrl: `https://www.bing.com/search?q=${encodeURIComponent(query)}`
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
    endpoints: {
      '/search': {
        description: 'Single-page (paginated) Bing email scraping',
        params: {
          query: 'string (required)',
          urls: 'int (1-20)',
          page: 'int',
          limit: 'int',
          country: 'string (default morocco)',
          hrFocus: 'true|false (default true)'
        }
      },
      '/search-all': {
        description: 'Multi-page comprehensive Bing email scraping',
        params: {
          query: 'string (required)',
          maxPages: 'int (1-10)',
          urlsPerPage: 'int (1-20)',
          maxUrls: 'int (1-100)',
          country: 'string (default morocco)',
          hrFocus: 'true|false (default true)'
        }
      }
    }
  });
});

module.exports = router;
