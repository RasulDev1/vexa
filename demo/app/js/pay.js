// Демо-версия: страница оплаты вместо Stripe. Ссылку на неё отдаёт «функция online-pay» из demo.js.
// «Оплатить» отмечает заказ оплаченным картой, как настоящая оплата: магазин и CRM в других вкладках обновятся сами.
import { $, formatPrice } from "./core.js?v=20261001b";
import { createDemoClient } from "./demo.js?v=20261001b";

const client = createDemoClient();
const id = Number(new URLSearchParams(location.search).get("order")) || 0;
const card = $("payCard");

function back() {
  window.close(); // вкладку открыл магазин — закрываем её, магазин уже показывает оплату
  setTimeout(() => { location.href = "../"; }, 300);
}

function show(html, withBack = true) {
  card.innerHTML = html + (withBack ? `<button class="ghost" id="payBack" type="button">Вернуться в магазин</button>` : "");
  $("payBack")?.addEventListener("click", back);
}

async function load() {
  const { data: o, error } = await client.rpc("demo_pay_order", { p_id: id });
  if (error || !o) return show(`<h2>Заказ не найден</h2><p class="pay-note">Возможно, демо сбросили. Оформите заказ заново.</p>`);
  if (o.status === "paid") return show(`<h2 class="pay-ok">Заказ уже оплачен</h2>`);
  if (o.status !== "awaiting_payment") return show(`<h2>Оплата недоступна</h2><p class="pay-note">Заказ ещё не принят или уже закрыт.</p>`);
  const sum = formatPrice(Number(o.total) || 0);
  show(`<h2>Оплата заказа</h2>
    <p class="pay-note">Магазин VEXA</p>
    <p class="pay-sum">${sum}</p>
    <p class="pay-note">Это демо: оплата имитируется, вводить карту не нужно.</p>
    <button class="primary" id="payNow" type="button">Оплатить ${sum}</button>
    <button class="ghost" id="payCancel" type="button">Отмена</button>`, false);
  $("payCancel").onclick = back;
  $("payNow").onclick = async (e) => {
    e.target.disabled = true;
    e.target.textContent = "Оплачиваем…";
    await new Promise((r) => setTimeout(r, 700));
    const { data: done } = await client.rpc("demo_pay_confirm", { p_id: id });
    if (!done) return load(); // статус заказа успел измениться
    show(`<h2 class="pay-ok">✅ Оплата прошла</h2><p class="pay-sum">${sum}</p>
      <p class="pay-note">Заказ отмечен оплаченным сам, без менеджера. В магазине и в CRM статус уже «Оплачен».</p>`);
  };
}
load();
