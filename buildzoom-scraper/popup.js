/* global chrome */
(function() {
  const $ = id => document.getElementById(id);
  let lastData = [];

  function setStatus(msg, type='info') {
    const el = $('status');
    el.textContent = msg;
    el.style.color = type === 'error' ? '#c5221f' : (type === 'success' ? '#137333' : '#555');
  }

  async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  async function sendToTab(msg) {
    const tab = await getActiveTab();
    if (!tab?.id) throw new Error('No active tab');
    if (!tab.url.includes('buildzoom.com')) {
      throw new Error('Not on a BuildZoom page');
    }
    return chrome.tabs.sendMessage(tab.id, msg);
  }

  async function refreshStats() {
    try {
      const resp = await sendToTab({ action: 'getStats' });
      if (resp?.ok) {
        $('stats').textContent = `Page has ${resp.totalLinks} contractor links (${resp.uniqueContractors} unique)`;
      }
    } catch (e) {
      $('stats').textContent = '';
    }
  }

  $('btnScrape').addEventListener('click', async () => {
    try {
      setStatus('Scraping...');
      const resp = await sendToTab({ action: 'scrape' });
      if (!resp || !resp.ok) {
        setStatus('Scrape failed.', 'error');
        return;
      }
      lastData = resp.data || [];
      $('count').textContent = lastData.length;
      $('btnDownloadCsv').disabled = lastData.length === 0;
      $('btnDownloadJson').disabled = lastData.length === 0;
      setStatus(`Scraped ${lastData.length} unique contractors.`, 'success');

      const preview = lastData.slice(0, 4).map(d =>
        `${d.contractorName}${d.contractorId ? ' (ID: ' + d.contractorId + ')' : ''}\n  ${d.profileUrl || ''}\n  ${d.address || 'No address'} | ${d.phone || 'No phone'} | Score: ${d.bzScore || 'N/A'}`
      ).join('\n\n');
      $('preview').textContent = preview + (lastData.length > 4 ? `\n\n...and ${lastData.length - 4} more` : '');
    } catch (e) {
      setStatus(e.message, 'error');
    }
  });

  $('btnHighlight').addEventListener('click', async () => {
    try {
      const resp = await sendToTab({ action: 'highlightCards' });
      setStatus(`Highlighted ${resp?.count || 0} contractor cards.`, 'success');
    } catch (e) {
      setStatus(e.message, 'error');
    }
  });

  $('btnClear').addEventListener('click', async () => {
    try {
      await sendToTab({ action: 'clearHighlights' });
      lastData = [];
      $('count').textContent = '0';
      $('btnDownloadCsv').disabled = true;
      $('btnDownloadJson').disabled = true;
      $('preview').textContent = '';
      setStatus('Cleared.');
    } catch (e) {
      setStatus(e.message, 'error');
    }
  });

  function toCSV(rows) {
    if (!rows.length) return '';
    const headers = Object.keys(rows[0]);
    const lines = [headers.join(',')];
    for (const row of rows) {
      const line = headers.map(h => {
        const val = (row[h] ?? '').toString();
        if (val.includes(',') || val.includes('"') || val.includes('\n') || val.includes('\r')) {
          return '"' + val.replace(/"/g, '""') + '"';
        }
        return val;
      }).join(',');
      lines.push(line);
    }
    return lines.join('\n');
  }

  $('btnDownloadCsv').addEventListener('click', () => {
    if (!lastData.length) return;
    const csv = toCSV(lastData);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({
      url,
      filename: `bz_k_v2_scraper_${new Date().toISOString().slice(0,10)}.csv`,
      saveAs: true
    });
  });

  $('btnDownloadJson').addEventListener('click', () => {
    if (!lastData.length) return;
    const json = JSON.stringify(lastData, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({
      url,
      filename: `bz_k_v2_scraper_${new Date().toISOString().slice(0,10)}.json`,
      saveAs: true
    });
  });

  // Init
  (async () => {
    try {
      const resp = await sendToTab({ action: 'ping' });
      if (resp?.ok) {
        setStatus('Connected to BuildZoom.');
        await refreshStats();
      }
    } catch (e) {
      setStatus('Open a BuildZoom search page first.', 'error');
    }
  })();
})();
