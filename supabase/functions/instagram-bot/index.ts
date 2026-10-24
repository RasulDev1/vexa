// VEXA · бот магазина в директе Instagram (Supabase Edge Function «instagram-bot»).
// Тот же магазин, что в Telegram: покупатель получает личную ссылку на сайт, заказывает, видит «Мои заказы»
// и получает статусы заказа в директ. Заказы — в той же базе и той же CRM (supabase-instagram.sql).
// Чатов по заказам в директе нет: обычные сообщения бот не трогает, менеджер отвечает на них в приложении Instagram.
// Заказ по ссылке из шапки профиля (supabase-instagram-bio.sql): после заказа сайт даёт кнопку в директ с кодом
// (ig.me/m/магазин?ref=код). Код приходит боту — он привязывает заказ к аккаунту и пишет «Заказ оформлен».
// В Meta → Webhooks должно быть включено поле messaging_referral (вместе с messages и messaging_postbacks).
//
// Секреты функции (Edge Functions → Secrets):
//   IG_APP_ID       — Instagram app ID (App Dashboard → Instagram → API setup with Instagram login)
//   IG_APP_SECRET   — Instagram app secret там же: им Instagram подписывает каждое уведомление
//   IG_ACCESS_TOKEN — необязательно: токен аккаунта (Generate token). Без него аккаунт подключают по ссылке
//                     Embed URL (Business login settings), и функция сама получает и продлевает токен (ig_settings).
//   IG_VERIFY_TOKEN — любая длинная строка из латинских букв и цифр; её же вписываете в настройке Webhooks
//   SHOP_URL        — адрес магазина (необязательно)
// SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY Supabase подставляет сам.
// Verify JWT у функции выключите: Instagram присылает запросы без ключа Supabase.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { encodeHex } from "jsr:@std/encoding@1/hex";

const ENV_TOKEN = Deno.env.get("IG_ACCESS_TOKEN") ?? "";
const APP_ID = Deno.env.get("IG_APP_ID") ?? "";
const APP_SECRET = Deno.env.get("IG_APP_SECRET") ?? "";
const VERIFY_TOKEN = Deno.env.get("IG_VERIFY_TOKEN") ?? "";
const SHOP_URL = Deno.env.get("SHOP_URL") ?? "https://rasuldev1.github.io/vexa/";
const GRAPH = "https://graph.instagram.com/v23.0";
const MAX_TEXT = 1000;            // Instagram не принимает сообщения длиннее

// Подсказка в логах, если забыли добавить секреты
if (!APP_SECRET) console.error("Нет секрета IG_APP_SECRET: Edge Functions → Secrets");
if (!VERIFY_TOKEN) console.error("Нет секрета IG_VERIFY_TOKEN: Edge Functions → Secrets");

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

// deno-lint-ignore no-explicit-any
type Json = any;

/* ---------- Токен аккаунта ----------
   Из секрета IG_ACCESS_TOKEN, а если его нет — полученный по ссылке подключения (ig_settings).
   Такой токен живёт 60 дней: функция продлевает его сама, когда до конца остаётся меньше 20 дней. */
const REDIRECT_URL = `${Deno.env.get("SUPABASE_URL")}/functions/v1/instagram-bot`;
let saved: { token: string; expires: number } | null = null;

