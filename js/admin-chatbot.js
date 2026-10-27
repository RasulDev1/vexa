// «Чат-бот» (директор и менеджеры): правила ответов в директ на комментарии в Instagram.
// Правило — пост, слова и товар: кто напишет под этим постом одно из слов, получит в директ ссылку на товар
// (бот instagram-bot, supabase-instagram-comments.sql). Правило без поста работает под всеми остальными постами.
// Правила хранятся в каталоге: igRules = [{ post: "код поста" | "", words: ["+", "хочу"], product: id, replies? }].
// Тексты ответа — тоже в каталоге: igReplies = { greetingsNamed, greetings, about, about2, links }, в каждом список вариантов.
// У правила могут быть свои тексты (replies, те же блоки): пустой блок правила — бот берёт общий текст.
// greetingMode (в igReplies и в replies правила): "named" — всегда приветствие с логином, "plain" — всегда без,
// нет — вперемешку; у правила без своего — как в общем тексте.
import { $, escapeHtml, haptic, toast } from "./core.js?v=20261001b";
import { state, api, errorMessage } from "./state.js?v=20261001b";
import { refreshCatalog } from "./catalog.js?v=20261001b";
import { sheetBody, openSheet } from "./nav.js?v=20261001b";
import { productImage } from "./photos.js?v=20261001b";

// Код поста — из ссылки instagram.com/p/КОД/ или /reel/КОД/
const IG_POST = /instagram\.com\/(?:[\w.]+\/)?(?:p|reel|reels|tv)\/([\w-]{5,40})/i;
const postUrl = (code) => `https://www.instagram.com/p/${code}/`;
const STATUS = { queued: "⏳ в очереди", sending: "⏳ отправляется", sent: "✅ отправлен", skipped: "— пропущен", failed: "✖️ не отправлен" };

let editing = null; // { index | null, post, words, product, texts: { блок: "варианты построчно" } }
let hint = "";
let log = null, logError = "";
let texts = null;   // черновик текстов ответа: { блок: "варианты построчно" }
let sample = "";    // пример ответа под текстами

/* ---------- Текст ответа: блоки через пустую строку, в каждом — варианты ----------
   Те же стандартные тексты, что в боте (supabase/functions/instagram-bot/index.ts): пустой блок в CRM — бот берёт их. */
const BLOCKS = [
  ["greetingsNamed", "Приветствие с логином", "{name} — логин человека", ["{name}, привет! 👋", "Здравствуйте, {name}!", "{name}, добрый день!", "Привет, {name} 🙌", "{name}, спасибо за интерес!"]],
  ["greetings", "Приветствие без логина", "если логина нет и в части ответов для разнообразия", ["Здравствуйте! 👋", "Привет!", "Добрый день!", "Спасибо за интерес 🙌", "Привет! Рады, что заглянули"]],
  ["about", "Описание", "{product} — название товара; пишите так, чтобы его не нужно было склонять", ["Отправляем ссылку, как и обещали: {product}.", "Вот товар из поста: {product}.", "Товар, о котором вы спрашивали: {product}.", "{product} — со всеми фото и подробностями на сайте.", "Это {product}, все подробности по ссылке ниже."]],
  ["about2", "Описание 2", "", ["В карточке есть все цвета, размеры и наличие.", "Выберите цвет и размер, заказ оформляется за минуту.", "Если сомневаетесь с размером, напишите сюда, подскажем.", "После заказа статус будет приходить сюда, в директ.", "Там же таблица размеров, чтобы не ошибиться."]],
  ["links", "Ссылка", "запасной вариант: обычно ссылка уходит кнопкой «Смотреть и заказать» под фото; {url} нужна в каждом варианте", ["👉 {url}", "Ссылка: {url}", "Смотреть товар: {url}", "{url}"]],
];
const linesOf = (text) => String(text).split("\n").map((x) => x.trim()).filter(Boolean).slice(0, 30);
const savedBlock = (id) => (Array.isArray(state.igReplies?.[id]) && state.igReplies[id].length ? state.igReplies[id] : null);
const draftTexts = () => ({ ...Object.fromEntries(BLOCKS.map(([id, , , standard]) => [id, (savedBlock(id) || standard).join("\n")])),
  greetingMode: state.igReplies?.greetingMode || "mixed" });
