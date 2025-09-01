/**
 * Scraping Controller (Bing-based)  (Original logic preserved)
 * NOW WITH DEBUG OUTPUT (on demand or when errors occur)
 *
 * HOW TO GET DEBUG (front-end):
 *   - Add &debug=1 (or &debug=true) to /api/scraping/search or /api/scraping/search-all
 *   - If an internal error happens, a debug object is returned automatically (if any data was gathered).
 *
 * WHAT DEBUG CONTAINS:
 *   debug: {
 *     queries: [...],
 *     perQuery: [
 *       {
 *         index: 1,
 *         bingQuery: "...",
 *         serp: {
 *           status: 200,
 *           length: 45123,
 *           hasBAlgo: true,
 *           captchaSuspect: false,
 *           snippetEmails: 0,
 *           linksFound: 5,
 *           firstLinks: ["https://...","..."],
 *           htmlSample: "<html ... trimmed...>"
 *         },
 *         pages: [
 *            { url, status, ok, emailCount, hrCount, generalCount, error? }
 *         ]
 *       }
 *     ],
 *     aggregate: {
 *       totalQueries,
 *       totalLinksDiscovered,
 *       totalPagesFetched,
 *       totalPageFetchErrors,
 *       hrEmails,
 *       generalEmails
 *     }
 *   }
 *
 * NOTE: We only keep SMALL sanitized htmlSample (first 400 chars, whitespace collapsed)
 *       to avoid leaking full SERP/page contents.
 */

const express = require('express');
const cheerio = require('cheerio');
const router = express.Router();

const MAX_SINGLE_URLS = 20;
const MAX_MULTI_PAGES = 10;
const MAX_MULTI_URLS_PER_PAGE = 20;
const GLOBAL_TIMEOUT_MS = 15000;

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

const HR_EMAIL_KEYWORDS = [
  'hr', 'job', 'jobs', 'career', 'careers', 'recruit', 'recruiter', 'recruitment',
  'talent', 'apply', 'hiring', 'people', 'human', 'resource', 'resources',
  'employment', 'candidature', 'recrutement', 'carriere', 'emploi', 'poste', 'cv'
];

