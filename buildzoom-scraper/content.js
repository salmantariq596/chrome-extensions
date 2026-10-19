// bz_k_v2_scraper — BuildZoom Search Results Scraper v2
(function() {
  'use strict';

  if (window.__bzScraperActive) return;
  window.__bzScraperActive = true;

  // Clean URL: remove hash fragments and trailing slashes
  function cleanUrl(href) {
    if (!href) return '';
    try {
      const url = new URL(href, location.origin);
      url.hash = '';
      let path = url.pathname.replace(/\/$/, '');
      return url.origin + path;
    } catch (e) {
      return href.split('#')[0].replace(/\/$/, '');
    }
  }

  // Get text content safely
  function getText(el) {
    if (!el) return '';
    return el.innerText?.trim() || el.textContent?.trim() || '';
  }

  // Get attribute safely
  function getAttr(el, attr) {
    if (!el) return '';
    return el.getAttribute(attr)?.trim() || '';
  }

  // Find closest ancestor matching selector, up to maxDepth
  function closest(el, selector, maxDepth = 8) {
    let current = el;
    let depth = 0;
    while (current && current !== document.body && current !== document.documentElement && depth < maxDepth) {
      if (current.matches && current.matches(selector)) return current;
      current = current.parentElement;
      depth++;
    }
    return null;
  }

  // Find card container for a contractor link
  // Strategy: walk up from the link until we hit a likely card boundary
  function findCardContainer(linkEl) {
    let el = linkEl;
    let depth = 0;
    const maxDepth = 10;

    while (el && el !== document.body && depth < maxDepth) {
      const tag = el.tagName.toLowerCase();
      const cls = el.className;

      // Strong signals for card container
      if (cls) {
        const c = cls.toLowerCase();
        if (c.includes('card') || c.includes('listing') || c.includes('result') || c.includes('item') || c.includes('contractor')) {
          return el;
        }
      }

      // If this element contains a "get quote" button with data-contractor-id, it's likely the card
      if (el.querySelector('a[data-contractor-id]') || el.querySelector('[data-contractor-id]')) {
        return el;
      }

      // If this element directly contains ONLY one contractor link and related info, it's the card
      const contractorLinksInParent = el.querySelectorAll('a[href*="/contractor/"]');
      if (contractorLinksInParent.length >= 1 && contractorLinksInParent.length <= 4) {
        // Check if parent of this element has MORE links — if so, this is the card
        const parent = el.parentElement;
        if (parent) {
          const parentLinks = parent.querySelectorAll('a[href*="/contractor/"]');
          if (parentLinks.length > contractorLinksInParent.length) {
            return el;
          }
        }
      }

      el = el.parentElement;
      depth++;
    }

    // Fallback: return the link itself as the "card"
    return linkEl;
  }

  // Main scrape function
  function scrapePage() {
    // Find all contractor links
    const allLinks = Array.from(document.querySelectorAll('a[href*="/contractor/"]'));

    // Deduplicate by cleaned URL
    const seenUrls = new Set();
    const uniqueLinks = [];
    for (const link of allLinks) {
      const clean = cleanUrl(link.href);
      if (!clean || seenUrls.has(clean)) continue;
      seenUrls.add(clean);
      uniqueLinks.push(link);
    }

    const results = [];
    const usedCards = new Set(); // Track DOM elements to avoid duplicate cards

    for (const link of uniqueLinks) {
      const card = findCardContainer(link);
      if (usedCards.has(card)) continue;
      usedCards.add(card);

      const profileUrl = cleanUrl(link.href);
      const contractorName = getText(link) || getText(card.querySelector('h2, h3, h4, .contractor-name, .business-name'));

      if (!contractorName) continue;

      // Extract contractor ID from any element in the card
      const idEl = card.querySelector('[data-contractor-id]');
      const contractorId = getAttr(idEl, 'data-contractor-id');

      // BZ Score — often displayed as a badge or number
      const bzScore = getText(
        card.querySelector('.bz-score, [data-bz-score], .score-badge, .rating-score, .buildzoom-score, .bz-rating')
      ).replace(/[^0-9.]/g, '');

      // Price range / project value
      const priceRange = getText(
        card.querySelector('.price-range, .project-value, .budget-range, .avg-project-cost, .cost-range')
      );

      // Address / location
      const address = getText(
        card.querySelector('.address, .location, .full-address, address, .city-state, .service-area')
      );

      // Phone — look for tel: links or phone classes
      const phoneEl = card.querySelector('a[href^="tel:"], .phone, .phone-number, [data-phone]');
      const phone = getText(phoneEl).replace(/^tel:/, '').replace(/[^0-9+\-()\s]/g, '');

      // Star rating
      const rating = getText(
        card.querySelector('.rating, .stars, .review-rating, .star-rating, .score-value')
      );

      // Review count
      const reviewCount = getText(
        card.querySelector('.review-count, .reviews-count, [data-review-count], .num-reviews')
      ).replace(/[^0-9]/g, '');

      // Description / bio / summary
      const description = getText(
        card.querySelector('.description, .bio, .summary, .about-text, .contractor-desc, .overview')
      );

      // Total projects / jobs completed
      const totalProjects = getText(
        card.querySelector('.project-count, .total-projects, .jobs-completed, .completed-projects, .num-projects')
      ).replace(/[^0-9]/g, '');

      // License info if available
      const license = getText(
        card.querySelector('.license, .license-number, .licensed, .license-info')
      );

      // Years in business
      const yearsInBusiness = getText(
        card.querySelector('.years-in-business, .experience, .founded, .established')
      ).replace(/[^0-9]/g, '');

      results.push({
        contractorName,
        contractorId,
        profileUrl,
        bzScore,
        priceRange,
        address,
        phone,
        rating,
        reviewCount,
        description,
        totalProjects,
        license,
        yearsInBusiness,
        scrapedAt: new Date().toISOString(),
        pageUrl: location.href
      });
    }

    return results;
  }

  // Highlight detected cards
  function highlightCards() {
    document.querySelectorAll('.bz-scraper-highlight').forEach(e => e.classList.remove('bz-scraper-highlight'));

    const allLinks = Array.from(document.querySelectorAll('a[href*="/contractor/"]'));
    const seenUrls = new Set();
    const uniqueLinks = [];
    for (const link of allLinks) {
      const clean = cleanUrl(link.href);
      if (!clean || seenUrls.has(clean)) continue;
      seenUrls.add(clean);
      uniqueLinks.push(link);
    }

    const usedCards = new Set();
    let count = 0;
    for (const link of uniqueLinks) {
      const card = findCardContainer(link);
      if (usedCards.has(card)) continue;
      usedCards.add(card);
      card.classList.add('bz-scraper-highlight');
      count++;
    }
    return count;
  }

  // Clear highlights
  function clearHighlights() {
    document.querySelectorAll('.bz-scraper-highlight').forEach(e => e.classList.remove('bz-scraper-highlight'));
  }

  // Message handler
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'ping') {
      sendResponse({ ok: true, url: location.href });
      return true;
    }

    if (request.action === 'scrape') {
      const data = scrapePage();
      sendResponse({ ok: true, count: data.length, data });
      return true;
    }

    if (request.action === 'highlightCards') {
      const count = highlightCards();
      sendResponse({ ok: true, count });
      return true;
    }

    if (request.action === 'clearHighlights') {
      clearHighlights();
      sendResponse({ ok: true });
      return true;
    }

    if (request.action === 'getStats') {
      const allLinks = Array.from(document.querySelectorAll('a[href*="/contractor/"]'));
      const seen = new Set();
      let unique = 0;
      for (const l of allLinks) {
        const c = cleanUrl(l.href);
        if (c && !seen.has(c)) { seen.add(c); unique++; }
      }
      sendResponse({ ok: true, totalLinks: allLinks.length, uniqueContractors: unique });
      return true;
    }

    return true;
  });

  // Inject highlight styles
  const style = document.createElement('style');
  style.textContent = `
    .bz-scraper-highlight {
      outline: 3px dashed #ff5722 !important;
      outline-offset: 4px !important;
      background: rgba(255, 87, 34, 0.10) !important;
      transition: outline 0.2s ease, background 0.2s ease;
      position: relative;
    }
    .bz-scraper-highlight::after {
      content: "BZ";
      position: absolute;
      top: 4px;
      right: 4px;
      background: #ff5722;
      color: #fff;
      font-size: 10px;
      font-weight: bold;
      padding: 2px 6px;
      border-radius: 3px;
      z-index: 9999;
      pointer-events: none;
    }
  `;
  document.head.appendChild(style);

  console.log('[bz_k_v2_scraper] Loaded on', location.href);
})();
