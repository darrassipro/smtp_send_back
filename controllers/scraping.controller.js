/**
 * Scraping Controller (Bing-based) with:
 *  - Bing + JSON URL extraction + DuckDuckGo fallback (from previous version)
 *  - Enhanced page cleaning & plain-text email extraction
 *  - Obfuscated email pattern handling ( [at], (at), at , [dot], dot, etc.)
 *  - Debug info for cleaned extraction
 *
 * NOTE: Classification logic unchanged (generic emails skipped if hrFocus=true).
 */

const express = require('express');
const cheerio = require('cheerio');
const router = express.Router();

const MAX_SINGLE_URLS = 20;
const MAX_MULTI_PAGES = 10;
const MAX_MULTI_URLS_PER_PAGE = 20;
const GLOBAL_TIMEOUT_MS = 15000;

// Limits & controls
const PAGE_TEXT_CHAR_LIMIT = 300_000;   // Hard cap of cleaned text scanned
const MAX_OBFUSCATION_SAMPLE = 5;

// Regexes
const EMAIL_REGEX_STRICT = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
// Loose tokens for obfuscated emails (replace after normalization)
const OBFUSCATION_AT = /\b(?:\[at\]|\(at\)|\sat\s|\s@\s|{at}| at )\b/gi;
const OBFUSCATION_DOT = /\b(?:\[dot\]|\(dot\)|\sdot\s| dot )\b/gi;

// Secondary capture: sequences like word (at) domain (dot) tld
// We'll normalize text then run strict EMAIL_REGEX_STRICT again.
const HTML_ENTITY_REGEX = /&(#\d+|[a-zA-Z]+);/g;

// HR keywords & generic prefixes
const HR_EMAIL_KEYWORDS = [
  'hr','job','jobs','career','careers','recruit','recruiter','recruitment',
  'talent','apply','hiring','people','human','resource','resources',
  'employment','candidature','recrutement','carriere','emploi','poste','cv'
];

const GENERIC_EXCLUDE_PREFIXES = [
  'info@','contact@','support@','help@','noreply@','no-reply@','newsletter@',
  'marketing@','sales@','webmaster@','admin@','postmaster@','hello@','office@'
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

function decodeEntities(str = '') {
  return str.replace(HTML_ENTITY_REGEX, (m, ent) => {
    if (ent.startsWith('#')) {
      const code = parseInt(ent.slice(1), 10);
      return isNaN(code) ? m : String.fromCharCode(code);
    }
    switch (ent.toLowerCase()) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      default: return m;
    }
  });
}

function extractEmailsStrict(text) {
  if (!text) return [];
  const matches = text.match(EMAIL_REGEX_STRICT) || [];
  return [...new Set(matches.map(e => e.toLowerCase()))];
}

function normalizeForObfuscation(raw) {
  if (!raw) return '';
  let t = decodeEntities(raw);
  // Remove excessive punctuation separating tokens in emails.
  t = t.replace(/[\u00A0]/g, ' ');
  // Standardize brackets & parentheses spacing
  t = t.replace(/[\[\]\(\){}<>]/g, ' ');
  // Collapse multiple spaces
  t = t.replace(/\s{2,}/g, ' ');
  return t;
}

function extractObfuscatedEmails(text) {
  if (!text) return { emails: [], sample: [] };
  let norm = normalizeForObfuscation(text);

  // Replace obfuscation tokens with actual symbols
  const obfuscatedSamples = [];
  // Collect small samples before transform for debug
  const atTokens = norm.match(OBFUSCATION_AT) || [];
  const dotTokens = norm.match(OBFUSCATION_DOT) || [];
  obfuscatedSamples.push(...atTokens.slice(0, MAX_OBFUSCATION_SAMPLE));
  obfuscatedSamples.push(...dotTokens.slice(0, MAX_OBFUSCATION_SAMPLE));

  norm = norm
    .replace(OBFUSCATION_AT, '@')
    .replace(OBFUSCATION_DOT, '.');

  // Sometimes separators like "name . surname @ domain . com"
  norm = norm.replace(/\s*\.\s*/g, '.');

  // Remove spaces around '@' and '.'
  norm = norm.replace(/\s*@\s*/g, '@').replace(/\s*\.\s*/g, '.');

  // Now strict extraction
  const emails = extractEmailsStrict(norm);
  return { emails, sample: [...new Set(obfuscatedSamples)] };
}

function classifyEmails(emails, context = '', hrFocus = true) {
  const ctx = (context || '').toLowerCase();
  const hr = [];
  const general = [];
  emails.forEach(email => {
    if (GENERIC_EXCLUDE_PREFIXES.some(p => email.startsWith(p))) {
      if (!hrFocus) general.push(email);
      return;
    }
    const hasKeyword = HR_EMAIL_KEYWORDS.some(k => email.includes(k));
    const namePattern = /^[a-z]+\.[a-z]+@/i.test(email);
    const contextHas = HR_EMAIL_KEYWORDS.some(k => ctx.includes(k));
    if (hasKeyword || (contextHas && (namePattern || hrFocus)) || (namePattern && hrFocus)) {
      hr.push(email);
    } else {
      general.push(email);
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
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...opts,
      headers: {
        'User-Agent': opts.userAgent ||
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Connection': 'keep-alive',
        'Cookie': 'SRCHHPGUSR=SRCHLANG=en; MUID=0; _EDGE_S=1;',
        ...(opts.headers || {})
      },
      signal: controller.signal
    });
    clearTimeout(timer);
    return res;
  } catch (e) {
    clearTimeout(timer);
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
      try { decoded = Buffer.from(decoded.slice(2), 'base64').toString('utf-8'); } catch {}
    }
    return decoded.startsWith('http') ? decoded : url;
  } catch {
    return url;
  }
}

