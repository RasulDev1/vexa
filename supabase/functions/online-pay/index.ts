// VEXA · онлайн-оплата картой через Stripe Checkout (Supabase Edge Function «online-pay»).
// Сначала — тестовые ключи Stripe (sk_test_…): оплата проходит по тестовым картам, деньги не списываются.
// Тестовые ключи Stripe выдаёт сразу после регистрации по почте, ИП и самозанятость не нужны.
//
// Что делает:
//   { action: "link", order_id }   — от менеджера (вход по логину): постоянная ссылка на оплату заказа. CRM сама
//                                    подставляет её в реквизиты при «Принять», бот и «Мои заказы» показывают её покупателю;
//   GET ?order=…&sig=…             — покупатель открыл эту ссылку: функция открывает ему страницу оплаты Stripe;
//   GET ?done=…&sig=…              — Stripe вернул покупателя после оплаты: функция отмечает заказ оплаченным
//                                    и отправляет покупателя в магазин;
//   { action: "create", order_id } — от покупателя: создаёт страницу оплаты на сумму заказа из базы и возвращает ссылку;
//   { action: "check", order_id }  — от покупателя, когда он вернулся со страницы оплаты: спрашивает Stripe и отмечает оплату;
//   событие Stripe checkout.session.completed — перепроверяет оплату в Stripe и отмечает заказ оплаченным.
//   { action: "demo_create", order_id, amount } — демо-сайт (/demo/): тестовая страница оплаты Stripe на сумму
//                                    демо-заказа. Заказы демо живут в браузере, поэтому база не трогается. Только с тестовым ключом;
//   { action: "demo_check", session_id } — демо-сайт после возврата со Stripe: прошла ли тестовая оплата.
// Чей заказ, решает база: функция пересылает ей подпись Telegram покупателя (X-Telegram-Init-Data).
// Событию Stripe функция на слово не верит — сама запрашивает страницу оплаты по её id.
//
// Секреты функции (Edge Functions → Secrets):
//   STRIPE_SECRET_KEY  — секретный ключ Stripe; тестовый начинается с sk_test_
//   PAY_TESTERS        — Telegram ID через запятую: кто может платить, пока ключ тестовый. Без него тестовый
//                        ключ не принимает оплату ни от кого — иначе покупатель «оплатил» бы заказ тестовой картой.
//                        * — тестовую оплату может пройти любой покупатель (демо-магазин)
//   SHOP_URL           — адрес магазина (необязательно)
//   PAY_RETURN_URL     — куда вернуть покупателя после оплаты (необязательно; без неё — в чат бота магазина,
//                        ссылку на бота функция узнаёт по TELEGRAM_BOT_TOKEN, а без токена — на сайт магазина)
//   DEMO_PAY_URL       — страница демо-оплаты, куда Stripe вернёт посетителя демо (необязательно)
//   TELEGRAM_BOT_TOKEN — уже есть у бота; с ним бот напишет покупателю «Оплата получена» (необязательно)
// SUPABASE_URL, SUPABASE_ANON_KEY и SUPABASE_SERVICE_ROLE_KEY Supabase подставляет сам.
// Развернуть без проверки JWT: supabase functions deploy online-pay --no-verify-jwt
import { createClient } from "jsr:@supabase/supabase-js@2";

const SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
const SHOP_URL = Deno.env.get("SHOP_URL") ?? "https://rasuldev1.github.io/vexa/";
const RETURN_URL = Deno.env.get("PAY_RETURN_URL") ?? "";
const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const DEMO_PAY_URL = Deno.env.get("DEMO_PAY_URL") ?? "https://rasuldev1.github.io/vexa/demo/app/pay.html";
const TEST_MODE = /^(sk|rk)_test_/.test(SECRET_KEY);
const TESTERS = (Deno.env.get("PAY_TESTERS") ?? "").split(/[\s,]+/).filter(Boolean);
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const API = "https://api.stripe.com/v1";
const FUNCTION_URL = `${SUPABASE_URL}/functions/v1/online-pay`;

if (!SECRET_KEY) console.error("Нет секрета STRIPE_SECRET_KEY: Edge Functions → Secrets");

const admin = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

