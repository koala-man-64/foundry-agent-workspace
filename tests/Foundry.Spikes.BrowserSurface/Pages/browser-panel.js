// BrowserPanel.tsx sendBounds (lines 56-68) and its layout effect (lines 70-77), unchanged except that api.browser
// becomes a bridge post and hidden, confirmation and tabId are fields the spike page sets. Repeated bounds are
// suppressed exactly as boundsRef does, so a display-scale change that leaves CSS pixels alone sends nothing.
const panel = { hidden: false, confirmation: null, tabId: 'tab-1', boundsKey: '' };
const post = value => chrome.webview.postMessage(JSON.stringify(value));
const content = document.querySelector('.browser-content');

function sendBounds() {
  const rectangle = content?.getBoundingClientRect();
  const x = rectangle ? Math.max(0, Math.ceil(rectangle.left)) : 0;
  const y = rectangle ? Math.max(0, Math.ceil(rectangle.top)) : 0;
  const right = rectangle ? Math.min(window.innerWidth, Math.floor(rectangle.right)) : 0;
  const bottom = rectangle ? Math.min(window.innerHeight, Math.floor(rectangle.bottom)) : 0;
  const bounds = { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y), visible: !panel.hidden && !panel.confirmation && Boolean(panel.tabId) && right > x && bottom > y };
  const key = JSON.stringify(bounds);
  if (key === panel.boundsKey) return;
  panel.boundsKey = key;
  post({ kind: 'bounds', bounds });
}

// React recreates sendBounds when confirmation changes and its layout effect calls it at once.
function setConfirmation(value) {
  panel.confirmation = value;
  sendBounds();
}

new ResizeObserver(sendBounds).observe(content);
window.addEventListener('resize', sendBounds);
sendBounds();