const MODES = [["mixed", "Вперемешку: с логином и без"], ["named", "Всегда с логином"], ["plain", "Всегда без логина"]];
/** Какое приветствие возьмёт бот: режим правила (own), иначе общий */
const modeOf = (own) => own?.greetingMode || texts.greetingMode || "mixed";
const greetingBlock = (own) => { const m = modeOf(own); return m === "named" ? "greetingsNamed" : m === "plain" ? "greetings" : Math.random() < 0.6 ? "greetingsNamed" : "greetings"; };
function modeHtml(kind, value) {
  const options = kind === "rule" ? [["", "Как в общем тексте"], ...MODES] : MODES;
  return `<label class="field"><span>Приветствие <small>логин — имя человека в Instagram</small></span><select data-greet-mode="${kind}">
    ${options.map(([v, title]) => `<option value="${v}" ${v === value ? "selected" : ""}>${title}</option>`).join("")}</select></label>`;
}
/** Варианты блока, которые возьмёт бот: свой текст правила (own), иначе общий, иначе стандартный */
const effective = (id, own) => {
  const mine = linesOf(own?.[id] ?? ""), common = linesOf(texts[id]);
  return mine.length ? mine : common.length ? common : BLOCKS.find((b) => b[0] === id)[3];
};
const combos = (own) => {
  const n = (id) => effective(id, own).length;
  const m = modeOf(own), greetings = m === "named" ? n("greetingsNamed") : m === "plain" ? n("greetings") : n("greetingsNamed") + n("greetings");
  return greetings * n("about") * n("about2") * n("links");
};
const htmlLines = (text) => escapeHtml(text).replace(/\n/g, "<br>");

function makeSample(own, name) {
  const pick = (id) => { const all = effective(id, own); return all[Math.floor(Math.random() * all.length)]; };
  const product = name || state.catalogProducts[0]?.name || "Товар";
  return [pick(greetingBlock(own)), pick("about"), pick("about2"), pick("links")].join("\n\n")
    .replaceAll("{name}", "dana.run").replaceAll("{product}", product).replaceAll("{url}", `${location.origin}${location.pathname.replace(/[^/]*$/, "")}?p=1`);
}

function textsHtml() {
  return `<p class="label">Общий текст ответа</p>
    <p class="adm-sub">Ответ собирается из четырёх блоков через пустую строку: приветствие, описание, описание 2 и ссылка.
      В каждом блоке бот случайно берёт один вариант. Пишите каждый вариант с новой строки. Сейчас сочетаний: <b>${combos()}</b>.
      Этот текст бот берёт для правил без своего текста и для блоков, которые в правиле оставили пустыми.
      В директ ответ приходит карточками с фото товара (по одной на цвет): приветствие — заголовок, описание — под ним,
      ссылка — кнопкой «Смотреть и заказать». Описание 2 добавляется, если вместе с описанием влезает в 80 знаков.</p>
    ${modeHtml("common", texts.greetingMode)}
    ${BLOCKS.map(([id, title, help]) => `<label class="field"><span>${title}${help ? ` <small>${help}</small>` : ""}</span>
      <textarea data-bot-text="${id}" rows="6">${escapeHtml(texts[id])}</textarea></label>`).join("")}
    <p class="hint" id="botTextsHint"></p>
    <div class="ord-actions"><button class="primary sm" id="botTextsSave">Сохранить тексты</button><button class="ghost" id="botTextsReset">Вернуть стандартные</button></div>
    <p class="label">Пример ответа</p>
    <div class="ord adm-bot-sample" id="botSample">${htmlLines(sample)}</div>
    <button class="link" id="botSampleNext">Другой пример</button>`;
}

const NO_URL = "В каждом варианте ссылки должно быть {url} — туда бот подставит ссылку на товар";

async function saveTexts(button) {
  const links = linesOf(texts.links);
  if (links.some((l) => !l.includes("{url}"))) {
    $("botTextsHint").textContent = NO_URL;
    return haptic("medium");
  }
  // сохраняем только изменённые блоки: остальные бот берёт стандартные и они обновятся вместе с ботом
  const replies = {};
  for (const [id, , , standard] of BLOCKS) {
    const list = linesOf(texts[id]);
    if (list.length && list.join("\n") !== standard.join("\n")) replies[id] = list;
  }
  if (texts.greetingMode !== "mixed") replies.greetingMode = texts.greetingMode;
  button.disabled = true;
  if (await store(() => api.setIgReplies(replies), "Тексты сохранены")) { texts = draftTexts(); render(); }
  else button.disabled = false;
}

