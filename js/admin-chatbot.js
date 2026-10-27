// «Чат-бот» (директор и менеджеры): правила ответов в директ на комментарии в Instagram.
// Правило — пост, слова и товар: кто напишет под этим постом одно из слов, получит в директ ссылку на товар
// (бот instagram-bot, supabase-instagram-comments.sql). Правило без поста работает под всеми остальными постами.
// Правила хранятся в каталоге: igRules = [{ post: "код поста" | "", words: ["+", "хочу"], product: id }].
import { $, escapeHtml, haptic, toast } from "./core.js?v=20261001b";
import { state, api, errorMessage } from "./state.js?v=20261001b";
import { refreshCatalog } from "./catalog.js?v=20261001b";
import { sheetBody, openSheet } from "./nav.js?v=20261001b";
import { productImage } from "./photos.js?v=20261001b";

// Код поста — из ссылки instagram.com/p/КОД/ или /reel/КОД/
const IG_POST = /instagram\.com\/(?:[\w.]+\/)?(?:p|reel|reels|tv)\/([\w-]{5,40})/i;
const postUrl = (code) => `https://www.instagram.com/p/${code}/`;
const STATUS = { queued: "⏳ в очереди", sending: "⏳ отправляется", sent: "✅ отправлен", skipped: "— пропущен", failed: "✖️ не отправлен" };

let editing = null; // { index | null, post, words, product }
let hint = "";
let log = null, logError = "";

/** Правила из каталога; старые привязки из карточки товара (igPosts) — как правила со словом «+» */
function rules() {
  const list = Array.isArray(state.igRules) ? state.igRules : [];
  const legacy = Object.entries(state.igPosts || {}).flatMap(([id, codes]) =>
    codes.filter((code) => !list.some((r) => r.post === code)).map((code) => ({ post: code, words: ["+"], product: Number(id) })));
  return [...list, ...legacy];
}

const productOf = (id) => state.warehouseProducts.find((p) => p.id === Number(id));
const onSale = (id) => state.catalogProducts.some((p) => p.id === Number(id)); // в каталоге — только то, что продаётся

function ruleHtml(r, i) {
  const p = productOf(r.product);
  return `<article class="ord adm-bot-rule">
    <div class="adm-rv-prod">${p ? `<span class="thumb">${productImage(p, null, { thumb: true })}</span>` : ""}
      <b>${p ? p.name : `Товар №${Number(r.product)} удалён`}</b></div>
    <p class="adm-sub">${r.post ? `Пост: <a href="${postUrl(r.post)}" target="_blank" rel="noopener">${escapeHtml(r.post)}</a>` : "Под любым постом"}</p>
    <p class="adm-sub">Слова: ${r.words.map((w) => `<b>${escapeHtml(w)}</b>`).join(", ")}</p>
    ${p && !onSale(r.product) ? `<p class="hint">Товар снят с продажи — бот по этому правилу не отвечает</p>` : ""}
    <div class="rv-tools"><button class="link" data-bot-edit="${i}">Изменить</button><button class="link danger" data-bot-del="${i}">Удалить</button></div>
  </article>`;
}

function formHtml() {
  const e = editing, products = state.catalogProducts;
  return `<article class="ord">
    <p class="label">${e.index == null ? "Новое правило" : "Правило"}</p>
    <label class="field"><span>Ссылка на пост или рилс <small>пусто — под любым постом</small></span>
      <input id="botPost" value="${escapeHtml(e.post)}" placeholder="https://www.instagram.com/p/…"></label>
    <label class="field"><span>Слова через запятую</span>
      <input id="botWords" value="${escapeHtml(e.words)}" placeholder="+, хочу, цена"></label>
    <label class="field"><span>Товар</span><select id="botProduct">
      <option value="">Выберите товар</option>
      ${products.map((p) => `<option value="${p.id}" ${p.id === Number(e.product) ? "selected" : ""}>${p.name}</option>`).join("")}
    </select></label>
    <p class="hint" id="botHint">${escapeHtml(hint)}</p>
    <div class="ord-actions"><button class="primary sm" id="botSave">Сохранить</button><button class="ghost" id="botCancel">Отмена</button></div>
  </article>`;
}

function logHtml() {
  if (logError) return `<p class="hint">${escapeHtml(logError)}</p>`;
  if (!log) return `<p class="adm-sub">Загружаем…</p>`;
  if (!log.length) return `<p class="adm-sub">Пока никто не написал ключевое слово под постами с правилами.</p>`;
  const at = (iso) => new Date(iso).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  return log.map((r) => `<p class="adm-sub adm-bot-log"><b>@${escapeHtml(r.username || "без логина")}</b> «${escapeHtml(r.text || "")}» ·
    ${productOf(r.product)?.name ?? "товар"} · ${STATUS[r.status] ?? r.status}${r.error && r.status !== "sent" ? ` (${escapeHtml(r.error)})` : ""} · ${at(r.at)}</p>`).join("");
}