async function token(): Promise<string> {
  if (ENV_TOKEN) return ENV_TOKEN;
  if (!saved) {
    const { data } = await db.from("ig_settings").select("access_token,token_expires_at").eq("id", 1).maybeSingle();
    if (!data?.access_token) {
      console.error("Аккаунт Instagram не подключён: откройте ссылку подключения (Embed URL) или задайте секрет IG_ACCESS_TOKEN");
      return "";
    }
    saved = { token: data.access_token, expires: Date.parse(data.token_expires_at ?? "") || 0 };
  }
  if (saved.expires && saved.expires - Date.now() < 20 * 86_400_000) {
    const fresh = await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(saved.token)}`)
      .then((r) => r.json()).catch(() => null);
    if (fresh?.access_token) await saveToken(fresh.access_token, fresh.expires_in);
    else console.error("Токен Instagram не продлился:", fresh?.error?.message);
  }
  return saved.token;
}

async function saveToken(accessToken: string, expiresIn: number) {
  const expires = Date.now() + (Number(expiresIn) || 60 * 86_400) * 1000;
  const { error } = await db.from("ig_settings")
    .update({ access_token: accessToken, token_expires_at: new Date(expires).toISOString() }).eq("id", 1);
  if (error) throw error;
  saved = { token: accessToken, expires };
}

/** Instagram вернул на функцию после «Разрешить» по ссылке подключения: меняем код на токен на 60 дней */
async function connect(url: URL): Promise<Response> {
  // Supabase отдаёт HTML из функций как простой текст, поэтому итог показывает страница магазина ig-connected.html
  const page = (text: string, _status = 200) => {
    const target = new URL("ig-connected.html", SHOP_URL.endsWith("/") ? SHOP_URL : SHOP_URL + "/");
    target.searchParams.set("msg", text);
    return Response.redirect(target.toString(), 303);
  };
  if (url.searchParams.get("error")) return page(`Instagram не дал доступ: ${url.searchParams.get("error_description") ?? url.searchParams.get("error")}`, 400);
  // ссылку подключения дополняют &state=IG_VERIFY_TOKEN — так чужой аккаунт не подменит магазин
  if (!VERIFY_TOKEN || (url.searchParams.get("state") ?? "").trim().replaceAll(" ", "+") !== VERIFY_TOKEN) return page("Ссылка подключения неверная: в конце ссылки должно быть &state= и ваш IG_VERIFY_TOKEN.", 403);
  if (!APP_ID || !APP_SECRET) return page("В Supabase не заданы секреты IG_APP_ID и IG_APP_SECRET.", 500);
  const form = new URLSearchParams({ client_id: APP_ID, client_secret: APP_SECRET, grant_type: "authorization_code",
    redirect_uri: REDIRECT_URL, code: (url.searchParams.get("code") ?? "").replace(/#_$/, "") });
  const short = await fetch("https://api.instagram.com/oauth/access_token", { method: "POST", body: form })
    .then((r) => r.json()).catch(() => null);
  if (!short?.access_token) {
    console.error("Instagram code → token:", short);
    return page(`Не получилось подключить: ${short?.error_message ?? short?.error?.message ?? "Instagram не ответил"}. Откройте ссылку подключения ещё раз.`, 502);
  }
  const long = await fetch(`https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${encodeURIComponent(APP_SECRET)}&access_token=${encodeURIComponent(short.access_token)}`)
    .then((r) => r.json()).catch(() => null);
  if (!long?.access_token) console.error("Instagram long-lived token:", long);
  const accessToken = long?.access_token ?? short.access_token;
  await saveToken(accessToken, long?.access_token ? long.expires_in : 3600);
  // подписываем аккаунт на сообщения: без этого Instagram не присылает боту директ (переключатель в панели Meta не нужен)
  const sub = await fetch(`${GRAPH}/me/subscribed_apps?subscribed_fields=messages,messaging_postbacks,messaging_referral`,
    { method: "POST", headers: { Authorization: `Bearer ${accessToken}` } }).then((r) => r.json()).catch(() => null);
  if (!sub?.success) {
    console.error("Instagram subscribed_apps:", sub);
    return page(`Аккаунт подключён, но Instagram не подписал его на сообщения: ${sub?.error?.message ?? "нет ответа"}. Настройте веб-хуки в приложении Meta и откройте ссылку подключения ещё раз.`, 502);
  }
  await setMenu(accessToken);
  return page("✅ Готово: аккаунт Instagram подключён к магазину и получает сообщения. Это окно можно закрыть.");
}

/** Постоянное меню директа (кнопка ☰ у поля ввода) — «📦 Мои заказы».
    Не получилось — бот работает и без него: те же кнопки приходят под сообщениями. */
async function setMenu(accessToken: string) {
  const result = await fetch(`${GRAPH}/me/messenger_profile`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ platform: "instagram", persistent_menu: [{ locale: "default", call_to_actions: [
      { type: "postback", title: "📦 Мои заказы", payload: "ORDERS" },
    ] }] }),
  }).then((r) => r.json()).catch(() => null);
  if (!result?.result) console.error("Instagram persistent menu:", result?.error?.message ?? result);
  else console.log("Меню Instagram (☰) установлено");
  await setIceBreakers(accessToken);
}

/** Быстрые вопросы в пустом директе (Ice Breakers). Без них Instagram не передаёт боту код из ссылки ig.me?ref=…
    в новом диалоге: покупатель с сайта нажимает «📦 Мои заказы» — и код приходит вместе с нажатием. */
async function setIceBreakers(accessToken: string) {
  const result = await fetch(`${GRAPH}/me/messenger_profile`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ platform: "instagram", ice_breakers: [{ locale: "default", call_to_actions: [
      { question: "📦 Мои заказы", payload: "ORDERS" },
    ] }] }),
  }).then((r) => r.json()).catch(() => null);
  if (!result?.result) console.error("Instagram ice breakers:", result?.error?.message ?? result);
  else console.log("Быстрые вопросы Instagram установлены");
}

/** Проверка меню: читаем его у Instagram и, если его нет, ставим заново. Раз за запуск функции, пишем итог в логи */
let menuChecked = false;
async function checkMenu() {
  if (menuChecked) return;
  menuChecked = true;
  const accessToken = await token();
  if (!accessToken) return;
  // подписка аккаунта на события: аккаунты, подключённые раньше, не получали messaging_referral (код из ссылки ig.me)
  const sub = await fetch(`${GRAPH}/me/subscribed_apps?subscribed_fields=messages,messaging_postbacks,messaging_referral`,
    { method: "POST", headers: { Authorization: `Bearer ${accessToken}` } }).then((r) => r.json()).catch(() => null);
  if (!sub?.success) console.error("Instagram subscribed_apps:", sub?.error?.message ?? sub);
  const result = await fetch(`${GRAPH}/me/messenger_profile?platform=instagram&fields=persistent_menu,ice_breakers`,
    { headers: { Authorization: `Bearer ${accessToken}` } }).then((r) => r.json()).catch(() => null);
  const items = result?.data?.[0]?.persistent_menu?.[0]?.call_to_actions;
  const hasShop = JSON.stringify(result?.data ?? []).includes('"SHOP"'); // кнопка магазина из прежней версии бота — убираем
  if (items?.length && !hasShop) {
    console.log(`Меню Instagram (☰) на месте: ${items.map((i: Json) => i.title).join(", ")}`);
    if (!result.data.some((d: Json) => d.ice_breakers?.length)) await setIceBreakers(accessToken);
    return;
  }
  console.error("Меню Instagram (☰) не найдено у Instagram, ставлю заново:", result?.error?.message ?? "пусто");
  await setMenu(accessToken);
}

async function ig(body: Json): Promise<Json> {
  const t0 = Date.now();
  const bearer = `Bearer ${await token()}`;
  const t1 = Date.now();
  const response = await fetch(`${GRAPH}/me/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: bearer },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  console.log(`  шаг: Instagram ${body.sender_action ? "«печатает»" : "сообщение"} ${Date.now() - t1} мс (токен ${t1 - t0} мс)`);
  // Ошибки Instagram — в логи функции. Код 10 / 2534022 — прошло больше 24 часов с последнего сообщения покупателя:
  // Instagram разрешает писать первым только в течение суток после его сообщения.
  if (!response.ok || result?.error) console.error("Instagram send:", result?.error?.code, result?.error?.error_subcode, result?.error?.message);
  return result;
}
const sent = (result: Json) => Boolean(result?.message_id);
/** «Печатает…» в директе сразу, пока бот собирает ответ: покупатель видит, что бот уже отвечает */
const typing = (to: string) => ig({ recipient: { id: to }, sender_action: "typing_on" }).catch(() => null);
/** «Прочитано» — сразу, как только бот получил команду */
const markSeen = (to: string) => ig({ recipient: { id: to }, sender_action: "mark_seen" }).catch(() => null);