// deno-lint-ignore no-explicit-any
type Json = any;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-telegram-init-data, x-staff-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const answer = (body: Json, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

/** Запрос к API Stripe: ключ в Authorization, тело — форма (line_items[0][quantity]=1) */
async function stripe(path: string, form?: Record<string, string>, idempotencyKey?: string): Promise<Json> {
  const response = await fetch(`${API}${path}`, {
    method: form ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${SECRET_KEY}`,
      ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: form ? new URLSearchParams(form) : undefined,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    // 401 — неверный ключ
    console.error(`Stripe ${path}:`, response.status, result?.error?.code, result?.error?.message);
    throw new Error("provider");
  }
  return result;
}

/** Подпись номера заказа в ссылке на оплату — чтобы ссылку нельзя было подобрать перебором номеров */
async function sign(orderId: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`vexa-pay:${orderId}`)));
  return Array.from(mac.slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
}
const payLink = async (orderId: number) => `${FUNCTION_URL}?order=${orderId}&sig=${await sign(orderId)}`;
const doneLink = async (orderId: number) => `${FUNCTION_URL}?done=${orderId}&sig=${await sign(orderId)}`;
/** Ссылка на чат бота магазина: имя бота спрашиваем у Telegram один раз */
let botLink: Promise<string> | null = null;
function botChat(): Promise<string> {
  if (!BOT_TOKEN) return Promise.resolve("");
  botLink ||= fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`).then((r) => r.json())
    .then((r) => (r?.result?.username ? `https://t.me/${r.result.username}` : ""))
    .catch(() => "")
    .then((url) => { if (!url) botLink = null; return url; }); // не вышло — спросим в следующий раз
  return botLink;
}
/** Куда вернуть покупателя после оплаты: PAY_RETURN_URL, чат бота (там его ждёт «Оплата получена») или сайт */
const shopAfter = async (orderId: number) =>
  RETURN_URL || await botChat() || `${SHOP_URL}${SHOP_URL.includes("?") ? "&" : "?"}paid=${orderId}`;

/** Тестовый ключ: платить тестовой картой могут только проверяющие */
const allowed = (userId: unknown) => !TEST_MODE || TESTERS.includes("*") || TESTERS.includes(String(userId));

/** Заказ покупателя, который ждёт оплаты, — проверяет база по его подписи Telegram */
async function customerOrder(req: Request, orderId: number): Promise<Json> {
  const initData = req.headers.get("x-telegram-init-data") ?? "";
  const asCustomer = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false },
    global: { headers: initData ? { "X-Telegram-Init-Data": initData } : {} },
  });
  const { data, error } = await asCustomer.rpc("online_pay_order", { p_id: orderId });
  if (error) {
    const reason = /pay:([a-z_]+)/.exec(error.message || "")?.[1];
    throw { code: reason || (error.code === "PGRST202" ? "no_function" : "server") };
  }
  if (!allowed(data.user_id)) throw { code: "test_only" };
  return data;
}

/** Заказ по номеру, без проверки покупателя (ссылка подписана) — ключом service_role */
async function orderById(orderId: number): Promise<Json> {
  const { data } = await admin.from("orders")
    .select("id,user_id,total,status,online_pay_id,online_pay_url").eq("id", orderId).maybeSingle();
  return data && { ...data, pay_id: data.online_pay_id, pay_url: data.online_pay_url };
}

/** Менеджер вошёл по логину и паролю — проверяет база по токену X-Staff-Token */
async function isStaff(req: Request): Promise<boolean> {
  const token = req.headers.get("x-staff-token") ?? "";
  if (!token) return false;
  const asStaff = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false }, global: { headers: { "X-Staff-Token": token } } });
  const { data } = await asStaff.rpc("staff_me");
  return Boolean(data?.role);
}

/** Оплата прошла → заказ оплачен. Сумму и номер заказа берём из самой страницы оплаты Stripe. */
async function applyPayment(session: Json): Promise<boolean> {
  const orderId = Number(session?.metadata?.order_id);
  if (session?.payment_status !== "paid" || !orderId || session.currency !== "rub") return false;
  const amount = Number(session.amount_total) / 100;
  const { data, error } = await admin.rpc("online_pay_confirm", {
    p_id: orderId, p_pay_id: session.id, p_amount: amount, p_test: !session.livemode,
  });
  if (error) { console.error("online_pay_confirm:", error); throw new Error("db"); }
  if (data) await notifyCustomer(orderId, amount);
  return true;
}

