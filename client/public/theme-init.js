// Runs before the app bundle so the saved theme applies without a flash of the wrong colors.
(function () {
  var theme;
  try {
    theme = localStorage.getItem('vd-theme');
  } catch (e) {}
  if (theme !== 'dark' && theme !== 'light' && theme !== 'simple') {
    theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  document.documentElement.setAttribute('data-theme', theme);
})();
