// Демо «телефон + CRM». Обе половины — страницы из app/ с общей базой в localStorage (app/js/demo.js),
// поэтому всё, что сделано в одной, сразу видно в другой. Здесь только раскладка, вход в CRM и сброс.
(() => {
  const PREFIX = "vexademo_";                 // как STORAGE_PREFIX в app/js/core.js
  const TOKEN_KEY = PREFIX + "temp_staff_token";
  const VIEW_KEY = "vexademo_split_view";     // выбор раскладки посетителя; при сбросе не стирается
  const THEME_KEY = "vexademo_theme";         // светлая или тёмная тема; читают и страницы из app/, тоже не стирается
  const PHONE_W = 414, PHONE_H = 868;         // телефон с рамкой
  const CRM_MIN_W = 1100;                     // уже — CRM рисуется в этой ширине и уменьшается

  const $ = (id) => document.getElementById(id);
  const stage = $("stage"), phone = $("phone"), phoneFit = $("phoneFit");
  const crmFit = $("crmFit"), crmFrame = $("crmFrame"), shopFrame = $("shopFrame");
  const narrow = matchMedia("(max-width: 899px)");

  const read = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
  const write = (key, value) => { try { localStorage.setItem(key, value); } catch {} };

  /* ---------- Раскладка ---------- */
  const guide = $("guide"), steps = $("steps");
  let view = read(VIEW_KEY) || "both";
  if (view === "guide") view = "both";        // «Инструкцию» не запоминаем: демо открывается сразу с телефоном и CRM
  function setView(next, save = true) {
    view = next;
    if (save && view !== "guide") write(VIEW_KEY, view);
    const reading = view === "guide";
    guide.hidden = !reading; stage.hidden = reading; steps.hidden = reading;
    if (!reading) for (const v of guide.querySelectorAll("video")) v.pause();
    // На телефоне двух экранов рядом нет: «оба» показывает магазин
    const shown = narrow.matches && view === "both" ? "shop" : view;
    if (!reading) stage.dataset.view = shown;
    for (const b of document.querySelectorAll("[data-view]")) {
      if (b.tagName === "BUTTON") b.setAttribute("aria-pressed", String(b.dataset.view === shown));
    }
    fit();
  }
  document.querySelector(".views").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-view]");
    if (b) setView(b.dataset.view);
  });
  narrow.addEventListener("change", () => setView(view, false));

  function fit() {
    if (narrow.matches) {
      phone.style.removeProperty("--s");
      phoneFit.style.width = "";
      crmFrame.style.cssText = "";
      return;
    }
    // Телефон: по высоте сцены, не крупнее настоящего размера
    const s = Math.min(1, phoneFit.clientHeight / PHONE_H);
    phone.style.setProperty("--s", s.toFixed(4));
    phoneFit.style.width = stage.dataset.view === "shop" ? "" : Math.ceil(PHONE_W * s) + "px";
    // CRM: на узкой сцене — компьютерная раскладка в уменьшенном виде
    const w = crmFit.clientWidth, h = crmFit.clientHeight;
    if (!w || w >= CRM_MIN_W) { crmFrame.style.cssText = ""; return; }
    const k = w / CRM_MIN_W;
    crmFrame.style.cssText = `width:${CRM_MIN_W}px;height:${Math.ceil(h / k)}px;transform:scale(${k})`;
  }
  new ResizeObserver(fit).observe(stage);

  /* ---------- Тема: светлая или тёмная, сразу у страницы, магазина и CRM ---------- */
  const themeButton = $("theme");
  const currentTheme = () => (document.documentElement.dataset.theme === "dark" ? "dark" : "light");
  function showTheme(theme) {
    document.documentElement.dataset.theme = theme;
    themeButton.setAttribute("aria-pressed", String(theme === "dark"));
    $("themeText").textContent = theme === "dark" ? "Тёмная" : "Светлая";
    themeButton.title = theme === "dark" ? "Включить светлую тему" : "Включить тёмную тему";
  }
  themeButton.addEventListener("click", () => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    write(THEME_KEY, JSON.stringify(next)); // страницы в рамках получат событие storage и перекрасятся сами
    showTheme(next);
  });
  addEventListener("storage", (e) => {
    if (e.key === THEME_KEY) { try { showTheme(JSON.parse(e.newValue) === "dark" ? "dark" : "light"); } catch {} }
  });
  showTheme(currentTheme());

  /* ---------- Вход в CRM: директор или менеджер (без пароля, это демо) ---------- */
  const role = $("role");
  function syncRole() {
    let token = "demo";
    try { token = JSON.parse(read(TOKEN_KEY)) ?? "demo"; } catch {}
    if (token === "demo") token = "demo-1";
    const known = [...role.options].some((o) => o.value === token);
    role.value = known ? token : "demo-1";
  }
  role.addEventListener("change", () => {
    write(TOKEN_KEY, JSON.stringify(role.value));
    crmFrame.contentWindow.location.reload();
  });
  // Вышли или вошли внутри CRM — список показывает, кто сейчас в панели
  addEventListener("storage", (e) => { if (e.key === TOKEN_KEY) syncRole(); });

  /* ---------- Сброс: исходные заказы, пустая корзина, вход директора ---------- */
  const reset = $("reset");
  let armTimer = 0;
  reset.addEventListener("click", () => {
    if (!reset.hasAttribute("data-armed")) {
      reset.setAttribute("data-armed", "");
      reset.textContent = "Точно сбросить?";
      armTimer = setTimeout(() => { reset.removeAttribute("data-armed"); reset.textContent = "Сбросить демо"; }, 4000);
      return;
    }
    clearTimeout(armTimer);
    reset.removeAttribute("data-armed");
    reset.textContent = "Сбросить демо";
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (key?.startsWith(PREFIX) && key !== VIEW_KEY && key !== THEME_KEY) localStorage.removeItem(key);
      }
    } catch {}
    syncRole();
    shopFrame.contentWindow.location.reload();
    crmFrame.contentWindow.location.reload();
  });

  syncRole();
  setView(view, false);
})();
