/* Кнопка «светлая / тёмная тема» справа сбоку страницы сотрудников.
   Подключается обычным скриптом в <head> (без defer), чтобы сохранённая тема включилась до отрисовки, без мигания.
   Выбор хранится в localStorage под ключом из data-key. Пока выбора нет, тема как у системы (или у Telegram). */
(function () {
  var script = document.currentScript;
  var KEY = (script && script.dataset.key) || "vexa_crm_theme";
  var root = document.documentElement;
  var dark = window.matchMedia ? matchMedia("(prefers-color-scheme: dark)") : null;
  var button;

  function saved() {
    try { var v = JSON.parse(localStorage.getItem(KEY)); return v === "dark" || v === "light" ? v : null; } catch (e) { return null; }
  }
  function current() {
    if (root.dataset.theme === "dark" || root.dataset.theme === "light") return root.dataset.theme;
    return dark && dark.matches ? "dark" : "light";
  }
  function show() {
    if (!button) return;
    var isDark = current() === "dark";
    button.setAttribute("aria-pressed", String(isDark));
    button.title = isDark ? "Включить светлую тему" : "Включить тёмную тему";
    button.setAttribute("aria-label", button.title);
  }
  function apply(theme) {
    // Выбор сотрудника важнее темы Telegram: js/core.js не трогает тему, пока стоит data-theme-locked
    if (theme) { root.dataset.theme = theme; root.dataset.themeLocked = "1"; }
    show();
  }

  apply(saved());
  addEventListener("storage", function (e) { if (e.key === KEY) apply(saved()); });
  if (dark && dark.addEventListener) dark.addEventListener("change", show);
  // Тему может поменять и Telegram (js/core.js) — иконка следует за ней
  if (window.MutationObserver) new MutationObserver(show).observe(root, { attributes: true, attributeFilter: ["data-theme"] });

  var css =
    ".theme-toggle{position:fixed;right:0;top:50%;transform:translateY(-50%);z-index:25;display:flex;align-items:center;justify-content:center;" +
    "width:40px;height:44px;padding:0 0 0 2px;border:1px solid var(--line);border-right:0;border-radius:12px 0 0 12px;" +
    "background:var(--surface);color:var(--ink);box-shadow:var(--shadow-sm);cursor:pointer;transition:width .15s,background .15s}" +
    ".theme-toggle:hover{width:46px;background:var(--hover)}" +
    ".theme-toggle svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}" +
    ".theme-toggle .i-sun,.theme-toggle[aria-pressed=true] .i-moon{display:none}" +
    ".theme-toggle[aria-pressed=true] .i-sun{display:block}" +
    "@media print{.theme-toggle{display:none}}";

  function mount() {
    var style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);
    button = document.createElement("button");
    button.type = "button";
    button.className = "theme-toggle";
    // В тёмной теме показываем солнце (переключит на светлую), в светлой — луну
    button.innerHTML =
      '<svg class="i-moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>' +
      '<svg class="i-sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
    button.addEventListener("click", function () {
      var next = current() === "dark" ? "light" : "dark";
      try { localStorage.setItem(KEY, JSON.stringify(next)); } catch (e) {}
      apply(next);
    });
    document.body.appendChild(button);
    show();
  }
  if (document.body) mount(); else document.addEventListener("DOMContentLoaded", mount);
})();
