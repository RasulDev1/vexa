// VEXA · онлайн-оплата картой через Stripe Checkout (Supabase Edge Function «online-pay»).
// Сначала — тестовые ключи Stripe (sk_test_…): оплата проходит по тестовым картам, деньги не списываются.
// Тестовые ключи Stripe выдаёт сразу после регистрации по почте, ИП и самозанятость не нужны.
//
// Что делает:
//   { action: "create", order_id } — от покупателя: создаёт страницу оплаты на сумму заказа из базы и возвращает ссылку;
//   { action: "check", order_id }  — от покупателя, когда он вернулся со страницы оплаты: спрашивает Stripe и отмечает оплату;
//   событие Stripe checkout.session.completed — перепроверяет оплату в Stripe и отмечает заказ оплаченным.
// Чей заказ, решает база: функция пересылает ей подпись Telegram покупателя (X-Telegram-Init-Data).
// Событию Stripe функция на слово не верит — сама запрашивает страницу оплаты по её id.
//
// Секреты функции (Edge Functions → Secrets):
//   STRIPE_SECRET_KEY  — секретный ключ Stripe; тестовый начинается с sk_test_
//   PAY_TESTERS        — Telegram ID через запятую: кто может платить, пока ключ тестовый. Без него тестовый
//                        ключ не принимает оплату ни от кого — иначе покупатель «оплатил» бы заказ тестовой картой
//   SHOP_URL           — адрес магазина (необязательно)
//   PAY_RETURN_URL     — куда вернуть покупателя после оплаты, например ссылка на бота https://t.me/имя_бота
//                        (необязательно; без неё — на сайт магазина, и он сам проверит оплату)
//   TELEGRAM_BOT_TOKEN — уже есть у бота; с ним бот напишет покупателю «Оплата получена» (необязательно)
// SUPABASE_URL, SUPABASE_ANON_KEY и SUPABASE_SERVICE_ROLE_KEY Supabase подставляет сам.
// Развернуть без проверки JWT: supabase functions deploy online-pay --no-verify-jwt
import { createClient } from "jsr:@supabase/supabase-js@2";

const SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
const SHOP_URL = Deno.env.get("SHOP_URL") ?? "https://rasuldev1.github.io/vexa/";
const RETURN_URL = Deno.env.get("PAY_RETURN_URL") ?? "";
const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const TEST_MODE = /^(sk|rk)_test_/.test(SECRET_KEY);
const TESTERS = (Deno.env.get("PAY_TESTERS") ?? "").split(/[\s,]+/).filter(Boolean);
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const API = "https://api.stripe.com/v1";

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
  // тестовый ключ: платить тестовой картой могут только проверяющие
  if (TEST_MODE && !TESTERS.includes(String(data.user_id))) throw { code: "test_only" };
  return data;
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

/** Покупатель нажал «Оплатить картой онлайн»: открытую страницу оплаты используем снова, иначе создаём новую */
async function create(req: Request, orderId: number) {
  const order = await customerOrder(req, orderId);
  if (order.pay_id && order.pay_url) {
    const old = await stripe(`/checkout/sessions/${order.pay_id}`);
    if (await applyPayment(old)) return { paid: true };
    if (old.status === "open" && old.url) return { url: old.url };
  }
  const kopecks = Math.round(Number(order.total) * 100);
  if (!(kopecks >= 50)) throw { code: "bad_amount" };
  const back = RETURN_URL || `${SHOP_URL}${SHOP_URL.includes("?") ? "&" : "?"}paid=${orderId}`;
  const session = await stripe("/checkout/sessions", {
    mode: "payment",
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "rub",
    "line_items[0][price_data][unit_amount]": String(kopecks),
    "line_items[0][price_data][product_data][name]": `Заказ VEXA №${orderId}`,
    "metadata[order_id]": String(orderId),
    client_reference_id: String(orderId),
    locale: "auto",
    success_url: back,
    cancel_url: RETURN_URL || SHOP_URL,
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
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
  if (!Number.isInteger(orderId) || orderId <= 0) return answer({ error: "bad_order" }, 400);
  if (!SECRET_KEY) return answer({ error: "not_configured" }, 503);
  try {
    if (body.action === "create") return answer(await create(req, orderId));
    if (body.action === "check") return answer(await check(req, orderId));
    return answer({ error: "bad_action" }, 400);
  } catch (e) {
    const code = (e as Json)?.code ?? ((e as Error)?.message === "provider" ? "provider" : "server");
    return answer({ error: code }, code === "denied" || code === "not_found" || code === "test_only" ? 403 : code === "not_awaiting" ? 409 : 502);
  }
});