/** Бот пишет покупателю, что оплата получена (если у функции есть токен бота) */
async function notifyCustomer(orderId: number, amount: number) {
  if (!BOT_TOKEN) return;
  const { data } = await admin.from("orders").select("user_id").eq("id", orderId).single();
  if (!data?.user_id) return;
  const rub = `${Math.round(amount).toLocaleString("ru-RU")} ₽`;
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: data.user_id, text: `✅ Оплата ${rub} получена. Готовим заказ, менеджер напишет вам о доставке.` }),
  }).catch(() => {});
}

/** Покупатель нажал «Оплатить картой онлайн» */
async function create(req: Request, orderId: number) {
  return openSession(await customerOrder(req, orderId));
}

/** Страница оплаты заказа: открытую используем снова, иначе создаём новую. { url } или { paid: true } */
async function openSession(order: Json): Promise<Json> {
  const orderId = Number(order.id);
  if (order.pay_id && order.pay_url) {
    const old = await stripe(`/checkout/sessions/${order.pay_id}`);
    if (await applyPayment(old)) return { paid: true };
    if (old.status === "open" && old.url) return { url: old.url };
  }
  const kopecks = Math.round(Number(order.total) * 100);
  if (!(kopecks >= 50)) throw { code: "bad_amount" };
  const session = await stripe("/checkout/sessions", {
    mode: "payment",
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "rub",
    "line_items[0][price_data][unit_amount]": String(kopecks),
    "line_items[0][price_data][product_data][name]": `Заказ VEXA №${orderId}`,
    "metadata[order_id]": String(orderId),
    client_reference_id: String(orderId),
    locale: "auto",
    // тестовый ключ принимает только тестовые карты Stripe — подсказка прямо над кнопкой оплаты
    ...(TEST_MODE ? { "custom_text[submit][message]": TEST_CARD_HINT } : {}),
    success_url: await doneLink(orderId), // функция отметит оплату и вернёт покупателя в магазин
    cancel_url: RETURN_URL || await botChat() || SHOP_URL,
  }, crypto.randomUUID());
  if (!session.url) throw { code: "server" };
  await admin.rpc("online_pay_start", { p_id: orderId, p_pay_id: session.id, p_url: session.url, p_test: !session.livemode });
  return { url: session.url };
}

/** Покупатель вернулся со страницы оплаты — не ждём события Stripe, спрашиваем сами */
async function check(req: Request, orderId: number) {
  let order: Json;
  try { order = await customerOrder(req, orderId); } catch (e) {
    if ((e as Json)?.code === "not_awaiting") return { paid: false, closed: true }; // уже оплачен или отменён — сайт перечитает заказ
    throw e;
  }
  if (!order.pay_id) return { paid: false };
  const session = await stripe(`/checkout/sessions/${order.pay_id}`);
  return { paid: await applyPayment(session), status: session.status };
}

/* ---------- Демо-сайт: настоящая тестовая страница Stripe для заказа, который хранится в браузере ---------- */
const TEST_CARD_HINT = "Тестовый магазин, деньги не списываются. Оплатить можно только тестовой картой 4242 4242 4242 4242: срок любой в будущем, CVC любые 3 цифры. Настоящие карты не принимаются.";

/** Сумму присылает сам демо-сайт: заказа в базе нет. С боевым ключом не работает — деньги списались бы по-настоящему. */
async function demoCreate(orderId: number, amount: number) {
  if (!TEST_MODE) throw { code: "test_only" };
  const kopecks = Math.round(amount * 100);
  if (!(kopecks >= 5000 && kopecks <= 100_000_000)) throw { code: "bad_amount" }; // 50 ₽ … 1 000 000 ₽
  const back = `${DEMO_PAY_URL}?order=${orderId}`;
  const session = await stripe("/checkout/sessions", {
    mode: "payment",
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "rub",
    "line_items[0][price_data][unit_amount]": String(kopecks),
    "line_items[0][price_data][product_data][name]": `Демо-заказ VEXA №${orderId}`,
    "metadata[demo]": "1",
    "metadata[demo_order]": String(orderId),
    locale: "auto",
    "custom_text[submit][message]": TEST_CARD_HINT,
    success_url: `${back}&session={CHECKOUT_SESSION_ID}`, // Stripe сам подставит id страницы оплаты
    cancel_url: back,
  }, crypto.randomUUID());
  if (!session.url) throw { code: "server" };
  return { url: session.url };
}

