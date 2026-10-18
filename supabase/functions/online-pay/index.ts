// VEXA · онлайн-оплата картой через ЮKassa (Supabase Edge Function «online-pay»).
// Сначала подключается тестовый магазин ЮKassa: оплата проходит по тестовым картам, деньги не списываются.
//
// Что делает:
//   { action: "create", order_id } — от покупателя: создаёт платёж на сумму заказа из базы и возвращает ссылку на оплату;
//   { action: "check", order_id }  — от покупателя, когда он вернулся со страницы оплаты: спрашивает ЮKassa и отмечает оплату;
//   уведомление ЮKassa (payment.succeeded) — перепроверяет платёж в ЮKassa и отмечает заказ оплаченным.
// Чей заказ, решает база: функция пересылает ей подпись Telegram покупателя (X-Telegram-Init-Data).
// Уведомлению ЮKassa функция на слово не верит — сама запрашивает платёж по его id.
//
// Секреты функции (Edge Functions → Secrets):
//   YOOKASSA_SHOP_ID     — shopId тестового магазина ЮKassa
//   YOOKASSA_SECRET_KEY  — секретный ключ, у тестового магазина начинается с test_
//   SHOP_URL             — адрес магазина (необязательно)
//   YOOKASSA_RETURN_URL  — куда вернуть покупателя после оплаты, например ссылка на бота https://t.me/имя_бота
//                          (необязательно; без неё — на сайт магазина, и он сам проверит оплату)
//   YOOKASSA_TESTERS     — Telegram ID через запятую: кто может платить, пока ключ тестовый. Без него тестовый
//                          магазин не принимает оплату ни от кого — иначе покупатель «оплатил» бы заказ тестовой картой
//   TELEGRAM_BOT_TOKEN   — уже есть у бота; с ним бот напишет покупателю «Оплата получена» (необязательно)
// SUPABASE_URL, SUPABASE_ANON_KEY и SUPABASE_SERVICE_ROLE_KEY Supabase подставляет сам.
// Развернуть без проверки JWT: supabase functions deploy online-pay --no-verify-jwt
import { createClient } from "jsr:@supabase/supabase-js@2";

const SHOP_ID = Deno.env.get("YOOKASSA_SHOP_ID") ?? "";
const SECRET_KEY = Deno.env.get("YOOKASSA_SECRET_KEY") ?? "";
const SHOP_URL = Deno.env.get("SHOP_URL") ?? "https://rasuldev1.github.io/vexa/";
const RETURN_URL = Deno.env.get("YOOKASSA_RETURN_URL") ?? "";
const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const TEST_MODE = SECRET_KEY.startsWith("test_");
const TESTERS = (Deno.env.get("YOOKASSA_TESTERS") ?? "").split(/[\s,]+/).filter(Boolean);
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const API = "https://api.yookassa.ru/v3";

if (!SHOP_ID || !SECRET_KEY) console.error("Нет секретов YOOKASSA_SHOP_ID / YOOKASSA_SECRET_KEY: Edge Functions → Secrets");

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

