// Apply a saved dark-mode choice before first paint so it doesn't flash light.
// Kept as its own file (not inline) so the Content-Security-Policy can block
// every inline script.
try { if (localStorage.getItem('therealtotal:theme') === 'dark') document.documentElement.setAttribute('data-theme', 'dark'); } catch (e) {}