/** Черновик своих текстов правила: { блок: "варианты построчно" }, пустая строка — общий текст */
const ruleTexts = (replies) => ({ ...Object.fromEntries(BLOCKS.map(([id]) => [id, (Array.isArray(replies?.[id]) ? replies[id] : []).join("\n")])),
  greetingMode: replies?.greetingMode || "" });

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
    <p class="adm-sub">Текст ответа: ${r.replies && Object.keys(r.replies).length ? "<b>свой</b>" : "общий"}</p>
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
    <details class="adm-bot-own" ${BLOCKS.some(([id]) => e.texts[id].trim()) ? "open" : ""}>
      <summary>Свой текст ответа для этого правила</summary>
      <p class="adm-sub">Пустой блок — бот возьмёт общий текст (он ниже, под правилами). Каждый вариант с новой строки.
        Сочетаний: <b id="botRuleCombos">${combos(e.texts)}</b>.</p>
      ${modeHtml("rule", e.texts.greetingMode)}
      ${BLOCKS.map(([id, title, help]) => `<label class="field"><span>${title}${help ? ` <small>${help}</small>` : ""}</span>
        <textarea data-rule-text="${id}" rows="4" placeholder="${escapeHtml(effective(id).slice(0, 2).join("\n"))}">${escapeHtml(e.texts[id])}</textarea></label>`).join("")}
      <p class="label">Пример ответа</p>
      <div class="ord adm-bot-sample" id="botRuleSample">${htmlLines(makeSample(e.texts, productOf(e.product)?.name))}</div>
      <button class="link" id="botRuleSampleNext">Другой пример</button>
    </details>
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
    ${api.setIgReplies ? textsHtml() : ""}
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
  if (linesOf(editing.texts.links).some((l) => !l.includes("{url}"))) return fail(NO_URL);
  const list = rules();
  const clash = list.find((r, i) => i !== editing.index && r.post === post && r.words.some((w) => words.includes(w)));
  if (clash) return fail(`Слово «${clash.words.find((w) => words.includes(w))}» ${post ? "под этим постом" : "под любым постом"} уже ведёт на «${productOf(clash.product)?.name ?? "другой товар"}»`);
  const rule = { post, words, product };
  const replies = Object.fromEntries(BLOCKS.map(([id]) => [id, linesOf(editing.texts[id])]).filter(([, list]) => list.length));
  if (editing.texts.greetingMode) replies.greetingMode = editing.texts.greetingMode;
  if (Object.keys(replies).length) rule.replies = replies;
  if (editing.index == null) list.push(rule); else list[editing.index] = rule;
  button.disabled = true;
  if (await store(() => api.setIgRules(list), "Правило сохранено")) { editing = null; hint = ""; render(); }
  else button.disabled = false;
}

async function store(action, done) {
  try {
    await action();
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
  if (t.id === "botAdd") { haptic(); editing = { index: null, post: "", words: "+", product: "", texts: ruleTexts() }; hint = ""; return render(); }
  if (t.id === "botRuleSampleNext") { haptic(); $("botRuleSample").innerHTML = htmlLines(makeSample(editing.texts, productOf($("botProduct").value)?.name)); return; }
  if (t.id === "botCancel") { haptic(); editing = null; return render(); }
  if (t.id === "botSave") return save(t);
  if (t.id === "botTextsSave") return saveTexts(t);
  if (t.id === "botSampleNext") { haptic(); sample = makeSample(); $("botSample").innerHTML = htmlLines(sample); return; }
  if (t.id === "botTextsReset") {
    if (!t.hasAttribute("data-armed")) { t.setAttribute("data-armed", ""); t.textContent = "Точно вернуть?"; return haptic("medium"); }
    texts = { ...Object.fromEntries(BLOCKS.map(([id, , , standard]) => [id, standard.join("\n")])), greetingMode: "mixed" };
    return saveTexts($("botTextsSave"));
  }
  const edit = t.closest("[data-bot-edit]");
  if (edit) {
    const i = Number(edit.dataset.botEdit), r = rules()[i];
    haptic();
    editing = { index: i, post: r.post ? postUrl(r.post) : "", words: r.words.join(", "), product: r.product, texts: ruleTexts(r.replies) };
    hint = "";
    render();
    return $("botPost")?.scrollIntoView({ block: "center" });
  }
  const del = t.closest("[data-bot-del]");
  if (del) {
    if (!del.hasAttribute("data-armed")) { del.setAttribute("data-armed", ""); del.textContent = "Точно удалить?"; return haptic("medium"); }
    del.disabled = true;
    const list = rules().filter((_, i) => i !== Number(del.dataset.botDel));
    if (await store(() => api.setIgRules(list), "Правило удалено")) { editing = null; render(); }
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
  texts = draftTexts();
  sample = makeSample();
  sheetBody.onclick = onClick;
  sheetBody.onchange = (e) => {
    const kind = e.target.dataset.greetMode;
    if (!kind) return;
    if (kind === "rule" && editing) editing.texts.greetingMode = e.target.value;
    else texts.greetingMode = e.target.value;
    if (kind === "common") sample = makeSample();
    render();
  };
  sheetBody.oninput = (e) => {
    const own = e.target.dataset.ruleText;
    if (own && editing) {
      editing.texts[own] = e.target.value;
      $("botRuleCombos").textContent = combos(editing.texts);
      return;
    }
    const id = e.target.dataset.botText;
    if (!id) return;
    texts[id] = e.target.value;
    $("botTextsHint").textContent = "";
  };
  openSheet("chatbot");
  render();
  loadLog();
}

export function initChatbot() {
  $("adminChatbotButton").onclick = () => { haptic(); openChatbot(); };
}
