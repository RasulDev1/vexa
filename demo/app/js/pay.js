// Демо-версия: сюда тестовая страница Stripe возвращает посетителя после оплаты (?session=…) или отмены (?cancel=1).
// Функция online-pay подтверждает оплату (demo_check) — и заказ отмечается оплаченным в демо-базе этого браузера,
// магазин и CRM в других вкладках обновятся сами. Открытая напрямую (ссылка из CRM) — сразу ведёт на Stripe.
import { $, formatPrice } from "./core.js?v=20261001b";
import { createDemoClient } from "./demo.js?v=20261001b";
import { DEMO_PAY_FUNCTION } from "./config.js?v=20261001b";

const client = createDemoClient();
const params = new URLSearchParams(location.search);
const id = Number(params.get("order")) || 0;
const sessionId = params.get("session") || "";
const card = $("payCard");

function back() {
  window.close(); // вкладку открыл магазин — закрываем её, магазин уже показывает оплату
  setTimeout(() => { location.href = "../"; }, 300);
}

function show(html, withBack = true) {
  card.innerHTML = html + (withBack ? `<button class="ghost" id="payBack" type="button">Вернуться в магазин</button>` : "");
  $("payBack")?.addEventListener("click", back);
}

/** Запрос к функции online-pay; ошибка — { code } */
async function payFunction(body) {
  if (!DEMO_PAY_FUNCTION) throw { code: "not_configured" };
  let response;
  try {
    response = await fetch(DEMO_PAY_FUNCTION, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch { throw { code: "network" }; }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw { code: data?.error || "server" };
  return data;
}

async function load() {
  const { data: o, error } = await client.rpc("demo_pay_order", { p_id: id });
  if (error || !o) return show(`<h2>Заказ не найден</h2><p class="pay-note">Возможно, демо сбросили. Оформите заказ заново.</p>`);
  const sum = formatPrice(Number(o.total) || 0);
  if (o.status === "paid") return show(`<h2 class="pay-ok">✅ Заказ оплачен</h2><p class="pay-sum">${sum}</p>`);
  if (o.status !== "awaiting_payment") return show(`<h2>Оплата недоступна</h2><p class="pay-note">Заказ ещё не принят или уже закрыт.</p>`);
  if (sessionId) return returned(o, sum);
  if (params.has("cancel")) {
    return show(`<h2>Оплата отменена</h2><p class="pay-note">Заказ ждёт оплаты. Оплатить можно в магазине, во вкладке «Мои заказы».</p>`);
  }
  // Открыли ссылку из CRM напрямую — сразу на Stripe
  show(`<h2>Открываем Stripe…</h2>`, false);
  try {
    location.replace((await payFunction({ action: "demo_create", order_id: o.id, amount: Number(o.total) })).url);
  } catch {
    show(`<h2>Не удалось открыть оплату</h2><p class="pay-note">Тестовая оплата Stripe сейчас недоступна. Повторите позже.</p>`);
  }
}

/** Stripe вернул посетителя: спрашиваем функцию, прошла ли оплата, и только тогда отмечаем заказ */
async function returned(o, sum) {
  show(`<h2>Проверяем оплату…</h2>`, false);
  try {
    const result = await payFunction({ action: "demo_check", session_id: sessionId });
    const ok = result.paid && result.order_id === o.id && Math.round(result.amount) === Math.round(Number(o.total));
    if (ok) {
      const { data: done } = await client.rpc("demo_pay_confirm", { p_id: id, p_pay_id: result.session_id });
      if (!done) return load(); // статус заказа успел измениться
      return show(`<h2 class="pay-ok">✅ Оплата прошла</h2><p class="pay-sum">${sum}</p>
        <p class="pay-note">Тестовая оплата Stripe подтверждена. Заказ отмечен оплаченным сам, без менеджера: в магазине и в CRM статус уже «Оплачен».</p>`);
    }
    show(`<h2>Оплата не прошла</h2><p class="pay-note">Stripe не подтвердил оплату этого заказа. Оплатить можно в магазине, во вкладке «Мои заказы».</p>`);
  } catch (error) {
    show(`<h2>Не удалось проверить оплату</h2><p class="pay-note">${error.code === "network" ? "Нет связи с сервером оплаты." : "Ошибка сервера оплаты."}</p>
      <button class="primary" id="payAgain" type="button">Проверить ещё раз</button>`);
    $("payAgain").onclick = () => load();
  }
}
load();