/** Текст; длинный — несколькими сообщениями. Кнопки быстрого ответа — под последним. */
async function say(to: string, text: string, quick?: Json[]) {
  const parts: string[] = [];
  for (let rest = text; rest; ) {
    const nl = rest.lastIndexOf("\n", MAX_TEXT);
    const cut = rest.length <= MAX_TEXT ? rest.length : nl > MAX_TEXT / 2 ? nl : MAX_TEXT;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  let result: Json = null;
  for (const [i, part] of parts.entries()) {
    const last = i === parts.length - 1;
    result = await ig({ recipient: { id: to }, message: { text: part, ...(last && quick ? { quick_replies: quick } : {}) } });
  }
  return result;
}

/* Кнопки быстрого ответа под сообщением. Нажатие присылает боту payload — менеджеру не уходит.
   Подпись кнопки — не длиннее 20 символов. */
const quick = (title: string, payload: string) => ({ content_type: "text", title: title.slice(0, 20), payload });
const Q_ORDERS = quick("📦 Мои заказы", "ORDERS");

/* ---------- Покупатель ----------
   В базе — под отрицательным ID (ig_users): так все заказы, чат и CRM работают как с Telegram ID. */
const known = new Map<string, number>(); // igsid → ID покупателя, пока функция «тёплая»: без лишнего запроса к базе
const background: Promise<unknown>[] = []; // запись, которую не нужно ждать перед ответом покупателю

async function customer(igsid: string): Promise<{ id: number; isNew: boolean }> {
  let id = known.get(igsid);
  if (id === undefined) {
    const { data } = await db.from("ig_users").select("user_id").eq("igsid", igsid).maybeSingle();
    if (data) known.set(igsid, id = Number(data.user_id));
  }
  if (id !== undefined) {
    background.push(db.from("ig_users").update({ last_message_at: new Date().toISOString() }).eq("user_id", id).then());
    return { id, isNew: false };
  }
  // имя и логин — для CRM; не получилось — покупатель всё равно заводится
  const profile = await fetch(`${GRAPH}/${igsid}?fields=name,username`, { headers: { Authorization: `Bearer ${await token()}` } })
    .then((r) => r.json()).catch(() => ({}));
  if (profile?.error) console.error("Instagram profile:", profile.error.code, profile.error.message);
  const { data, error } = await db.from("ig_users").upsert({
    igsid, username: profile?.username ?? null, name: profile?.name ?? null, last_message_at: new Date().toISOString(),
  }, { onConflict: "igsid" }).select("user_id").single();
  if (error) throw error;
  known.set(igsid, Number(data.user_id));
  return { id: Number(data.user_id), isNew: true };
}

async function igsidOf(userId: number): Promise<string | null> {
  for (const [igsid, id] of known) if (id === userId) return igsid;
  const { data } = await db.from("ig_users").select("igsid").eq("user_id", userId).maybeSingle();
  if (data?.igsid) known.set(data.igsid, userId);
  return data?.igsid ?? null;
}

/** Статус заказа — так, как его поймёт покупатель */
const STATUS: Record<string, string> = {
  new: "🕐 Проверяем наличие", awaiting_payment: "💳 Ждём оплату", paid: "✅ Оплачен, готовим заказ",
  delivered: "📦 Вручён", cancelled: "✖️ Отменён",
};
const rub = (n: number) => `${Math.round(Number(n) || 0).toLocaleString("ru-RU")} ₽`;
/** «3 октября» — дата оформления по времени магазина (Краснодар) */
const day = (iso: string) => new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "long", timeZone: "Europe/Moscow" });
const shortDay = (iso: string) => new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "short", timeZone: "Europe/Moscow" }).replace(".", "");
const itemsOf = (o: Json): Json[] => (Array.isArray(o.items) ? o.items : []);