const GENERIC_EXCLUDE_PREFIXES = [
  'info@', 'contact@', 'support@', 'help@', 'noreply@', 'no-reply@', 'newsletter@',
  'marketing@', 'sales@', 'webmaster@', 'admin@', 'postmaster@', 'hello@', 'office@'
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

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
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
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

/**
 * Core scraping with debug collection.
 */
async function runBingEmailHunt({
  query,
  hrFocus,
  country,
  maxQueries,
  maxUrlsPerQuery,
  globalUrlBudget,
  collectDebug = false
}) {
  const queries = buildBingQueries(query, hrFocus, country).slice(0, maxQueries);

  // Debug structure
  const debug = collectDebug ? {
    queries,
    perQuery: [],
    aggregate: {
      totalQueries: queries.length,
      totalLinksDiscovered: 0,
      totalPagesFetched: 0,
      totalPageFetchErrors: 0
    }
  } : null;

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
    if (qi > 0) await sleep(1200 + Math.random() * 800);
    const bingUrl = `https://www.bing.com/search?q=${encodeURIComponent(qStr)}&count=15`;

    let html;
    let serpStatus = null;
    let serpError = null;
    try {
      const resp = await fetchWithTimeout(bingUrl);
      serpStatus = resp.status;
      html = await resp.text();
    } catch (err) {
      serpError = err.name === 'AbortError' ? 'timeout' : err.message;
      failedUrls.push({
        url: bingUrl,
        error: `Search fetch failed: ${serpError}`,
        searchPage: qi + 1,
        type: 'search'
      });
      if (collectDebug) {
        debug.perQuery.push({
          index: qi + 1,
          bingQuery: qStr,
          serp: { status: serpStatus, error: serpError }
        });
      }
      continue;
    }

    const lower = html.toLowerCase();
    const captcha = lower.includes('captcha') && html.includes('b_captcha');

    if (captcha) {
      captchaTriggered = true;
    }

    const $ = cheerio.load(html);
    const bodyText = $('body').text();
    const snippetEmails = extractEmails(bodyText);
    if (snippetEmails.length) {
      const classified = classifyEmails(snippetEmails, html, hrFocus);
      classified.hr.forEach(e => snippetHREmails.add(e));
      classified.general.forEach(e => snippetGeneralEmails.add(e));
    }

    const links = [];
    $('li.b_algo h2 a, .b_algo h2 a').each((_, el) => {
      const href = $(el).attr('href');
      if (href && href.startsWith('http')) links.push(href);
    });

    if (collectDebug) {
      debug.aggregate.totalLinksDiscovered += links.length;
    }

    const queryDebug = collectDebug ? {
      index: qi + 1,
      bingQuery: qStr,
      serp: {
        status: serpStatus,
        length: html.length,
        hasBAlgo: html.includes('b_algo'),
        captchaSuspect: captcha,
        snippetEmails: snippetEmails.length,
        linksFound: links.length,
        firstLinks: links.slice(0, 5),
        htmlSample: html.slice(0, 400).replace(/\s+/g, ' ')
      },
      pages: []
    } : null;

    for (const rawLink of links.slice(0, maxUrlsPerQuery)) {
      if (globalUrlBudget !== undefined && totalVisited >= globalUrlBudget) break;
      let finalUrl = await resolveBingRedirect(rawLink);
      allSearchUrls.push(finalUrl);

      let pageStatus = null;
      let pageOk = false;
      let pageErr = null;
      let pageEmailsCount = 0;
      let hrAdded = 0;
      let generalAdded = 0;

      try {
        totalVisited++;
        const pageResp = await fetchWithTimeout(finalUrl);
        pageStatus = pageResp.status;
        if (!pageResp.ok) throw new Error(`HTTP ${pageResp.status}`);
        const pageHtml = await pageResp.text();
        const $$ = cheerio.load(pageHtml);
        $$('script,style,noscript').remove();
        const body = $$('body').text();
        const title = $$('title').text().trim();
        const pageEmails = extractEmails(body);

        pageEmailsCount = pageEmails.length;

        if (pageEmails.length) {
          const classified = classifyEmails(pageEmails, body + ' ' + title, hrFocus);
          hrAdded = classified.hr.length;
          generalAdded = classified.general.length;
          classified.hr.forEach(e => pageHREmails.add(e));
          classified.general.forEach(e => pageGeneralEmails.add(e));
        }

        // mailto
        $$('a[href^="mailto:"]').each((_, a) => {
          const m = $$(a).attr('href');
          if (!m) return;
          const mail = m.replace(/^mailto:/i, '').split('?')[0].trim().toLowerCase();
          if (mail && EMAIL_REGEX.test(mail)) {
            const c2 = classifyEmails([mail], title, hrFocus);
            c2.hr.forEach(e => pageHREmails.add(e));
            c2.general.forEach(e => pageGeneralEmails.add(e));
            hrAdded += c2.hr.length;
            generalAdded += c2.general.length;
            pageEmailsCount += c2.hr.length + c2.general.length;
          }
        });

        scrapedUrls.push({
          url: finalUrl,
          searchPage: qi + 1,
          isHRPage: isLikelyHRPage(finalUrl, title),
          emailCount: {
            hr: hrAdded,
            general: generalAdded,
            total: hrAdded + generalAdded
          },
          emails: undefined // kept lightweight for production
        });
        pageOk = true;
        if (collectDebug) debug.aggregate.totalPagesFetched += 1;
      } catch (err) {
        pageErr = err.name === 'AbortError' ? 'timeout' : err.message;
        failedUrls.push({
          url: finalUrl,
          error: pageErr,
          searchPage: qi + 1,
          type: 'page'
        });
        if (collectDebug) debug.aggregate.totalPageFetchErrors += 1;
      }

      if (collectDebug && queryDebug) {
        queryDebug.pages.push({
          url: finalUrl,
          status: pageStatus,
          ok: pageOk,
          emailCount: pageEmailsCount,
          hrCount: hrAdded,
          generalCount: generalAdded,
          error: pageErr || undefined
        });
      }
    }

    if (collectDebug && queryDebug) {
      debug.perQuery.push(queryDebug);
    }

    if (captcha) break;
  }

  const hrEmails = [...new Set([...snippetHREmails, ...pageHREmails])];
  const generalEmails = [...new Set(
    [...snippetGeneralEmails, ...pageGeneralEmails].filter(e => !hrEmails.includes(e))
  )];

  if (collectDebug) {
    debug.aggregate.hrEmails = hrEmails.length;
    debug.aggregate.generalEmails = generalEmails.length;
    debug.aggregate.scrapedUrls = scrapedUrls.length;
    debug.aggregate.failedUrls = failedUrls.length;
    debug.aggregate.allSearchUrls = allSearchUrls.length;
    debug.aggregate.captchaTriggered = captchaTriggered;
  }

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
    },
    debug
  };
}

