// Демо-версия: страница оплаты заказа. Ссылку на неё отдаёт «функция online-pay» из demo.js.
// «Оплатить картой» открывает настоящую тестовую страницу Stripe через функцию online-pay магазина (demo_create),
// Stripe возвращает сюда же с ?session=…, функция подтверждает оплату (demo_check) — и заказ отмечается оплаченным
// в демо-базе этого браузера. Магазин и CRM в других вкладках обновятся сами.
// Функция не ответила — можно оплатить без карты, имитацией.
import { $, formatPrice, escapeHtml } from "./core.js?v=20261001b";
import { createDemoClient } from "./demo.js?v=20261001b";
import { DEMO_PAY_FUNCTION } from "./config.js?v=20261001b";

const client = createDemoClient();
const params = new URLSearchParams(location.search);
const id = Number(params.get("order")) || 0;
const sessionId = params.get("session") || "";
const card = $("payCard");
const TEST_CARD = `Это тестовая оплата Stripe, деньги не списываются. Оплатить можно только тестовой картой <b>4242 4242 4242 4242</b>: срок любой в будущем, CVC любые 3 цифры. Настоящие карты не принимаются.`;

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

async function confirm(payId) {
  const { data: done } = await client.rpc("demo_pay_confirm", { p_id: id, p_pay_id: payId });
  return done;
}

const paidHtml = (sum, how) => `<h2 class="pay-ok">✅ Оплата прошла</h2><p class="pay-sum">${sum}</p>
  <p class="pay-note">${how} Заказ отмечен оплаченным сам, без менеджера: в магазине и в CRM статус уже «Оплачен».</p>`;

async function load() {
  const { data: o, error } = await client.rpc("demo_pay_order", { p_id: id });
  if (error || !o) return show(`<h2>Заказ не найден</h2><p class="pay-note">Возможно, демо сбросили. Оформите заказ заново.</p>`);
  const sum = formatPrice(Number(o.total) || 0);
  if (sessionId && o.status === "awaiting_payment") return returned(o, sum);
  if (o.status === "paid") return show(`<h2 class="pay-ok">Заказ уже оплачен</h2>`);
  if (o.status !== "awaiting_payment") return show(`<h2>Оплата недоступна</h2><p class="pay-note">Заказ ещё не принят или уже закрыт.</p>`);
  show(`<h2>Оплата заказа</h2>
    <p class="pay-note">Магазин VEXA · заказ №${o.id}</p>
    <p class="pay-sum">${sum}</p>
    <p class="pay-note">${TEST_CARD}</p>
    <p class="pay-note" id="payError" hidden></p>
    <button class="primary" id="payStripe" type="button">Оплатить картой · ${sum}</button>
    <button class="ghost" id="payFake" type="button">Оплатить без карты (имитация)</button>
    <button class="ghost" id="payCancel" type="button">Отмена</button>`, false);
  $("payCancel").onclick = back;
  $("payStripe").onclick = async (e) => {
    e.target.disabled = true;
    e.target.textContent = "Открываем Stripe…";
    try {
      const { url } = await payFunction({ action: "demo_create", order_id: o.id, amount: Number(o.total) });
      location.href = url;
    } catch (error) {
      e.target.disabled = false;
      e.target.textContent = `Оплатить картой · ${sum}`;
      $("payError").hidden = false;
      $("payError").textContent = error.code === "network" || error.code === "bad_action" || error.code === "bad_order"
        ? "Тестовая оплата Stripe сейчас недоступна. Можно оплатить без карты, кнопкой ниже."
        : "Не удалось открыть Stripe. Повторите или оплатите без карты.";
    }
  };
  $("payFake").onclick = async (e) => {
    e.target.disabled = true;
    e.target.textContent = "Оплачиваем…";
    await new Promise((r) => setTimeout(r, 700));
    if (!(await confirm(null))) return load(); // статус заказа успел измениться
    show(paidHtml(sum, "Оплата имитирована, карта не понадобилась."));
  };
}

/** Stripe вернул посетителя: спрашиваем функцию, прошла ли оплата, и только тогда отмечаем заказ */
async function returned(o, sum) {
  show(`<h2>Проверяем оплату…</h2>`, false);
  try {
    const result = await payFunction({ action: "demo_check", session_id: sessionId });
    const ok = result.paid && result.order_id === o.id && Math.round(result.amount) === Math.round(Number(o.total));
    if (ok && (await confirm(result.session_id))) return show(paidHtml(sum, "Тестовая оплата Stripe подтверждена."));
    if (ok) return load();
    show(`<h2>Оплата не прошла</h2><p class="pay-note">Stripe не подтвердил оплату этого заказа.</p>
      <button class="primary" id="payAgain" type="button">Попробовать ещё раз</button>`);
  } catch (error) {
    show(`<h2>Не удалось проверить оплату</h2><p class="pay-note">${escapeHtml(error.code === "network" ? "Нет связи с сервером оплаты." : "Ошибка сервера оплаты.")}</p>
      <button class="primary" id="payAgain" type="button">Проверить ещё раз</button>`);
    $("payAgain").onclick = () => load();
    return;
  }
  $("payAgain").onclick = () => { location.href = `pay.html?order=${id}`; };
}
load();
