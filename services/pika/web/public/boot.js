// The theme before first paint: the stored choice, else the system's. A file, not an inline script, so the
// Content-Security-Policy that comes with nodes (`script-src 'self'`) lets it run. Mirrors `src/lib/theme.ts`.
(function () {
	try {
		var t = localStorage.getItem("pika-theme");
		if (t !== "light" && t !== "dark") t = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
		document.documentElement.dataset.theme = t;
	} catch (e) {}
})();