// ---------------- /search ---------------- //
router.get('/search', async (req, res) => {
  const {
    query,
    urls = 5,
    page = 1,
    limit = 10,
    country = 'morocco',
    hrFocus = 'true',
    debug
  } = req.query;

  if (!query) {
    return res.status(400).json({
      error: 'Missing parameter: query',
      usage: '/api/scraping/search?query=term&urls=10&page=1&limit=20&country=morocco&hrFocus=true'
    });
  }

  const collectDebug = debug === '1' || debug === 'true';
  const urlCount = Math.min(Math.max(parseInt(urls), 1), MAX_SINGLE_URLS);
  const pageNum = Math.max(parseInt(page), 1);
  const pageSize = Math.min(Math.max(parseInt(limit), 1), 50);
  const focus = hrFocus === 'true';
  const start = Date.now();

  try {
    const result = await runBingEmailHunt({
      query,
      hrFocus: focus,
      country,
      maxQueries: 3,
      maxUrlsPerQuery: urlCount,
      globalUrlBudget: urlCount,
      collectDebug
    });

    if (result.captchaTriggered) {
      return res.status(429).json({
        error: 'Captcha detected',
        needsCaptcha: true,
        captchaUrl: `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
        debug: collectDebug ? result.debug : undefined
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
      },
      debug: collectDebug ? result.debug : undefined,
      note: collectDebug && ordered.length === 0 ? 'NO_EMAILS_RETURNED' : undefined
    });

  } catch (err) {
    console.error('SEARCH ERROR:', err);
    return res.status(500).json({
      error: 'Scraping failed',
      message: err.message || 'Unknown error',
      debugHint: 'Check debug.perQuery serp.status / linksFound',
      // Provide partial debug if we had started anything (none here because runBingEmailHunt failed early)
    });
  }
});

// ---------------- /search-all ---------------- //
router.get('/search-all', async (req, res) => {
  const {
    query,
    maxPages = 3,
    urlsPerPage = 5,
    maxUrls = 50,
    country = 'morocco',
    hrFocus = 'true',
    debug
  } = req.query;

  if (!query) {
    return res.status(400).json({
      error: 'Missing parameter: query',
      usage: '/api/scraping/search-all?query=term&maxPages=5&urlsPerPage=8&maxUrls=40&country=morocco&hrFocus=true'
    });
  }

  const collectDebug = debug === '1' || debug === 'true';
  const pages = Math.min(Math.max(parseInt(maxPages), 1), MAX_MULTI_PAGES);
  const urlsEach = Math.min(Math.max(parseInt(urlsPerPage), 1), MAX_MULTI_URLS_PER_PAGE);
  const totalUrlLimit = Math.min(Math.max(parseInt(maxUrls), 1), 100);
  const focus = hrFocus === 'true';
  const start = Date.now();

  try {
    const result = await runBingEmailHunt({
      query,
      hrFocus: focus,
      country,
      maxQueries: pages,
      maxUrlsPerQuery: urlsEach,
      globalUrlBudget: totalUrlLimit,
      collectDebug
    });

    if (result.captchaTriggered) {
      return res.status(429).json({
        error: 'Captcha detected',
        needsCaptcha: true,
        captchaUrl: `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
        debug: collectDebug ? result.debug : undefined
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
      if (r.emailCount && typeof r.emailCount === 'object') {
        // r.emailCount fields already cumulative or per page? Here we just set (not sum) to reflect final discovered for that URL pass
        pageBreakdown[sp].hr += r.emailCount.hr;
        pageBreakdown[sp].general += r.emailCount.general;
        pageBreakdown[sp].total += r.emailCount.total;
      }
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
      },
      debug: collectDebug ? result.debug : undefined,
      note: collectDebug && ordered.length === 0 ? 'NO_EMAILS_RETURNED' : undefined
    });

  } catch (err) {
    console.error('SEARCH-ALL ERROR:', err);
    return res.status(500).json({
      error: 'Comprehensive scraping failed',
      message: err.message || 'Unknown error',
      debugHint: 'Use &debug=1 to capture perQuery details'
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
          urls: 'int (1-20) max URLs to visit (default 5)',
          page: 'int pagination page (default 1)',
          limit: 'int emails per page (default 10)',
          country: 'string (default morocco)',
          hrFocus: 'true|false (default true)',
          debug: 'true|1 optional'
        }
      },
      '/search-all': {
        description: 'Multi-page comprehensive Bing email scraping',
        params: {
          query: 'string (required)',
          maxPages: 'int (1-10) number of Bing queries (default 3)',
          urlsPerPage: 'int (1-20) max URLs visited per query (default 5)',
            maxUrls: 'int (1-100) global URL cap (default 50)',
          country: 'string (default morocco)',
          hrFocus: 'true|false (default true)',
          debug: 'true|1 optional'
        }
      }
    }
  });
});

module.exports = router;
