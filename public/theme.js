// Applies the theme chosen in Settings before the page draws (so there's no flash).
// "system" (default) follows the computer's light/dark setting; "light" and "dark" override it.
(function () {
  try {
    const theme = localStorage.getItem("tinker.theme");
    if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  } catch {
    // storage blocked: follow the system setting
  }
})();