function render() {
  if (state.view !== "chatbot") return;
  const list = rules();
  sheetBody.innerHTML = `<div class="grab"></div><h2 class="p-name">Чат-бот Instagram</h2>
    <p class="adm-sub">Кто напишет под постом одно из слов правила, получит в директ ссылку на товар. Бот отвечает один раз на человека
      под одним постом, через 1–2 минуты и разными текстами, чтобы Instagram не принял это за спам.</p>
    ${editing ? formHtml() : `<button class="primary" id="botAdd" style="margin-top:12px">+ Добавить правило</button>`}
    ${list.length ? list.map(ruleHtml).join("") : editing ? "" : `<p class="adm-sub" style="margin-top:12px">Правил пока нет.</p>`}
    <p class="label">Последние ответы</p>
    ${logHtml()}`;
}

/** Слова из поля: без повторов, в нижнем регистре; «+» — как есть */
const parseWords = (text) => [...new Set(String(text).split(",").map((w) => w.trim().toLowerCase().replace(/ё/g, "е")).filter(Boolean))].slice(0, 20);

async function save(button) {
  const postText = $("botPost").value.trim(), words = parseWords($("botWords").value), product = Number($("botProduct").value);
  const post = postText ? IG_POST.exec(postText)?.[1] : "";
  editing = { ...editing, post: postText, words: $("botWords").value, product };
  const fail = (text) => { hint = text; render(); haptic("medium"); };
  if (post === undefined) return fail("Это не ссылка на пост Instagram. Скопируйте её в Instagram: ⋯ → «Копировать ссылку».");
  if (!words.length) return fail("Впишите хотя бы одно слово, например +");
  if (!product) return fail("Выберите товар");
  const list = rules();
  const clash = list.find((r, i) => i !== editing.index && r.post === post && r.words.some((w) => words.includes(w)));
  if (clash) return fail(`Слово «${clash.words.find((w) => words.includes(w))}» ${post ? "под этим постом" : "под любым постом"} уже ведёт на «${productOf(clash.product)?.name ?? "другой товар"}»`);
  const rule = { post, words, product };
  if (editing.index == null) list.push(rule); else list[editing.index] = rule;
  button.disabled = true;
  if (await store(list, "Правило сохранено")) { editing = null; hint = ""; render(); }
  else button.disabled = false;
}

async function store(list, done) {
  try {
    await api.setIgRules(list);
    await refreshCatalog();
    haptic("success");
    toast(done);
    return true;
  } catch (error) {
    toast(errorMessage(error));
    return false;
  }
}

async function onClick(e) {
  const t = e.target;
  if (t.id === "botAdd") { haptic(); editing = { index: null, post: "", words: "+", product: "" }; hint = ""; return render(); }
  if (t.id === "botCancel") { haptic(); editing = null; return render(); }
  if (t.id === "botSave") return save(t);
  const edit = t.closest("[data-bot-edit]");
  if (edit) {
    const i = Number(edit.dataset.botEdit), r = rules()[i];
    haptic();
    editing = { index: i, post: r.post ? postUrl(r.post) : "", words: r.words.join(", "), product: r.product };
    hint = "";
    render();
    return $("botPost")?.scrollIntoView({ block: "center" });
  }
  const del = t.closest("[data-bot-del]");
  if (del) {
    if (!del.hasAttribute("data-armed")) { del.setAttribute("data-armed", ""); del.textContent = "Точно удалить?"; return haptic("medium"); }
    del.disabled = true;
    const list = rules().filter((_, i) => i !== Number(del.dataset.botDel));
    if (await store(list, "Правило удалено")) { editing = null; render(); }
  }
}

async function loadLog() {
  try {
    log = (await api.igCommentLog()) || [];
    logError = "";
  } catch (error) {
    logError = error?.code === "no_function" ? "Журнал не настроен: в Supabase запустите supabase-instagram-comments.sql ещё раз" : "Не удалось загрузить журнал";
  }
  render();
}

export function openChatbot() {
  editing = null;
  hint = "";
  sheetBody.onclick = onClick;
  sheetBody.oninput = null;
  openSheet("chatbot");
  render();
  loadLog();
}

export function initChatbot() {
  $("adminChatbotButton").onclick = () => { haptic(); openChatbot(); };
}