/** Ссылка на оплату картой онлайн (функция online-pay), которую CRM кладёт в реквизиты */
const ONLINE_PAY = /\/functions\/v1\/online-pay\?order=\d+&sig=[0-9a-f]+/;
const ACTIVE = ["new", "awaiting_payment", "paid"];
const OPEN = ["awaiting_payment", "paid"]; // заказ подтверждён: вопросы по нему — менеджеру прямо в директе

/** «Мои заказы»: активные заказы списком и кнопкой на каждый — нажал, и бот показывает заказ */
async function sendOrders(to: string, userId: number) {
  const { data: orders, error } = await db.from("orders").select("id,status,total,items,created_at")
    .eq("user_id", userId).in("status", ACTIVE).order("id", { ascending: false }).limit(10);
  if (error) {
    console.error("orders", error);
    return say(to, "Не получилось загрузить заказы 😔 Попробуйте, пожалуйста, ещё раз через минуту.");
  }
  if (!orders?.length) {
    return say(to, "Сейчас у вас нет активных заказов.\n\n" +
      "Только что оформили заказ на сайте? Отправьте сюда номер телефона из заказа — сайт скопировал его, когда вы нажали «Открыть директ VEXA». Бот сразу пришлёт заказ.", [Q_ORDERS]);
  }
  const lines = orders.map((o: Json, i: number) => {
    const items = itemsOf(o);
    const what = String(items[0]?.name ?? "Заказ") + (items.length > 1 ? ` и ещё ${items.length - 1}` : "");
    return `${i + 1}. ${day(o.created_at)} · ${what} · ${rub(o.total)}\n${STATUS[o.status] ?? ""}`;
  });
  return say(to, `${orders.length === 1 ? "Ваш заказ" : "Ваши заказы"} 👇 Нажмите на нужный, чтобы посмотреть детали.\n\n${lines.join("\n\n")}`,
    [...orders.map((o: Json, i: number) => quick(`${i + 1}. ${shortDay(o.created_at)} · ${rub(o.total)}`, `ORDER:${o.id}`))]);
}

/* ---------- Фото заказанных товаров ----------
   Как в Telegram-боте: ссылку на фото сайт кладёт в заказ (items[].photo). У заказов, оформленных раньше
   или со старой версии сайта, её нет — тогда ищем фото в каталоге: встроенные товары в js/data.js на сайте,
   добавленные — в catalog_state. */
