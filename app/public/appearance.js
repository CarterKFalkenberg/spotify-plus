// Runs before application styles/rendering so saved appearance is the first paint.
(() => {
  const key = "spotify-plus-theme";
  const read = () => {
    try {
      const value = localStorage.getItem(key);
      if (value === "light" || value === "dark") return value;
    } catch {
      // Storage is optional; System is always available.
    }
    return "system";
  };
  const apply = (theme) => {
    const dark =
      theme === "dark" ||
      (theme === "system" &&
        matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", dark ? "#141516" : "#f5f5f7");
  };
  window.spotifyPlusAppearance = { key, read, apply };
  apply(read());
})();