/** Запрос к API ЮKassa: basic-авторизация shopId:секретный ключ */
async function yookassa(path: string, body?: Json, idempotenceKey?: string): Promise<Json> {
  const response = await fetch(`${API}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: "Basic " + btoa(`${SHOP_ID}:${SECRET_KEY}`),
      "Content-Type": "application/json",
      ...(idempotenceKey ? { "Idempotence-Key": idempotenceKey } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    // 401 — неверный shopId или ключ
    console.error(`ЮKassa ${path}:`, response.status, result?.code, result?.description);
    throw new Error("yookassa");
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
  // тестовый магазин: платить тестовой картой могут только проверяющие
  if (TEST_MODE && !TESTERS.includes(String(data.user_id))) throw { code: "test_only" };
  return data;
}

/** Платёж прошёл → заказ оплачен. Сумму и номер заказа берём из самого платежа ЮKassa. */
async function applyPayment(payment: Json): Promise<boolean> {
  const orderId = Number(payment?.metadata?.order_id);
  if (payment?.status !== "succeeded" || !payment.paid || !orderId) return false;
  if (payment.amount?.currency !== "RUB") return false;
  const { data, error } = await admin.rpc("online_pay_confirm", {
    p_id: orderId, p_pay_id: payment.id, p_amount: Number(payment.amount.value), p_test: Boolean(payment.test),
  });
  if (error) { console.error("online_pay_confirm:", error); throw new Error("db"); }
  if (data) await notifyCustomer(orderId, Number(payment.amount.value));
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

/** Покупатель нажал «Оплатить картой онлайн»: незавершённый платёж используем снова, иначе создаём новый */
async function create(req: Request, orderId: number) {
  const order = await customerOrder(req, orderId);
  if (order.pay_id && order.pay_url) {
    const old = await yookassa(`/payments/${order.pay_id}`);
    if (old.status === "pending" && old.confirmation?.confirmation_url) return { url: old.confirmation.confirmation_url };
    if (await applyPayment(old)) return { paid: true };
  }
  const total = Number(order.total);
  if (!(total > 0)) throw { code: "bad_amount" };
  const payment = await yookassa("/payments", {
    amount: { value: total.toFixed(2), currency: "RUB" },
    capture: true,
    confirmation: { type: "redirect", return_url: RETURN_URL || `${SHOP_URL}${SHOP_URL.includes("?") ? "&" : "?"}paid=${orderId}` },
    description: `Заказ VEXA №${orderId}`,
    metadata: { order_id: String(orderId) },
  }, crypto.randomUUID());
  const url = payment.confirmation?.confirmation_url;
  if (!url) throw { code: "server" };
  await admin.rpc("online_pay_start", { p_id: orderId, p_pay_id: payment.id, p_url: url, p_test: Boolean(payment.test) });
  return { url };
}

/** Покупатель вернулся со страницы оплаты — не ждём уведомления, спрашиваем ЮKassa сами */
async function check(req: Request, orderId: number) {
  let order: Json;
  try { order = await customerOrder(req, orderId); } catch (e) {
    if ((e as Json)?.code === "not_awaiting") return { paid: false, closed: true }; // уже оплачен или отменён — сайт перечитает заказ
    throw e;
  }
  if (!order.pay_id) return { paid: false };
  const payment = await yookassa(`/payments/${order.pay_id}`);
  return { paid: await applyPayment(payment), status: payment.status };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return answer({ error: "method" }, 405);
  const body: Json = await req.json().catch(() => ({}));

  // Уведомление ЮKassa: { type: "notification", event: "payment.succeeded", object: { id, … } }
  if (body?.type === "notification") {
    const id = String(body.object?.id ?? "");
    if (!/^[0-9a-f-]{20,64}$/i.test(id)) return answer({ ok: true });
    try {
      if (body.event === "payment.succeeded") await applyPayment(await yookassa(`/payments/${id}`));
      return answer({ ok: true });
    } catch {
      return answer({ error: "retry" }, 500); // ЮKassa повторит уведомление
    }
  }

  const orderId = Number(body?.order_id);
  if (!Number.isInteger(orderId) || orderId <= 0) return answer({ error: "bad_order" }, 400);
  if (!SHOP_ID || !SECRET_KEY) return answer({ error: "not_configured" }, 503);
  try {
    if (body.action === "create") return answer(await create(req, orderId));
    if (body.action === "check") return answer(await check(req, orderId));
    return answer({ error: "bad_action" }, 400);
  } catch (e) {
    const code = (e as Json)?.code ?? ((e as Error)?.message === "yookassa" ? "provider" : "server");
    return answer({ error: code }, code === "denied" || code === "not_found" || code === "test_only" ? 403 : code === "not_awaiting" ? 409 : 502);
  }
});