function isBlockedVariant(html) {
  const low = html.toLowerCase();
  const noAlgo = !/b_algo/.test(low);
  const hasMain = /<main\b/i.test(low) || /<div id="b_content"/i.test(low);
  const hasTitleSearch = /- search<\/title>/i.test(low);
  return noAlgo && (hasMain || hasTitleSearch);
}

function extractJsonUrls(html) {
  const urls = new Set();
  const regex = /"url":"https?:\\?\/\\?\/[^"]+?"/g;
  const matches = html.match(regex) || [];
  matches.forEach(m => {
    let u = m.slice(7, -1).replace(/\\\//g, '/').replace(/\\\\/g, '\\');
    if (u.startsWith('http') && !u.includes('bing.com')) urls.add(u);
  });
  return [...urls];
}

async function duckDuckGoFallback(query, maxLinks = 10, hrFocus = true) {
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query + ' email')}`;
  const resp = await fetchWithTimeout(url);
  const html = await resp.text();
  const $ = cheerio.load(html);
  const linkSet = new Set();
  const selectors = [
    'a.result__a',
    '.result__title a',
    'div.result__body a.result__a',
    'div.result a[href^="http"]'
  ];
  selectors.forEach(sel => {
    $(sel).each((_, el) => {
      const href = $(el).attr('href');
      if (href && /^https?:\/\//.test(href)) linkSet.add(href);
    });
  });
  const snippetText = $('div.result, div.result__body, body').text();
  const snippetEmails = extractEmailsStrict(snippetText);
  const classified = classifyEmails(snippetEmails, snippetText, hrFocus);
  return {
    links: [...linkSet].slice(0, maxLinks),
    snippetHr: classified.hr,
    snippetGeneral: classified.general
  };
}

/* Clean & extract page text */
function cleanAndExtractEmailsFromPage(html, hrFocus) {
  const $ = cheerio.load(html);

  // Remove noise
  const REMOVE_SELECTORS = [
    'script','style','noscript','iframe','svg','canvas','meta','link',
    'header','footer','nav','aside','form','input','button','select','textarea',
    '[role="banner"]','[role="navigation"]','[role="contentinfo"]','[aria-hidden="true"]'
  ];
  REMOVE_SELECTORS.forEach(sel => $(sel).remove());

  // Remove large menus / repeated lists by heuristic (top nav)
  $('ul,ol').each((_, el) => {
    const text = $(el).text().trim();
    if (text.length < 15) return;
    const linkCount = $(el).find('a').length;
    if (linkCount > 20 && text.length / (linkCount || 1) < 25) {
      $(el).remove();
    }
  });

  // Get body text
  let text = $('body').text() || '';
  text = decodeEntities(text);
  // Collapse whitespace
  text = text.replace(/\r/g, '').replace(/\t/g, ' ');
  text = text.replace(/[ \u00A0]{2,}/g, ' ');
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.slice(0, PAGE_TEXT_CHAR_LIMIT);

  // Strict pass
  const strictEmails = extractEmailsStrict(text);

  // Obfuscated pass (only if strict small or zero)
  const obfuscated = extractObfuscatedEmails(text);
  const all = new Set([...strictEmails, ...obfuscated.emails]);

  // Classification on the union
  const classified = classifyEmails([...all], text, hrFocus);

  return {
    strictEmails,
    obfuscatedEmails: obfuscated.emails,
    obfuscationSampleTokens: obfuscated.sample,
    classified,
    cleanedTextChars: text.length
  };
}

/**
 * Main multi-query runner (Bing + fallbacks + cleaned page extraction)
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
  const debug = collectDebug ? {
    queries,
    perQuery: [],
    aggregate: {
      totalQueries: queries.length,
      totalLinksDiscovered: 0,
      totalPagesFetched: 0,
      totalPageFetchErrors: 0
    },
    fallback: null
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
  let everyQueryZeroLinks = true;

  for (let qi = 0; qi < queries.length; qi++) {
    if (globalUrlBudget !== undefined && totalVisited >= globalUrlBudget) break;
    const qStr = queries[qi];
    if (qi > 0) await sleep(900 + Math.random() * 500);

    const bingUrl = `https://www.bing.com/search?q=${encodeURIComponent(qStr)}&count=15&mkt=en-US&setlang=en-US&cc=US&ensearch=1&adlt=off&safeSearch=Off`;
    let html, serpStatus = null, serpError = null;

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

    const low = html.toLowerCase();
    const captcha = low.includes('captcha') && html.includes('b_captcha');
    const blockedVariant = isBlockedVariant(html);
    if (captcha) captchaTriggered = true;

    const $ = cheerio.load(html);
    const bodyText = $('body').text();
    const snippetEmails = extractEmailsStrict(bodyText);
    if (snippetEmails.length) {
      const classified = classifyEmails(snippetEmails, html, hrFocus);
      classified.hr.forEach(e => snippetHREmails.add(e));
      classified.general.forEach(e => snippetGeneralEmails.add(e));
    }

    const selectors = [
      'li.b_algo h2 a',
      '.b_algo h2 a',
      '#b_results li.b_algo h2 a',
      '#b_results h2 a',
      '#b_results a[href^="http"]',
      'main a[href^="http"]'
    ];
    const linkSet = new Set();
    const selectorBreakdown = [];
    for (const sel of selectors) {
      const before = linkSet.size;
      $(sel).each((_, el) => {
        const href = $(el).attr('href');
        if (href && /^https?:\/\//.test(href) && !href.includes('bing.com')) {
          linkSet.add(href);
        }
      });
      selectorBreakdown.push({ selector: sel, added: linkSet.size - before, total: linkSet.size });
      if (linkSet.size >= maxUrlsPerQuery * 3) break;
    }

    let links = [...linkSet];
    let jsonExtracted = [];
    if (links.length === 0) {
      jsonExtracted = extractJsonUrls(html);
      if (jsonExtracted.length) links = jsonExtracted;
    }

    if (links.length > 0) everyQueryZeroLinks = false;
    if (collectDebug) debug.aggregate.totalLinksDiscovered += links.length;

    const queryDebug = collectDebug ? {
      index: qi + 1,
      bingQuery: qStr,
      serp: {
        status: serpStatus,
        length: html.length,
        hasBAlgo: html.includes('b_algo'),
        captchaSuspect: captcha,
        blockedVariant,
        snippetEmails: snippetEmails.length,
        linksFound: links.length,
        firstLinks: links.slice(0, 5),
        selectorBreakdown,
        jsonExtractedLinksCount: jsonExtracted.length,
        htmlSample: html.slice(0, 320).replace(/\s+/g, ' ')
      },
      pages: []
    } : null;

    for (const rawLink of links.slice(0, maxUrlsPerQuery)) {
      if (globalUrlBudget !== undefined && totalVisited >= globalUrlBudget) break;
      const finalUrl = await resolveBingRedirect(rawLink);
      allSearchUrls.push(finalUrl);

      let pageStatus = null;
      let pageErr = null;
      let hrAdded = 0;
      let generalAdded = 0;
      let strictCount = 0;
      let obfuscatedCount = 0;

      try {
        totalVisited++;
        const pageResp = await fetchWithTimeout(finalUrl);
        pageStatus = pageResp.status;
        if (!pageResp.ok) throw new Error(`HTTP ${pageResp.status}`);

        const pageHtml = await pageResp.text();
        const extraction = cleanAndExtractEmailsFromPage(pageHtml, hrFocus);

        strictCount = extraction.strictEmails.length;
        obfuscatedCount = extraction.obfuscatedEmails.length;

        // Merge classified results
        extraction.classified.hr.forEach(e => pageHREmails.add(e));
        extraction.classified.general.forEach(e => pageGeneralEmails.add(e));
        hrAdded = extraction.classified.hr.length;
        generalAdded = extraction.classified.general.length;

        // mailto links (after classification to catch extras)
        const $$ = cheerio.load(pageHtml);
        $$('a[href^="mailto:"]').each((_, a) => {
          const m = $$(a).attr('href');
          if (!m) return;
          const mail = m.replace(/^mailto:/i, '').split('?')[0].trim().toLowerCase();
          if (mail && EMAIL_REGEX_STRICT.test(mail)) {
            const c2 = classifyEmails([mail], '', hrFocus);
            c2.hr.forEach(e => { if (!pageHREmails.has(e)) { pageHREmails.add(e); hrAdded += 1; } });
            c2.general.forEach(e => { if (!pageGeneralEmails.has(e)) { pageGeneralEmails.add(e); generalAdded += 1; } });
          }
        });

        scrapedUrls.push({
          url: finalUrl,
          searchPage: qi + 1,
          isHRPage: isLikelyHRPage(finalUrl, ''), // title stripped; optional improvement
          emailCount: {
            hr: hrAdded,
            general: generalAdded,
            total: hrAdded + generalAdded
          }
        });

        if (collectDebug && queryDebug) {
          queryDebug.pages.push({
            url: finalUrl,
            status: pageStatus,
            hrCount: hrAdded,
            generalCount: generalAdded,
            strictFound: strictCount,
            obfuscatedFound: obfuscatedCount,
            cleanedTextChars: extraction.cleanedTextChars,
            obfuscationTokensSample: extraction.obfuscationSampleTokens.slice(0, 3)
          });
        }

        if (collectDebug) debug.aggregate.totalPagesFetched += 1;
      } catch (err) {
        pageErr = err.name === 'AbortError' ? 'timeout' : err.message;
        failedUrls.push({
          url: finalUrl,
          error: pageErr,
          searchPage: qi + 1,
          type: 'page'
        });
        if (collectDebug) {
          queryDebug && queryDebug.pages.push({
            url: finalUrl,
            status: pageStatus,
            error: pageErr
          });
          debug.aggregate.totalPageFetchErrors += 1;
        }
      }
    }

    if (collectDebug && queryDebug) debug.perQuery.push(queryDebug);
    if (captcha) break;
  }

  if (everyQueryZeroLinks) {
    try {
      const fallback = await duckDuckGoFallback(query, maxUrlsPerQuery, hrFocus);
      fallback.snippetHr.forEach(e => snippetHREmails.add(e));
      fallback.snippetGeneral.forEach(e => snippetGeneralEmails.add(e));
      if (collectDebug) {
        debug.fallback = {
          engine: 'duckduckgo',
          reason: 'bing-zero-links',
          linksFound: fallback.links.length,
          snippetHrFound: fallback.snippetHr.length,
          snippetGeneralFound: fallback.snippetGeneral.length
        };
      }
    } catch (e) {
      if (collectDebug) {
        debug.fallback = { engine: 'duckduckgo', reason: 'bing-zero-links', error: e.message };
      }
    }
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
    debug.aggregate.everyQueryZeroLinks = everyQueryZeroLinks;
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

/* ---------- /search (single page) ---------- */
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
    return res.status(400).json({ error: 'Missing parameter: query' });
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
      maxQueries: 2,
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
      note: collectDebug && ordered.length === 0
        ? (
          result.debug?.aggregate?.everyQueryZeroLinks
            ? 'NO_LINKS_EXTRACTED (BING SHELL / FALLBACK)'
            : 'NO_EMAILS_FOUND_AFTER_CLEANING'
        )
        : undefined
    });

  } catch (err) {
    console.error('SEARCH ERROR:', err);
    res.status(500).json({
      error: 'Scraping failed',
      message: err.message || 'Unknown error',
      debugHint: 'Add &debug=1 to inspect.'
    });
  }
});