const absolute = (path: string) => { try { return new URL(path, SHOP_URL).href; } catch { return ""; } };
const PHOTO_EXPR = String.raw`(?:img\("([^"]+)"\)|"([^"]+)")`; // img("2") или "1-pants.jpg"
const photoPath = (m: RegExpMatchArray, i: number) => (m[i] ? `img/products/${m[i]}.jpg` : m[i + 1]);

let catalogPhotos: { at: number; map: Map<string, string> } | null = null;
/** "id|#ЦВЕТ" и "id" → полная ссылка на фото. Кэш на 10 минут. */
async function loadCatalogPhotos() {
  if (catalogPhotos && Date.now() - catalogPhotos.at < 600_000) return catalogPhotos.map;
  const map = new Map<string, string>();
  try {
    const source = await (await fetch(absolute("js/data.js"))).text();
    for (const block of source.split(/(?=\{\s*id:\s*\d+,)/).slice(1)) {
      const id = /^\{\s*id:\s*(\d+)/.exec(block)?.[1];
      const main = new RegExp(String.raw`\bphoto:\s*` + PHOTO_EXPR).exec(block);
      if (!id || !main) continue;
      map.set(id, absolute(photoPath(main, 1)));
      const colors = /colorPhotos:\s*\{([^}]*)\}/.exec(block)?.[1] ?? "";
      for (const c of colors.matchAll(new RegExp(String.raw`"(#[0-9A-Fa-f]{6})":\s*` + PHOTO_EXPR, "g")))
        map.set(`${id}|${c[1].toUpperCase()}`, absolute(photoPath(c, 2)));
    }
  } catch (e) { console.error("Фото встроенных товаров (js/data.js):", e); }
  try {
    const { data } = await db.from("catalog_state").select("data").eq("id", 1).maybeSingle();
    for (const p of (data?.data?.products ?? []) as Json[]) {
      const colors = (Array.isArray(p.colors) ? p.colors : []).filter((c: Json) => c?.hex && c?.image);
      if (!p.num || !colors.length) continue;
      map.set(String(p.num), absolute(colors[0].image));
      for (const c of colors) map.set(`${p.num}|${String(c.hex).toUpperCase()}`, absolute(c.image));
    }
  } catch (e) { console.error("Фото добавленных товаров (catalog_state):", e); }
  catalogPhotos = { at: Date.now(), map };
  return map;
}

async function photoUrls(items: Json[]) {
  const catalog = items.some((l) => !String(l.photo ?? "").startsWith("https://")) ? await loadCatalogPhotos() : null;
  const urls = items.map((l) => {
    if (typeof l.photo === "string" && l.photo.startsWith("https://")) return l.photo;
    return catalog?.get(`${l.id}|${String(l.color ?? "").toUpperCase()}`) ?? catalog?.get(String(l.id)) ?? "";
  });
  return [...new Set(urls.filter((u) => u.startsWith("https://")).map(lightPhoto))].slice(0, 4);
}

/** Фото встроенных товаров у сайта есть и в лёгком виде (img/products/6-thumb.jpg, ~25 КБ вместо ~90): в чате хватает,
    а Instagram скачивает такой файл заметно быстрее. Чужие ссылки (добавленные товары) оставляем как есть. */
const lightPhoto = (url: string) => url.replace(/(\/img\/products\/[\w-]+?)(?<!-thumb)\.jpg(?=$|\?)/, "$1-thumb.jpg");

/** Фото отправляем одновременно, а не по очереди: Instagram сам скачивает каждое, и так заметно быстрее */
async function sendPhotos(to: string, items: Json[]) {
  const urls = await photoUrls(items);
  await Promise.all(urls.map((url) => ig({ recipient: { id: to }, message: { attachment: { type: "image", payload: { url } } } })));
}

/** Покупатель нажал на заказ: фото, дата, состав, статус.
    accepted — менеджер только что принял заказ и отправил реквизиты: бот открывает заказ сам. */
async function chooseOrder(to: string, userId: number, orderId: number, accepted = false) {
  const { data: o } = await db.from("orders")
    .select("id,status,total,items,payment_details,manager_note,created_at")
    .eq("id", orderId).eq("user_id", userId).maybeSingle();
  if (!o || !ACTIVE.includes(o.status)) return say(to, "Этот заказ уже завершён. Нажмите «📦 Мои заказы», чтобы увидеть актуальные.", [Q_ORDERS]);
  const items = itemsOf(o);
  await sendPhotos(to, items);
  const lines = items.map((l) => `• ${l.name} — ${String(l.colorName ?? "").toLowerCase()}, размер ${l.size}${Number(l.qty) > 1 ? `, ${l.qty} шт.` : ""}`);
  let text = `${accepted ? "✅ Заказ принят! " : "🛍 "}Ваш заказ от ${day(o.created_at)}\n\n${lines.join("\n")}\n\nСумма: ${rub(o.total)}\nСтатус: ${STATUS[o.status] ?? o.status}`;
  if (o.status === "awaiting_payment" && o.payment_details) {
    if (ONLINE_PAY.test(o.payment_details)) {
      // оплата картой онлайн: заказ отмечается оплаченным сам, чек не нужен
      text += `\n\n💳 Оплатить картой онлайн:\n${o.payment_details}\n\nКак только оплата пройдёт, статус заказа обновится сам, чек присылать не нужно.`;
    } else {
      text += `\n\n💳 Реквизиты для оплаты:\n${o.payment_details}`;
      if (o.manager_note) text += `\n\n${o.manager_note}`;
      text += "\n\nПосле оплаты пришлите сюда, пожалуйста, чек — фото или скриншот.";
    }
  }
  if (OPEN.includes(o.status)) {
    text += "\n\n✍️ Есть вопрос? Просто напишите сюда — ответит менеджер.";
    return say(to, text, [Q_ORDERS]);
  }
  text += "\n\nМенеджер проверяет, всё ли есть в наличии. Как только заказ будет подтверждён, реквизиты для оплаты придут сюда.";
  return say(to, text, [Q_ORDERS]);
}

// «/start», «старт», «начать» — как /start в Telegram: заново показывают приветствие
/* ---------- Покупатель с сайта подключает директ ----------
   Заказал по ссылке из шапки профиля (supabase-instagram-bio.sql) и нажал на сайте «Открыть директ VEXA»:
   код приходит в ссылке ig.me/m/магазин?ref=код или текстом. По коду база привязывает его заказы к этому аккаунту. */
const LINK_CODE = /\bVX[0-9A-F]{8}\b/i;

/** Код из ссылки не дошёл (веб-версия Instagram): покупатель присылает телефон из заказа — сайт скопировал его по кнопке */
const PHONE = /^\+?[\d\s()-]{10,20}$/;

async function bind(igsid: string, code: string, by: "code" | "phone" = "code"): Promise<Json> {
  // имя и логин — для CRM, если этого покупателя бот ещё не знает
  const profile = known.has(igsid) ? {} : await fetch(`${GRAPH}/${igsid}?fields=name,username`,
    { headers: { Authorization: `Bearer ${await token()}` } }).then((r) => r.json()).catch(() => ({}));
  const rpc = by === "phone" ? "ig_bind_phone" : "ig_bind";
  const { data, error } = await db.rpc(rpc, {
    [by === "phone" ? "p_phone" : "p_code"]: code, p_igsid: igsid, p_username: profile?.username ?? null, p_name: profile?.name ?? null,
  });
  if (error) { console.error(rpc, error); return null; }
  if (data?.user_id) known.set(igsid, Number(data.user_id));
  return data;
}

/** Директ подключён: «заказ оформлен» и сам заказ — с реквизитами, если он уже принят */
async function linked(to: string, userId: number) {
  const { data: o } = await db.from("orders").select("id").eq("user_id", userId).in("status", ACTIVE)
    .order("id", { ascending: false }).limit(1).maybeSingle();
  if (!o) {
    return say(to, "Готово! Директ подключён: статусы ваших заказов будут приходить сюда.\n\n" +
      "📦 «Мои заказы» — статус заказа, реквизиты для оплаты и связь с менеджером.", [Q_ORDERS]);
  }
  await say(to, "✅ Заказ оформлен! Статус, реквизиты для оплаты и сообщения менеджера будут приходить сюда, в директ.");
  return chooseOrder(to, userId, o.id);
}

const ORDER_WORDS = /^(📦\s*)?мои заказы/i;

/** Сообщение покупателя в директе */
async function handle(igsid: string, m: Json) {
  const payload: string = m.quick_reply?.payload ?? m.payload ?? "";
  const text: string = String(m.text ?? "").trim();
  // команда боту — сразу «печатает…»; обычное сообщение может читать менеджер, там бот молчит
  const code = LINK_CODE.exec(String(m.ref ?? ""))?.[0] ?? LINK_CODE.exec(text)?.[0];
  const phone = !code && !payload && PHONE.test(text) && text.replace(/\D/g, "").length >= 10 ? text : "";
  if (payload || code || phone || ORDER_WORDS.test(text)) { markSeen(igsid); typing(igsid); }
  if (phone) {
    const bound = await bind(igsid, phone, "phone");
    if (bound?.user_id) return linked(igsid, Number(bound.user_id));
    if (bound?.error === "busy") return say(igsid, "Слишком много попыток. Попробуйте через час или напишите сюда, менеджер поможет.");
    if (bound?.error === "no_order") return say(igsid, "Не нашёл заказ с этим номером за последние 2 дня 🤔 Проверьте, что номер тот же, что вы указали при оформлении на сайте.", [Q_ORDERS]);
  }
  if (code) {
    const bound = await bind(igsid, code);
    if (bound?.user_id) return linked(igsid, Number(bound.user_id));
    // код набран руками и не подошёл — подскажем; неподходящий код из ссылки молча пропускаем
    if (!m.ref && bound?.error) return say(igsid, "Этот код не подошёл 🤔 Откройте директ кнопкой «Открыть директ VEXA» на сайте после заказа или проверьте код во вкладке «Мои заказы».");
  }
  if (m.ref !== undefined && !text && !payload) return; // покупатель только открыл диалог по ссылке
  const tc = Date.now();
  const me = await customer(igsid);
  console.log(`  шаг: покупатель ${Date.now() - tc} мс`);

  if (payload === "ORDERS" || ORDER_WORDS.test(text)) return sendOrders(igsid, me.id);
  const orderId = Number(/^ORDER:(\d+)$/.exec(payload)?.[1]);
  if (orderId) return chooseOrder(igsid, me.id, orderId);
  if (payload === "CLOSE") return sendOrders(igsid, me.id); // кнопка «Закрыть чат» из старых сообщений
  if (payload === "SHOP") return sendOrders(igsid, me.id); // кнопка «🛍 Магазин» из прежних сообщений

  // Первое сообщение от нового человека: он мог прийти по кнопке с сайта, но Instagram не передал код (веб-версия,
  // директ без кнопок) — подсказываем, как получить заказ. Дальше — обычная переписка: её читает менеджер, бот молчит
  if (me.isNew) return say(igsid, "Здравствуйте! Чтобы получить заказ с сайта, отправьте сюда номер телефона, который указали при оформлении. Он уже скопирован при нажатии кнопки «Открыть директ VEXA», просто вставьте. Бот сразу пришлёт заказ.", [Q_ORDERS]);
}

/* ---------- Вызовы из базы (supabase-instagram.sql) ---------- */

/** Менеджер написал в чате заказа */
async function managerMessage(messageId: number) {
  const { data: m } = await db.from("order_messages").select("order_id,body,file_name").eq("id", messageId).maybeSingle();
  if (!m) return;
  const { data: o } = await db.from("orders").select("user_id,created_at").eq("id", m.order_id).maybeSingle();
  const to = o?.user_id < 0 ? await igsidOf(o.user_id) : null;
  if (!to) return;
  const text = `💬 Менеджер VEXA · заказ от ${day(o.created_at)}` +
    (m.body ? `\n\n${m.body}` : "") +
    (m.file_name ? `\n\n📎 Менеджер прислал файл «${m.file_name}» — его можно открыть в магазине, в чате заказа.` : "") +
    "\n\nОтветить можно прямо здесь.";
  await say(to, text, [Q_ORDERS]);
}

const WAY: Record<string, string> = { cash: " наличными", card: " на карту" };

/** Заказ сменил статус: принят (реквизиты), отказ, оплата, вручение, возврат */
async function orderStatus(orderId: number, from: string) {
  const { data: o } = await db.from("orders").select("*").eq("id", orderId).maybeSingle();
  const to = o?.user_id < 0 ? await igsidOf(o.user_id) : null;
  if (!to) return;
  const head = `💬 Менеджер VEXA · заказ от ${day(o.created_at)}\n\n`;
  if (from === "new" && o.status === "awaiting_payment") return chooseOrder(to, o.user_id, o.id, true);
  if (o.status === "cancelled") return say(to, head + (o.manager_note || "К сожалению, заказ отменён."), [Q_ORDERS]);
  if (o.status === "paid") return say(to, `✅ Оплата ${rub(o.paid_amount ?? o.total)} получена. Готовим заказ, менеджер напишет вам о доставке.`, [Q_ORDERS]);
  if (o.status === "delivered" && ["return_requested", "return_approved"].includes(from)) {
    return say(to, head + `По заказу отказано в возврате: ${o.return_declined ?? ""}`, [Q_ORDERS]);
  }
  if (o.status === "delivered") return say(to, "📦 Заказ вручён. Спасибо за покупку!", [Q_ORDERS]);
  if (o.status === "return_approved") {
    return say(to, head + `Возврат одобрен. Привезите или отправьте вещь с бирками, и мы вернём ${rub(o.return_amount)}${WAY[o.return_method] ?? ""}.`, [Q_ORDERS]);
  }
  if (o.status === "returned") return say(to, head + `Возврат вручён: вещь получили, вернули вам ${rub(o.refund_amount)}${WAY[o.refund_method] ?? ""}.`, [Q_ORDERS]);
}

/** Запрос от базы подписан секретом из ig_settings — его знают только база и эта функция */
async function fromDatabase(request: Request, secret: string) {
  const { data } = await db.from("ig_settings").select("hook_secret").eq("id", 1).maybeSingle();
  if (!data?.hook_secret || data.hook_secret !== secret) return new Response("forbidden", { status: 403 });
  const body = await request.json().catch(() => null);
  token().catch(() => {}); // «будильник» заодно прогревает токен
  checkMenu().catch((e) => console.error("Проверка меню:", e));
  // сообщения отправляем уже после ответа базе — она не ждёт дольше нескольких секунд
  const work = (body?.message ? managerMessage(Number(body.message))
    : body?.order ? orderStatus(Number(body.order), String(body.from ?? "")) : Promise.resolve())
    .catch((e) => console.error(e));
  await later(work);
  return new Response("ok");
}

token().catch(() => {}); // прогрев токена при запуске, чтобы первое сообщение не ждало базу

/** Работа после ответа: Edge Runtime доделает её сам; без него — ждём здесь */
async function later(work: Promise<unknown>) {
  const runtime = (globalThis as Json).EdgeRuntime;
  if (runtime?.waitUntil) runtime.waitUntil(work); else await work;
}

/** Подпись уведомления Instagram: HMAC-SHA256 тела секретом приложения */
async function signed(raw: string, header: string) {
  if (!APP_SECRET || !header.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(APP_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = encodeHex(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw))));
  return mac === header.slice(7);
}

