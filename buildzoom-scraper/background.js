chrome.runtime.onInstalled.addListener(() => {
  console.log('bz_k_v2_scraper installed');
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'download') {
    chrome.downloads.download({
      url: request.url,
      filename: request.filename,
      saveAs: request.saveAs ?? false
    }, (downloadId) => {
      sendResponse({ ok: !!downloadId, downloadId });
    });
    return true;
  }
});