/* ---------- /search-all (multi-page) ---------- */
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
    return res.status(400).json({ error: 'Missing parameter: query' });
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
        emailsByType: { hr: result.hrEmails, general: result.generalEmails },
        emailsBySearchPage: pages === 1 ? null : pageBreakdown,
        scrapedUrls: result.scrapedUrls,
        failedUrls: result.failedUrls,
        allSearchUrls: result.allSearchUrls
      },
      debug: collectDebug ? result.debug : undefined,
      note: collectDebug && ordered.length === 0
        ? (result.debug?.aggregate?.everyQueryZeroLinks
            ? 'NO_LINKS_EXTRACTED (BING SHELL / FALLBACK)'
            : 'NO_EMAILS_FOUND_AFTER_CLEANING')
        : undefined
    });

  } catch (err) {
    console.error('SEARCH-ALL ERROR:', err);
    res.status(500).json({
      error: 'Comprehensive scraping failed',
      message: err.message || 'Unknown error',
      debugHint: 'Add &debug=1 to inspect.'
    });
  }
});

/* ---------- HEALTH ---------- */
router.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    limits: { PAGE_TEXT_CHAR_LIMIT },
    endpoints: {
      '/search': { params: ['query','urls','page','limit','country','hrFocus','debug'] },
      '/search-all': { params: ['query','maxPages','urlsPerPage','maxUrls','country','hrFocus','debug'] }
    }
  });
});

module.exports = router;