/** Прошла ли тестовая оплата демо-заказа: отвечаем по самой странице оплаты Stripe */
async function demoCheck(sessionId: string) {
  if (!/^cs_test_[A-Za-z0-9]+$/.test(sessionId)) throw { code: "bad_session" };
  const session = await stripe(`/checkout/sessions/${sessionId}`);
  if (session?.metadata?.demo !== "1") throw { code: "not_found" };
  return { paid: session.payment_status === "paid", order_id: Number(session.metadata.demo_order),
    amount: Number(session.amount_total) / 100, session_id: session.id };
}

/** Ответ для браузера покупателя: переход или короткий текст (HTML Supabase показывает как текст) */
const go = (url: string) => new Response(null, { status: 302, headers: { Location: url } });
const say = (text: string, status = 200) => new Response(text, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });

/** Покупатель открыл ссылку на оплату из реквизитов или вернулся со страницы Stripe */
async function browser(url: URL): Promise<Response> {
  const done = url.searchParams.has("done");
  const orderId = Number(url.searchParams.get(done ? "done" : "order"));
  if (!Number.isInteger(orderId) || orderId <= 0 || !SECRET_KEY || url.searchParams.get("sig") !== await sign(orderId)) {
    return say("Ссылка на оплату неверная. Откройте заказ в магазине, в «Мои заказы».", 404);
  }
  const order = await orderById(orderId);
  if (!order) return say("Заказ не найден.", 404);
  try {
    if (done) {
      if (order.status === "awaiting_payment" && order.pay_id) await applyPayment(await stripe(`/checkout/sessions/${order.pay_id}`));
      return go(await shopAfter(orderId));
    }
    if (order.status === "paid") return say("Этот заказ уже оплачен. Спасибо!");
    if (order.status !== "awaiting_payment") return say("Этот заказ сейчас нельзя оплатить. Откройте его в магазине, в «Мои заказы».", 409);
    if (!allowed(order.user_id)) return say("Онлайн-оплата пока в тестовом режиме. Оплатите заказ по реквизитам.", 403);
    const result = await openSession(order);
    return result.paid ? say("Этот заказ уже оплачен. Спасибо!") : go(result.url);
  } catch {
    return say("Не удалось открыть оплату. Попробуйте ещё раз через минуту.", 502);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method === "GET") return browser(new URL(req.url));
  if (req.method !== "POST") return answer({ error: "method" }, 405);
  const body: Json = await req.json().catch(() => ({}));

  // Событие Stripe: { object: "event", type: "checkout.session.completed", data: { object: { id: "cs_…" } } }
  if (body?.object === "event") {
    const id = String(body.data?.object?.id ?? "");
    if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(id)) return answer({ ok: true });
    try {
      if (/^checkout\.session\.(completed|async_payment_succeeded)$/.test(body.type)) await applyPayment(await stripe(`/checkout/sessions/${id}`));
      return answer({ ok: true });
    } catch {
      return answer({ error: "retry" }, 500); // Stripe повторит событие
    }
  }

  const orderId = Number(body?.order_id);
  if (!SECRET_KEY) return answer({ error: "not_configured" }, 503);
  if (body?.action === "demo_check") {
    try { return answer(await demoCheck(String(body.session_id ?? ""))); }
    catch (e) { return answer({ error: (e as Json)?.code ?? "provider" }, (e as Json)?.code ? 400 : 502); }
  }
  if (!Number.isInteger(orderId) || orderId <= 0) return answer({ error: "bad_order" }, 400);
  try {
    if (body.action === "demo_create") return answer(await demoCreate(orderId, Number(body.amount)));
    if (body.action === "link") {
      if (!(await isStaff(req))) return answer({ error: "denied" }, 403);
      const order = await orderById(orderId);
      if (!order) return answer({ error: "not_found" }, 404);
      if (!allowed(order.user_id)) return answer({ error: "test_only" }, 403);
      return answer({ url: await payLink(orderId) });
    }
    if (body.action === "create") return answer(await create(req, orderId));
    if (body.action === "check") return answer(await check(req, orderId));
    return answer({ error: "bad_action" }, 400);
  } catch (e) {
    const code = (e as Json)?.code ?? ((e as Error)?.message === "provider" ? "provider" : "server");
    return answer({ error: code }, code === "denied" || code === "not_found" || code === "test_only" ? 403 : code === "not_awaiting" ? 409 : 502);
  }
});