Deno.serve(async (request) => {
  const url = new URL(request.url);
  // Проверка адреса при настройке Webhooks в Meta
  if (request.method === "GET") {
    if (url.searchParams.has("code") || url.searchParams.has("error")) return connect(url);
    if (url.searchParams.get("hub.mode") === "subscribe" && VERIFY_TOKEN && url.searchParams.get("hub.verify_token") === VERIFY_TOKEN) {
      return new Response(url.searchParams.get("hub.challenge") ?? "");
    }
    console.error("Проверка Webhooks не прошла: IG_VERIFY_TOKEN в Supabase должен совпадать с Verify token в настройках Meta");
    return new Response("forbidden", { status: 403 });
  }
  const hook = request.headers.get("x-ig-hook");
  if (hook) return fromDatabase(request, hook);

  const raw = await request.text();
  if (!(await signed(raw, request.headers.get("x-hub-signature-256") ?? ""))) {
    console.error("Запрос отклонён: подпись не совпала. IG_APP_SECRET должен быть Instagram app secret вашего приложения");
    return new Response("forbidden", { status: 403 });
  }
  const update = JSON.parse(raw || "{}");
  const events: Json[] = (update.entry ?? []).flatMap((e: Json) => (e.messaging ?? []).map((m: Json) => ({ ...m, account: e.id })));
  const work = (async () => {
    for (const e of events) {
      const igsid = String(e.sender?.id ?? "");
      // своё же сообщение (эхо), прочтение, реакция — пропускаем
      if (!igsid || igsid === String(e.account) || e.message?.is_echo || e.message?.is_deleted) continue;
      // код из ссылки ig.me?ref=…: отдельным событием (диалог открыт), в нажатии быстрого вопроса или в сообщении
      const ref = e.referral?.ref ?? e.postback?.referral?.ref ?? e.message?.referral?.ref;
      const m = e.message ? { ...e.message } : e.postback ? { text: e.postback.title, payload: e.postback.payload }
        : ref ? { text: "" } : null;
      if (!m) continue;
      if (ref) m.ref = String(ref);
      // замеры: сколько Instagram доставлял сообщение до нас (по его метке времени) и сколько бот готовил ответ
      const started = Date.now();
      console.log("Сообщение от", igsid, String(m.text ?? "[файл]").slice(0, 40));
      try { await handle(igsid, m); } catch (err) { console.error(err); }
      console.log(`Время: Instagram доставил за ${e.timestamp ? started - Number(e.timestamp) : "?"} мс, бот ответил за ${Date.now() - started} мс`);
    }
    await Promise.all(background.splice(0));
  })();
  // Instagram ждёт ответа быстро, иначе повторит уведомление — отвечаем сразу, работаем после
  await later(work);
  return new Response("ok");
});
