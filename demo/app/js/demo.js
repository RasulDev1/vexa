// ДЕМО-ВЕРСИЯ: «база» магазина прямо в браузере вместо Supabase.
// createDemoClient() отдаёт объект с тем же API, что у supabase-js: from().select().eq().order().limit(),
// insert / update / upsert / delete, single / maybeSingle, rpc(имя, аргументы), channel() и storage.
// Таблицы, представления и функции повторяют supabase-*.sql: статусы, история заказа, оплаты, возвраты, остатки,
// клиенты, задачи, отзывы, сотрудники. Данные лежат в localStorage (общие для index.html и crm.html),
// изменения из другой вкладки приходят через событие storage — как Realtime у Supabase.
import { BASE_PRODUCTS, COLOR_NAMES } from "./data.js?v=20261001b";
import { STORAGE_PREFIX, storage, toast } from "./core.js?v=20261001b";
import { DEMO_DIRECTOR, DEMO_PAY_FUNCTION } from "./config.js?v=20261001b";

const DB_KEY = STORAGE_PREFIX + "demo_db_v5";
const EVENT_KEY = STORAGE_PREFIX + "demo_event";
const ME = 1001;                       // «Telegram ID» посетителя демо — он же покупатель в магазине
const STAFF_TOPIC = "demo-staff";
const userTopic = (id) => `demo-user-${id}`;
const OPEN_CHAT = ["awaiting_payment", "paid", "return_requested", "return_approved"];
const SOLD = ["paid", "delivered", "return_requested", "return_approved", "returned"];

/* ---------- Хранилище: localStorage, а если он недоступен — память вкладки ---------- */
let memoryDb = null;
let storageBroken = false;

function readDb() {
  if (!storageBroken) {
    try {
      const raw = localStorage.getItem(DB_KEY);
      if (raw) return (memoryDb = JSON.parse(raw));
    } catch { storageBroken = true; }
  }
  if (memoryDb) return memoryDb;
  memoryDb = seed();
  writeDb(memoryDb);
  return memoryDb;
}

function writeDb(db) {
  memoryDb = db;
  if (storageBroken) return;
  try { localStorage.setItem(DB_KEY, JSON.stringify(db)); } catch { storageBroken = true; } // переполнено — дальше в памяти
}

/** «Сбросить демо»: исходные данные, пустая корзина, вход директора */
export function resetDemo() {
  memoryDb = seed();
  storageBroken = false;
  writeDb(memoryDb);
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key?.startsWith(STORAGE_PREFIX) && key !== DB_KEY) localStorage.removeItem(key);
    }
  } catch {}
  // сразу, без notify: следом страница перезагружается и отложенное событие не успело бы уйти
  try { localStorage.setItem(EVENT_KEY, JSON.stringify({ topics: [STAFF_TOPIC, userTopic(ME)], payload: { op: "reset" }, n: Math.random() })); } catch {}
}

/* ---------- Даты и форматирование ---------- */
const iso = (ms) => new Date(ms).toISOString();
const nowIso = () => new Date().toISOString();
const moscowDay = (value) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow" }).format(new Date(value));
const inRange = (value, from, to) => {
  if (!value) return false;
  const d = moscowDay(value);
  return (!from || d >= from) && (!to || d <= to);
};
const rub = (n) => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " ₽";
const WAY = { cash: "наличными", card: "картой" };
const clone = (v) => JSON.parse(JSON.stringify(v));

/* ---------- Исходные данные ---------- */
const PRODUCTS = Object.fromEntries(BASE_PRODUCTS.map((p) => [p.id, p]));
function item(id, size, qty = 1, color) {
  const p = PRODUCTS[id];
  color ||= p.colors[0];
  return { id, color, size, qty, name: p.name, colorName: p.colorNames?.[color] || COLOR_NAMES[color] || color, price: p.price };
}
const itemsTotal = (items) => items.reduce((s, l) => s + l.price * l.qty, 0);

const STAFF = [
  { id: 1, login: "director", full_name: DEMO_DIRECTOR, role: "admin", telegram_id: null },
  { id: 2, login: "kamil", full_name: "Магомедов Камиль", role: "manager", telegram_id: null },
  { id: 3, login: "artem", full_name: "Белов Артём", role: "manager", telegram_id: null },
];

// Покупатели: условные имена и номера, совпадения с реальными людьми случайны
const CUSTOMERS = {
  101: ["Алиев Тимур", "+7 928 314-22-61"], 102: ["Хапаев Аслан", "+7 938 205-47-19"],
  103: ["Гасанов Мурад", "+7 989 772-10-35"], 104: ["Соколов Дмитрий", "+7 918 640-93-28"],
  105: ["Тедеев Алан", "+7 928 491-36-07"], 106: ["Ковалёв Максим", "+7 961 503-84-12"],
  107: ["Мальсагов Ислам", "+7 929 118-65-40"], 108: ["Морозов Алексей", "+7 905 377-21-96"],
  109: ["Курбанов Амир", "+7 963 824-50-73"], 110: ["Цховребов Георгий", "+7 988 256-13-84"],
  111: ["Волков Сергей", "+7 915 402-77-31"], 112: ["Омаров Хасан", "+7 967 931-08-52"],
  [ME]: ["Беков Артур", "+7 900 000-00-00"],
};

const PAY_TEXT = "Перевод по СБП на номер магазина (демо-реквизиты) или картой при получении";

function seed() {
  const now = Date.now();
  const H = 3600e3, M = 60e3, D = 24 * H;
  /** Время: дней назад, в hh:mm по местному времени (не позже «сейчас») */
  const at = (days, hh, mm = 0) => {
    const d = new Date(now - days * D);
    d.setHours(hh, mm, 0, 0);
    return Math.min(d.getTime(), now - 5 * M);
  };
  const db = {
    seq: { orders: 1040, order_messages: 0, order_events: 0, customer_notes: 0, staff_tasks: 0, product_reviews: 0, staff_accounts: 3 },
    orders: [], order_messages: [], order_events: [], order_archive: [],
    product_costs: { 1: 1250, 2: 1900, 3: 2100, 4: 650, 5: 2700, 6: 3600, 7: 7400, 8: 520, 9: 1700, 10: 1450 },
    customer_sources: { 101: "Instagram", 102: "Посоветовали друзья", 103: "Instagram", 104: "Авито", 105: "ВКонтакте",
      106: "Instagram", 107: "Telegram", 109: "Посоветовали друзья", 110: "Увидел магазин", 112: "Instagram" },
    customer_notes: [], customer_tags: { 101: ["постоянный", "VIP"], 105: ["постоянный"] },
    staff_tasks: [], product_reviews: [], staff_accounts: clone(STAFF),
    catalog_state: { data: {}, version: 1 },
  };
  const event = (orderId, time, actor, body) => db.order_events.push({ id: ++db.seq.order_events, order_id: orderId, at: iso(time), actor, body });
  const staffName = (id) => STAFF.find((s) => s.id === id).full_name;

  /** Заказ с историей: t — когда оформлен; acc / paid / deliv — через сколько минут после оформления.
   *  pay — как покупатель выбрал платить: online (по умолчанию), cash — наличными при самовывозе, cod — при получении */
  function order(o) {
    const id = ++db.seq.orders;
    const pay = o.pay || "online";
    const [name, phone] = CUSTOMERS[o.uid];
    const total = itemsTotal(o.items);
    const created = o.t;
    const past = (min) => Math.min(created + min * M, now - 2 * M); // ничего не происходит «в будущем»
    const row = {
      id, created_at: iso(created), user_id: o.uid, username: null, status: o.status, items: o.items, total,
      customer_name: name, phone, delivery_way: o.way + (PAY_NOTE[pay] ? " · " + PAY_NOTE[pay] : ""), address: o.addr || null, payment_details: null, manager_note: null,
      payment_method: null, paid_amount: null, paid_at: null, paid_by: null, paid_by_id: null,
      accepted_by: null, accepted_by_id: null, accepted_at: null, delivered_at: null, delivered_by: null,
      return_request_reason: null, return_requested_at: null, return_declined: null, return_reason: null,
      return_amount: null, return_method: null, return_approved_at: null, return_approved_by: null,
      returned_at: null, returned_by: null, refund_amount: null, refund_method: null, restocked: false,
      cost_total: null, stock_reserved: true,
    };
    event(id, created, "Покупатель", "Заказ оформлен на " + rub(total));
    const mgr = o.mgr ? staffName(o.mgr) : null;
    if (o.reject) {
      row.manager_note = o.reject;
      row.stock_reserved = false;
      event(id, past(o.acc), mgr, `Отказ: «${o.reject}»`);
    }
    if (o.acc != null && !o.reject) {
      Object.assign(row, { accepted_at: iso(past(o.acc)), accepted_by: mgr, accepted_by_id: o.mgr,
        payment_details: pay === "online" ? payUrl(id) : OFFLINE_TEXT[pay] });
      event(id, past(o.acc), mgr, "Принят, покупателю отправлены реквизиты для оплаты");
    }
    if (o.paid != null) {
      const amount = o.amount ?? total, online = pay === "online"; // онлайн-оплату отмечает не менеджер, а сама оплата
      Object.assign(row, { payment_method: online ? "card" : o.method, paid_amount: amount, paid_at: iso(past(o.paid)),
        paid_by: online ? "Онлайн-оплата (тест)" : mgr, paid_by_id: online ? null : o.mgr, online_pay_test: online || null,
        cost_total: itemsCost(db, o.items) });
      event(id, past(o.paid), online ? "Покупатель" : mgr, `Оплачен ${WAY[row.payment_method]}: ${rub(amount)}`);
    }
    if (o.deliv != null) {
      Object.assign(row, { delivered_at: iso(past(o.deliv)), delivered_by: mgr });
      event(id, past(o.deliv), mgr, "Вручён покупателю");
    }
    if (o.request) {
      Object.assign(row, { return_request_reason: o.request.reason, return_requested_at: iso(o.request.at) });
      event(id, o.request.at, "Покупатель", `Покупатель запросил возврат: «${o.request.reason}»`);
    }
    if (o.refund) {
      const r = o.refund;
      Object.assign(row, { return_reason: r.reason, return_amount: r.amount, return_method: r.method, return_approved_at: iso(r.approved),
        return_approved_by: mgr, returned_at: iso(r.done), returned_by: mgr, refund_amount: r.amount, refund_method: r.method, restocked: r.restock,
        stock_reserved: !r.restock });
      event(id, r.approved, mgr, `Возврат одобрен: «${r.reason}». Вернём ${rub(r.amount)} ${WAY[r.method]}, ждём вещь`);
      event(id, r.done, mgr, `Возврат вручён: «${r.reason}». Вернули ${rub(r.amount)} ${WAY[r.method]}, ${r.restock ? "товар вернулся на склад" : "товар не возвращается на склад"}`);
    }
    db.orders.push(row);
    return id;
  }

  const PAY_NOTE = { cash: "оплата наличными", cod: "оплата при получении, возврат платный" };
  const OFFLINE_TEXT = { cash: "Оплата наличными при самовывозе", cod: "Оплата при получении. Возврат платный" };
  const CDEK = "СДЭК", POST = "Почта России", CITY = "По городу", PICKUP = "Самовывоз";
  order({ uid: 104, t: at(13, 11, 20), items: [item(6, "M")], way: CDEK, addr: "Краснодар, ул. Красная, 120, ПВЗ СДЭК",
    status: "delivered", mgr: 2, acc: 25, paid: 140, method: "card", deliv: 2 * 1440 });
  order({ uid: 101, t: at(12, 14, 5), items: [item(7, "43"), item(8, "One size")], way: PICKUP, pay: "cash",
    status: "delivered", mgr: 3, acc: 15, paid: 300, method: "cash", deliv: 300 });
  order({ uid: 105, t: at(10, 9, 50), items: [item(5, "M", 1, "#D8C8B0"), item(4, "S")], way: CDEK, addr: "Владикавказ, пр. Мира, 9, ПВЗ СДЭК",
    pay: "cod", status: "delivered", mgr: 2, acc: 20, paid: 3 * 1440, method: "card", deliv: 3 * 1440 });
  order({ uid: 103, t: at(9, 16, 30), items: [item(10, "L", 2)], way: PICKUP, pay: "cash",
    status: "delivered", mgr: 2, acc: 10, paid: 120, method: "cash", deliv: 120 });
  order({ uid: 107, t: at(8, 12, 45), items: [item(7, "42", 1, "#B3122E")], way: CDEK, addr: "Назрань, ул. Московская, 22, ПВЗ СДЭК",
    status: "delivered", mgr: 3, acc: 40, paid: 180, method: "card", deliv: 2 * 1440 });
  order({ uid: 110, t: at(5, 11, 30), items: [item(3, "XL"), item(4, "L")], way: PICKUP, pay: "cash",
    status: "delivered", mgr: 3, acc: 20, paid: 90, method: "cash", deliv: 95 });
  order({ uid: 101, t: at(4, 17, 15), items: [item(1, "M", 2)], way: PICKUP,
    status: "delivered", mgr: 2, acc: 10, paid: 60, method: "card", deliv: 65 });
  order({ uid: ME, t: at(3, 12, 20), items: [item(4, "M"), item(9, "M")], way: CDEK, addr: "Краснодар, ул. Красная, 120, ПВЗ СДЭК",
    status: "delivered", mgr: 2, acc: 30, paid: 150, method: "card", deliv: 1440 });

  // Задачи сотрудников
  const task = (title, due, assignee, extra = {}) => db.staff_tasks.push({ id: ++db.seq.staff_tasks, title, due_at: iso(due),
    customer_id: null, customer_name: null, order_id: null, assignee_id: assignee, assignee_name: staffName(assignee),
    created_by_id: 1, created_by: staffName(1), created_at: iso(now - 2 * D), done_at: null, done_by: null, ...extra });
  task("Принять поставку кроссовок Dunk Low (размеры 42–44)", now + D + 2 * H, 1);
  task("Предложить Тимуру новинки сезона", now + 3 * D, 2, { customer_id: 101, customer_name: "Алиев Тимур" });
  task("Обновить фото витрины", now - 2 * D, 3, { done_at: iso(now - 2 * D + H), done_by: staffName(3) });

  // Заметки о клиентах
  const note = (uid, body, author, time) => db.customer_notes.push({ id: ++db.seq.customer_notes, user_id: uid, body, author: staffName(author), author_id: author, created_at: iso(time) });
  note(101, "Берёт кроссовки, размер 43. Новинки предлагать первым.", 2, at(4, 18, 0));

  // Отзывы о товарах
  const review = (product, uid, rating, body, time, extra = {}) => {
    const [name] = CUSTOMERS[uid];
    const [last, first] = name.split(" ");
    db.product_reviews.push({ id: ++db.seq.product_reviews, product_id: product, user_id: uid, author: `${first} ${last[0]}.`, rating, body,
      created_at: iso(time), updated_at: iso(time), hidden: false, hidden_by: null, reply: null, reply_by: null, reply_at: null, ...extra });
  };
  review(6, 104, 5, "Лёгкая, правда складывается в карман. Попал под дождь — не промокла.", at(9, 20, 0));
  review(7, 101, 5, "Оригинал, всё по размеру. Забрал в магазине за пару часов.", at(11, 21, 0),
    { reply: "Тимур, спасибо! Ждём снова 🙌", reply_by: staffName(2), reply_at: iso(at(11, 22, 0)) });
  review(5, 105, 4, "Тёплое и плотное, но рукава длинноваты.", at(6, 19, 30));
  review(10, 103, 5, "Бегаю в нём каждое утро, не натирает.", at(8, 9, 0));
  review(2, 102, 3, "Ткань хорошая, но маломерит — пришлось вернуть.", at(8, 18, 0),
    { reply: "Спасибо за отзыв! Добавили в описание совет брать на размер больше.", reply_by: staffName(3), reply_at: iso(at(8, 19, 0)) });
  review(3, 110, 4, "Удобные, хорошо сидят. Цвет чуть светлее, чем на фото.", at(4, 12, 0));
  review(7, 107, 5, "Красные огонь, всем советую.", at(5, 15, 0));

  // Склад: остатки по цвету и размеру, журнал приёмки
  const stock = {};
  for (const p of BASE_PRODUCTS) {
    const qty = {};
    p.colors.forEach((c, ci) => p.sizes.forEach((s, si) => {
      qty[`${c}|${s}`] = p.soldOutSizes?.includes(s) ? 0 : 1 + ((p.id * 7 + ci * 3 + si * 5) % 8);
    }));
    stock[p.id] = { qty };
  }
  const receipt = (id, time, by, kind, qty) => ({ at: time, by: staffName(by), id, name: PRODUCTS[id].name, kind, qty });
  db.catalog_state = {
    version: 1,
    data: { products: [], hidden: [], variants: {}, stock, staff: [], prices: {}, order: [],
      receipts: [
        receipt(7, at(2, 11, 0), 3, "in", { "#1B1B1F|43": 3, "#1B1B1F|44": 2, "#B3122E|42": 2 }),
        receipt(5, at(5, 10, 30), 1, "in", { "#D8C8B0|M": 4, "#1B1B1F|L": 3 }),
        receipt(9, at(6, 17, 0), 2, "fix", { "#F2F2F0|XL": -1 }),
        receipt(6, at(10, 9, 15), 1, "in", { "#3A3D42|M": 5, "#3A3D42|L": 5 }),
      ] },
  };
  return db;
}

/** Себестоимость позиций по закупочным ценам; null — ни у одного товара цена не указана */
function itemsCost(db, items) {
  let sum = null;
  for (const l of Array.isArray(items) ? items : []) {
    const cost = db.product_costs[String(l.id)];
    if (cost != null) sum = (sum || 0) + cost * Math.max(Number(l.qty) || 1, 0);
  }
  return sum;
}

/* ---------- Живые обновления между вкладками (вместо Supabase Realtime) ---------- */
const listeners = new Map(); // тема → Set(обработчик)

function deliver(event) {
  for (const topic of event.topics || []) {
    for (const handler of listeners.get(topic) || []) {
      try { handler({ payload: event.payload }); } catch (error) { console.warn("demo realtime:", error); }
    }
  }
}

function notify(topics, payload) {
  const event = { topics, payload, n: Math.random() };
  // Событие — после записи базы (она пишется в этом же шаге), иначе другая вкладка перечитает ещё старую базу
  setTimeout(() => {
    try { localStorage.setItem(EVENT_KEY, JSON.stringify(event)); } catch {}
    deliver(event);
  }, 0);
}

window.addEventListener("storage", (e) => {
  if (e.key !== EVENT_KEY || !e.newValue) return;
  try { deliver(JSON.parse(e.newValue)); } catch {}
});

/* ---------- Заказы: те же правила, что у триггеров в supabase-*.sql ---------- */
const ST = { new: "Новый", awaiting_payment: "Ждёт оплаты", paid: "Оплачен", delivered: "Вручён", cancelled: "Отказ",
  return_requested: "Возврат запрошен", return_approved: "Возврат одобрен", returned: "Возврат вручён" };

function stockApply(db, items, sign) {
  const stock = db.catalog_state.data?.stock;
  if (!stock || !Array.isArray(items)) return;
  let changed = false;
  for (const l of items) {
    const qty = stock[l.id]?.qty;
    const key = `${l.color}|${l.size}`;
    if (!qty || qty[key] == null) continue;
    qty[key] = Math.max(0, (Number(qty[key]) || 0) + sign * Math.max(Number(l.qty) || 1, 0));
    changed = true;
  }
  if (changed) db.catalog_state.version++;
}

function addEvent(db, orderId, actor, body) {
  db.order_events.push({ id: ++db.seq.order_events, order_id: orderId, at: nowIso(), actor: actor || null, body });
}

/** Меняет заказ и делает всё, что в базе делают триггеры: кто принял, себестоимость, склад, история, уведомления */
function updateOrder(db, ctx, row, patch) {
  const old = { ...row };
  Object.assign(row, patch);
  const me = ctx.staff;
  if (row.status !== old.status) {
    if (old.status === "new" && row.status === "awaiting_payment") {
      Object.assign(row, { accepted_at: nowIso(), accepted_by: me?.full_name || null, accepted_by_id: me?.id || null });
    }
    if (row.status === "delivered" && old.status === "paid") {
      row.delivered_at ||= nowIso();
      row.delivered_by ||= me?.full_name || null;
    }
    if (row.status === "paid" && row.cost_total == null) row.cost_total = itemsCost(db, row.items);
    if (row.status === "cancelled" && old.stock_reserved) { stockApply(db, row.items, 1); row.stock_reserved = false; }
    if (row.status === "returned" && row.restocked) { stockApply(db, row.items, 1); row.stock_reserved = false; }
    // запись в историю — как orders_log_events
    const actor = ctx.actor;
    const quote = (t) => (String(t || "").trim() ? `: «${String(t).trim()}»` : "");
    const body = row.status === "awaiting_payment" && old.status === "new"
      ? (actor ? "Принят, покупателю отправлены реквизиты для оплаты" : "Принят автоматически, покупателю отправлены реквизиты для оплаты")
      : row.status === "cancelled" ? "Отказ" + quote(row.manager_note)
      : row.status === "paid" ? `Оплачен${row.payment_method ? " " + WAY[row.payment_method] : ""}${row.paid_amount != null ? ": " + rub(row.paid_amount) : ""}`
      : row.status === "delivered" && ["return_requested", "return_approved"].includes(old.status) ? "В возврате отказано" + quote(row.return_declined)
      : row.status === "delivered" ? "Вручён покупателю"
      : row.status === "return_requested" ? "Покупатель запросил возврат" + quote(row.return_request_reason)
      : row.status === "return_approved" ? `Возврат одобрен${quote(row.return_reason)}. Вернём ${rub(row.return_amount)}${row.return_method ? " " + WAY[row.return_method] : ""}, ждём вещь`
      : row.status === "returned" ? `Возврат вручён${quote(row.return_reason)}. Вернули ${rub(row.refund_amount)}${row.refund_method ? " " + WAY[row.refund_method] : ""}`
        + (row.restocked ? ", товар вернулся на склад" : ", товар не возвращается на склад")
      : `Статус: ${ST[old.status] || old.status} → ${ST[row.status] || row.status}`;
    addEvent(db, row.id, actor, body);
  }
  notify([STAFF_TOPIC, userTopic(row.user_id)], { id: row.id, op: "update" });
  return row;
}

function insertOrder(db, ctx, values) {
  const items = Array.isArray(values.items) ? values.items : [];
  const row = {
    id: ++db.seq.orders, created_at: nowIso(), user_id: ctx.me, username: null, status: "new", items,
    total: Number(values.total) || 0, customer_name: values.customer_name || "", phone: values.phone || "",
    delivery_way: values.delivery_way || "", address: values.address || null, payment_details: null, manager_note: null,
    payment_method: null, paid_amount: null, paid_at: null, paid_by: null, paid_by_id: null,
    accepted_by: null, accepted_by_id: null, accepted_at: null, delivered_at: null, delivered_by: null,
    return_request_reason: null, return_requested_at: null, return_declined: null, return_reason: null,
    return_amount: null, return_method: null, return_approved_at: null, return_approved_by: null,
    returned_at: null, returned_by: null, refund_amount: null, refund_method: null, restocked: false,
    cost_total: null, stock_reserved: true,
  };
  stockApply(db, items, -1);
  db.orders.push(row);
  addEvent(db, row.id, ctx.staffSide ? ctx.actor : "Покупатель", "Заказ оформлен на " + rub(row.total));
  notify([STAFF_TOPIC, userTopic(row.user_id)], { id: row.id, op: "insert" });
  if (!ctx.staffSide) autoAccept(db, ctx, row);
  return row;
}

/** Как триггер orders_auto_accept (supabase-auto-accept.sql): заказ принимается сам, способ оплаты покупатель выбрал при оформлении.
    Наличные и оплата при получении — сразу текст, онлайн — сразу ссылка на оплату. Менеджер в этом не участвует. */
const OFFLINE_PAY = { cash: "Оплата наличными при самовывозе", cod: "Оплата при получении. Возврат платный" };
function autoAccept(db, ctx, row) {
  const way = /оплата наличными/.test(row.delivery_way) ? "cash" : /оплата при получении/.test(row.delivery_way) ? "cod" : "online";
  updateOrder(db, { ...ctx, staff: null, actor: null }, row, { status: "awaiting_payment", payment_details: way === "online" ? payUrl(row.id) : OFFLINE_PAY[way] });
}

/* ---------- Таблицы и представления для from() ---------- */
function tableRows(db, table) {
  const archived = new Map(db.order_archive.map((a) => [a.order_id, a.archived_at]));
  switch (table) {
    case "orders": return db.orders;
    case "orders_active": return db.orders.filter((o) => !archived.has(o.id));
    case "orders_archived": return db.orders.filter((o) => archived.has(o.id)).map((o) => ({ ...o, archived_at: archived.get(o.id) }));
    case "order_archive": return db.order_archive;
    case "order_messages": return db.order_messages;
    case "catalog_state": return [{ id: 1, ...db.catalog_state }];
    case "order_chat_summary": {
      const by = new Map();
      for (const m of db.order_messages) {
        const s = by.get(m.order_id) || { order_id: m.order_id, total: 0, last_staff: 0, last_customer: 0 };
        s.total++;
        if (m.from_staff) s.last_staff = Math.max(s.last_staff, m.id); else s.last_customer = Math.max(s.last_customer, m.id);
        by.set(m.order_id, s);
      }
      return [...by.values()];
    }
    default: return null;
  }
}

const err = (message, code = "P0001") => ({ data: null, error: { message, code }, status: 400 });
const same = (a, b) => String(a) === String(b);

class Query {
  constructor(client, table) {
    Object.assign(this, { client, table, op: "select", filters: [], sort: null, max: null, mode: null, cols: "*", returning: false });
  }
  select(cols = "*", opts = {}) {
    if (this.op === "select") { this.cols = cols; this.opts = opts; } else { this.returning = true; this.cols = cols; }
    return this;
  }
  insert(values) { this.op = "insert"; this.values = values; return this; }
  upsert(values, opts = {}) { this.op = "upsert"; this.values = values; this.opts = opts; return this; }
  update(patch) { this.op = "update"; this.patch = patch; return this; }
  delete() { this.op = "delete"; return this; }
  eq(col, value) { this.filters.push((r) => same(r[col], value)); return this; }
  in(col, values) { const set = new Set(values.map(String)); this.filters.push((r) => set.has(String(r[col]))); return this; }
  order(col, { ascending = true } = {}) { this.sort = { col, ascending }; return this; }
  limit(n) { this.max = n; return this; }
  single() { this.mode = "single"; return this; }
  maybeSingle() { this.mode = "maybe"; return this; }
  then(resolve, reject) {
    return new Promise((r) => setTimeout(r, 0)).then(() => this.run()).then(resolve, reject);
  }

  project(rows) {
    if (!this.cols || this.cols === "*") return rows.map(clone);
    const keys = this.cols.split(",").map((s) => s.trim()).filter(Boolean);
    return rows.map((r) => Object.fromEntries(keys.map((k) => [k, clone(r[k] ?? null)])));
  }

  finish(rows, count) {
    let data = this.project(rows);
    if (this.mode) {
      if (data.length > 1 || (this.mode === "single" && !data.length)) return err("JSON object requested, multiple (or no) rows returned", "PGRST116");
      data = data[0] ?? null;
    }
    return { data, error: null, status: 200, count };
  }

  run() {
    const db = readDb();
    const ctx = this.client.context(db);
    const match = (r) => this.filters.every((f) => f(r));
    const rows = tableRows(db, this.table);
    if (!rows) return err(`relation "${this.table}" does not exist`, "42P01");

    if (this.op === "select") {
      let list = rows.filter(match);
      if (this.table === "orders" && !ctx.staffSide) list = list.filter((o) => same(o.user_id, ctx.me)); // RLS: покупатель видит свои
      if (this.sort) {
        const { col, ascending } = this.sort;
        list = [...list].sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (ascending ? 1 : -1));
      }
      const count = list.length;
      if (this.max != null) list = list.slice(0, this.max);
      if (this.opts?.head) return { data: null, error: null, status: 200, count };
      return this.finish(list, count);
    }

    const values = Array.isArray(this.values) ? this.values : this.values ? [this.values] : [];
    let changed = [];
    if (this.table === "orders" && this.op === "insert") {
      changed = values.map((v) => insertOrder(db, ctx, v));
    } else if (this.table === "orders" && this.op === "update") {
      if (!ctx.staff) return err("permission denied for table orders", "42501");
      changed = db.orders.filter(match).map((r) => updateOrder(db, ctx, r, this.patch));
    } else if (this.table === "order_archive" && (this.op === "upsert" || this.op === "insert")) {
      if (!ctx.staff) return err("permission denied for table order_archive", "42501");
      for (const v of values) {
        const id = Number(v.order_id);
        if (db.order_archive.some((a) => a.order_id === id)) continue;
        db.order_archive.push({ order_id: id, archived_at: nowIso() });
        addEvent(db, id, ctx.actor, "Скрыт из списка заказов");
      }
    } else if (this.table === "order_archive" && this.op === "delete") {
      const removed = db.order_archive.filter(match);
      db.order_archive = db.order_archive.filter((a) => !match(a));
      removed.forEach((a) => addEvent(db, a.order_id, ctx.actor, "Возвращён в список заказов"));
    } else if (this.table === "order_messages" && this.op === "insert") {
      for (const v of values) {
        const o = db.orders.find((x) => same(x.id, v.order_id));
        if (!o) return err("chat:denied", "42501");
        if (!OPEN_CHAT.includes(o.status)) return err("chat:closed", "42501");
        if (v.file_data && db.order_messages.filter((m) => m.order_id === o.id && m.file_data).length >= 20) return err("chat:too_many_files", "42501");
        const fromStaff = ctx.staffSide; // со страницы сотрудников пишет менеджер, из магазина — покупатель
        const row = { id: ++db.seq.order_messages, order_id: o.id, user_id: fromStaff ? null : ctx.me, from_staff: fromStaff,
          body: v.body || null, file_name: v.file_data ? v.file_name : null, file_type: v.file_data ? v.file_type : null,
          file_size: v.file_data ? Math.round(v.file_data.length * 3 / 4) : null, file_data: v.file_data || null, created_at: nowIso() };
        db.order_messages.push(row);
        db.order_archive = db.order_archive.filter((a) => a.order_id !== o.id); // сообщение возвращает заказ в список
        changed.push(row);
        notify([STAFF_TOPIC, userTopic(o.user_id)], { id: o.id, op: "message", staff: fromStaff });
      }
    } else {
      return err(`permission denied for table ${this.table}`, "42501");
    }
    try { writeDb(db); } catch {}
    if (this.op === "update" && this.table === "orders") return this.finish(changed);
    return this.returning ? this.finish(changed) : { data: null, error: null, status: 201 };
  }
}

/* ---------- Функции базы (rpc) ---------- */
class RpcError { constructor(reason, code = "P0001") { this.message = reason; this.code = code; } }
const fail = (reason, code) => { throw new RpcError(reason, code); };
const needStaff = (ctx) => ctx.staff || fail("staff:forbidden", "42501");
const needAdmin = (ctx) => (ctx.staff?.role === "admin" ? ctx.staff : fail("staff:forbidden", "42501"));
const findOrder = (db, id) => db.orders.find((o) => same(o.id, id));
const sourceOf = (db, uid) => db.customer_sources[uid] ?? null;

const reviewJson = (r, staff) => ({
  id: r.id, product: r.product_id, author: r.author, rating: r.rating, body: r.body, at: r.created_at,
  edited: new Date(r.updated_at) - new Date(r.created_at) > 60e3, reply: r.reply, reply_at: r.reply_at,
  ...(staff ? { hidden: r.hidden, hidden_by: r.hidden_by, reply_by: r.reply_by, user_id: r.user_id } : {}),
});
const reviewAllowed = (db, uid, product) => db.orders.some((o) => same(o.user_id, uid)
  && ["delivered", "return_requested", "returned"].includes(o.status) && o.items.some((i) => same(i.id, product)));

const taskJson = (t, me) => ({ id: t.id, title: t.title, due: t.due_at, customer_id: t.customer_id, customer: t.customer_name,
  order_id: t.order_id, assignee_id: t.assignee_id, assignee: t.assignee_name, created_by: t.created_by,
  done_at: t.done_at, done_by: t.done_by, mine: t.assignee_id === me.id, can_delete: t.created_by_id === me.id || me.role === "admin" });

function returnAmountOk(o, amount) {
  return amount != null && amount >= 0 && amount <= Math.max(Number(o.paid_amount ?? o.total) || 0, 0);
}

const RPC = {
  tg_login: (a, ctx) => ({ telegram_id: ctx.me, username: null, role: ctx.staff ? (ctx.staff.role === "admin" ? "admin" : "manager") : "user", topic: userTopic(ctx.me) }),

  /* --- вход сотрудников (supabase-staff.sql). В демо подходит любой пароль. --- */
  staff_login: (a, ctx, db) => {
    const login = String(a.p_login || "").trim().toLowerCase();
    if (!login || !a.p_password) return { error: "bad_credentials" };
    const acc = db.staff_accounts.find((s) => s.login === login) || db.staff_accounts.find((s) => s.role === "admin");
    if (!acc) return { error: "bad_credentials" };
    return { token: `demo-${acc.id}`, name: acc.full_name, login: acc.login, role: acc.role, staff_topic: STAFF_TOPIC };
  },
  staff_me: (a, ctx) => (ctx.staff ? { name: ctx.staff.full_name, login: ctx.staff.login, role: ctx.staff.role, staff_topic: STAFF_TOPIC } : null),
  staff_logout: () => null,
  staff_list: (a, ctx, db) => {
    const me = needAdmin(ctx);
    return [...db.staff_accounts].sort((x, y) => x.role.localeCompare(y.role) || x.full_name.localeCompare(y.full_name, "ru"))
      .map((s) => ({ id: s.id, name: s.full_name, login: s.login, role: s.role, me: s.id === me.id }));
  },
  staff_save: (a, ctx, db) => {
    needAdmin(ctx);
    const name = String(a.p_name || "").trim(), login = String(a.p_login || "").trim().toLowerCase(), password = a.p_password || "";
    if (name.length < 2 || name.length > 80) fail("staff:bad_name", "22023");
    if (!/^[a-z0-9._-]{3,32}$/.test(login)) fail("staff:bad_login", "22023");
    if (password && password.length < 8) fail("staff:short_password", "22023");
    if (db.staff_accounts.some((s) => s.login === login && !same(s.id, a.p_id))) fail("staff:login_taken", "23505");
    if (a.p_id == null) {
      if (!password) fail("staff:short_password", "22023");
      db.staff_accounts.push({ id: ++db.seq.staff_accounts, login, full_name: name, role: "manager", telegram_id: null });
    } else {
      const acc = db.staff_accounts.find((s) => same(s.id, a.p_id));
      if (acc) Object.assign(acc, { full_name: name, login });
    }
    return null;
  },
  staff_delete: (a, ctx, db) => {
    const me = needAdmin(ctx);
    if (same(a.p_id, me.id)) fail("staff:self", "42501");
    db.staff_accounts = db.staff_accounts.filter((s) => !same(s.id, a.p_id));
    return null;
  },

  /* --- оплаты и аналитика (supabase-payments.sql, supabase-crm.sql) --- */
  order_mark_paid: (a, ctx, db) => {
    const me = needStaff(ctx);
    if (!["cash", "card"].includes(a.p_method)) fail("staff:bad_method", "22023");
    const amount = Number(a.p_amount);
    if (!(amount > 0) || amount > 1e8) fail("staff:bad_amount", "22023");
    const o = findOrder(db, a.p_id);
    if (!o || o.status !== "awaiting_payment") fail("staff:conflict", "40001");
    return clone(updateOrder(db, ctx, o, { status: "paid", payment_method: a.p_method, paid_amount: Math.round(amount * 100) / 100,
      paid_at: nowIso(), paid_by: me.full_name, paid_by_id: me.id }));
  },
  /* --- онлайн-оплата (вместо Stripe и функции online-pay — страница демо-оплаты pay.html) --- */
  demo_pay_order: (a, ctx, db) => {
    const o = findOrder(db, a.p_id);
    if (!o) fail("pay:not_found", "42501");
    return { id: o.id, total: o.total, status: o.status };
  },
  // Как online_pay_confirm: оплачен уже (или отменён) — ничего не меняем и возвращаем false
  demo_pay_confirm: (a, ctx, db) => {
    const o = findOrder(db, a.p_id);
    if (!o || o.status !== "awaiting_payment") return false;
    updateOrder(db, ctx, o, { status: "paid", payment_method: "card", paid_amount: Number(o.total) || 0, paid_at: nowIso(),
      paid_by: "Онлайн-оплата (тест)", paid_by_id: null, online_pay_test: true, online_pay_id: a.p_pay_id || null });
    return true;
  },
  payments_stats: (a, ctx, db) => {
    needAdmin(ctx);
    const paid = db.orders.filter((o) => o.paid_at && inRange(o.paid_at, a.p_from, a.p_to));
    const sum = (list) => list.reduce((s, o) => s + (Number(o.paid_amount) || 0), 0);
    const days = new Map();
    for (const o of paid) {
      const d = moscowDay(o.paid_at), x = days.get(d) || { day: d, cash: 0, card: 0, count: 0 };
      x[o.payment_method] += Number(o.paid_amount) || 0;
      x.count++;
      days.set(d, x);
    }
    const managers = new Map();
    for (const o of db.orders) {
      const name = o.accepted_by || o.paid_by;
      if (!name) continue;
      const acceptedIn = inRange(o.accepted_at, a.p_from, a.p_to), paidIn = inRange(o.paid_at, a.p_from, a.p_to);
      if (!acceptedIn && !paidIn) continue;
      const m = managers.get(name) || { name, orders: 0, paid: 0, sales: 0 };
      if (acceptedIn) m.orders++;
      if (paidIn) { m.paid++; m.sales += Number(o.paid_amount) || 0; }
      managers.set(name, m);
    }
    const cash = paid.filter((o) => o.payment_method === "cash"), card = paid.filter((o) => o.payment_method === "card");
    return { cash_sum: sum(cash), cash_count: cash.length, card_sum: sum(card), card_count: card.length,
      days: [...days.values()].sort((x, y) => y.day.localeCompare(x.day)),
      managers: [...managers.values()].sort((x, y) => y.sales - x.sales || y.orders - x.orders) };
  },
  analytics_orders: (a, ctx, db) => {
    needAdmin(ctx);
    const when = (o) => o.accepted_at || o.paid_at;
    return db.orders.filter((o) => (o.accepted_by || o.paid_by) && inRange(when(o), a.p_from, a.p_to))
      .sort((x, y) => when(y).localeCompare(when(x))).slice(0, 2000)
      .map((o) => ({ id: o.id, at: when(o), status: o.status, total: o.total, customer: o.customer_name, manager: o.accepted_by || o.paid_by,
        method: o.payment_method, paid: o.paid_amount, paid_at: o.paid_at, refund: o.refund_amount, restocked: o.restocked,
        return_reason: o.return_reason, cost: o.cost_total ?? itemsCost(db, o.items), source: sourceOf(db, o.user_id) }));
  },
  export_orders: (a, ctx, db) => {
    needAdmin(ctx);
    return db.orders.filter((o) => inRange(o.created_at, a.p_from, a.p_to)).sort((x, y) => x.id - y.id)
      .map((o) => ({ id: o.id, created_at: o.created_at, status: o.status, customer: o.customer_name, phone: o.phone, user_id: o.user_id,
        way: o.delivery_way, addr: o.address, items: clone(o.items), total: o.total, manager: o.accepted_by || o.paid_by,
        accepted_at: o.accepted_at, method: o.payment_method, paid: o.paid_amount, paid_at: o.paid_at, delivered_at: o.delivered_at,
        cost: o.cost_total ?? itemsCost(db, o.items), refund: o.refund_amount, refund_method: o.refund_method, returned_at: o.returned_at,
        restocked: o.restocked, return_reason: o.return_reason || o.return_request_reason, source: sourceOf(db, o.user_id) }));
  },

  /* --- история заказа и возвраты (supabase-crm.sql) --- */
  order_history: (a, ctx, db) => {
    needStaff(ctx);
    return db.order_events.filter((e) => same(e.order_id, a.p_id)).sort((x, y) => x.at.localeCompare(y.at) || x.id - y.id)
      .map((e) => ({ at: e.at, actor: e.actor, body: e.body }));
  },
  order_return_request: (a, ctx, db) => {
    const o = findOrder(db, a.p_id);
    if (!o || !same(o.user_id, ctx.me)) fail("staff:forbidden", "42501");
    const reason = String(a.p_reason || "").trim();
    if (reason.length < 3) fail("staff:empty", "22023");
    if (o.status !== "delivered") fail("staff:conflict", "40001");
    if (o.return_declined) fail("staff:return_declined", "42501");
    const since = new Date(o.delivered_at || o.paid_at || o.created_at).getTime();
    if (Date.now() > since + (/^брак/i.test(reason) ? 180 : 15) * 864e5) fail("staff:return_expired", "42501");
    updateOrder(db, { ...ctx, actor: "Покупатель" }, o, { status: "return_requested", return_request_reason: reason.slice(0, 1000), return_requested_at: nowIso() });
    return null;
  },
  order_return: (a, ctx, db) => {
    const me = needStaff(ctx);
    if (String(a.p_reason || "").trim().length < 3) fail("staff:empty", "22023");
    if (!["cash", "card"].includes(a.p_method)) fail("staff:bad_method", "22023");
    const o = findOrder(db, a.p_id);
    if (!o || !["paid", "delivered", "return_requested"].includes(o.status)) fail("staff:conflict", "40001");
    if (!returnAmountOk(o, a.p_amount)) fail("staff:bad_amount", "22023");
    updateOrder(db, ctx, o, { status: "returned", return_reason: String(a.p_reason).trim(), returned_at: nowIso(), returned_by: me.full_name,
      refund_amount: Number(a.p_amount), refund_method: a.p_method, restocked: Boolean(a.p_restock) });
    return null;
  },
  order_return_approve: (a, ctx, db) => {
    const me = needStaff(ctx);
    if (String(a.p_reason || "").trim().length < 3) fail("staff:empty", "22023");
    if (!["cash", "card"].includes(a.p_method)) fail("staff:bad_method", "22023");
    const o = findOrder(db, a.p_id);
    if (!o || !["paid", "delivered", "return_requested", "return_approved"].includes(o.status)) fail("staff:conflict", "40001");
    if (!returnAmountOk(o, a.p_amount)) fail("staff:bad_amount", "22023");
    updateOrder(db, ctx, o, { status: "return_approved", return_reason: String(a.p_reason).trim(), return_amount: Number(a.p_amount),
      return_method: a.p_method, return_approved_at: nowIso(), return_approved_by: me.full_name });
    return null;
  },
  order_return_done: (a, ctx, db) => {
    const me = needStaff(ctx);
    const o = findOrder(db, a.p_id);
    if (!o || o.status !== "return_approved") fail("staff:conflict", "40001");
    updateOrder(db, ctx, o, { status: "returned", returned_at: nowIso(), returned_by: me.full_name,
      refund_amount: o.return_amount, refund_method: o.return_method, restocked: Boolean(a.p_restock) });
    return null;
  },
  order_return_decline: (a, ctx, db) => {
    needStaff(ctx);
    const text = String(a.p_message || "").trim();
    if (text.length < 3) fail("staff:empty", "22023");
    const o = findOrder(db, a.p_id);
    if (!o || !["return_requested", "return_approved"].includes(o.status)) fail("staff:conflict", "40001");
    updateOrder(db, ctx, o, { status: "delivered", return_declined: text.slice(0, 1000), return_amount: null, return_method: null,
      return_approved_at: null, return_approved_by: null });
    return null;
  },

  /* --- закупочные цены и источник клиента --- */
  product_costs_get: (a, ctx, db) => { needStaff(ctx); return clone(db.product_costs); },
  product_cost_set: (a, ctx, db) => {
    needStaff(ctx);
    const cost = Number(a.p_cost);
    if (!(cost > 0)) delete db.product_costs[String(a.p_id)];
    else if (cost > 1e8) fail("staff:bad_amount", "22023");
    else db.product_costs[String(a.p_id)] = Math.round(cost * 100) / 100;
    return null;
  },
  customer_source_answer: (a, ctx, db) => {
    const s = String(a.p_source || "").trim();
    if (s && db.customer_sources[ctx.me] == null) db.customer_sources[ctx.me] = s.slice(0, 80);
    return null;
  },
  customer_source_set: (a, ctx, db) => {
    needStaff(ctx);
    const s = String(a.p_source || "").trim();
    if (!s) delete db.customer_sources[a.p_user_id]; else db.customer_sources[a.p_user_id] = s.slice(0, 80);
    return null;
  },

  /* --- клиенты (supabase-customers.sql + supabase-crm.sql) --- */
  customers_list: (a, ctx, db) => {
    needStaff(ctx);
    const groups = new Map();
    for (const o of [...db.orders].sort((x, y) => y.id - x.id)) {
      if (o.user_id == null) continue;
      if (!groups.has(o.user_id)) groups.set(o.user_id, []);
      groups.get(o.user_id).push(o);
    }
    return [...groups.entries()].map(([uid, list]) => ({
      id: uid, name: list[0].customer_name, phone: list.find((o) => o.phone)?.phone ?? null, username: null,
      orders: list.length,
      bought: list.filter((o) => ["paid", "delivered", "return_requested", "return_approved"].includes(o.status)).length,
      returns: list.filter((o) => o.status === "returned").length,
      spent: list.filter((o) => SOLD.includes(o.status)).reduce((s, o) => s + (Number(o.paid_amount ?? o.total) || 0) - (Number(o.refund_amount) || 0), 0),
      first_at: list.map((o) => o.created_at).sort()[0], last_at: list.map((o) => o.created_at).sort().pop(),
      source: sourceOf(db, uid), tags: db.customer_tags[uid] || [], notes: db.customer_notes.filter((n) => same(n.user_id, uid)).length,
    })).sort((x, y) => y.last_at.localeCompare(x.last_at));
  },
  customer_card: (a, ctx, db) => {
    needStaff(ctx);
    const uid = a.p_user_id;
    return {
      orders: db.orders.filter((o) => same(o.user_id, uid)).sort((x, y) => y.id - x.id).map((o) => ({
        id: o.id, at: o.created_at, status: o.status, total: o.total, items: clone(o.items), name: o.customer_name, phone: o.phone,
        way: o.delivery_way, addr: o.address, paid: o.paid_amount, method: o.payment_method, manager: o.accepted_by || o.paid_by, refund: o.refund_amount })),
      notes: db.customer_notes.filter((n) => same(n.user_id, uid)).sort((x, y) => y.id - x.id)
        .map((n) => ({ id: n.id, body: n.body, author: n.author, at: n.created_at })),
      tags: db.customer_tags[uid] || [],
      source: sourceOf(db, uid),
    };
  },
  customer_note_add: (a, ctx, db) => {
    const me = needStaff(ctx);
    const body = String(a.p_body || "").trim();
    if (!body) fail("staff:empty", "22023");
    db.customer_notes.push({ id: ++db.seq.customer_notes, user_id: Number(a.p_user_id), body: body.slice(0, 1000), author: me.full_name, author_id: me.id, created_at: nowIso() });
    return null;
  },
  customer_note_delete: (a, ctx, db) => {
    const me = needStaff(ctx);
    const n = db.customer_notes.find((x) => same(x.id, a.p_id));
    if (!n || (n.author_id !== me.id && me.role !== "admin")) fail("staff:forbidden", "42501");
    db.customer_notes = db.customer_notes.filter((x) => x !== n);
    return null;
  },
  customer_tags_set: (a, ctx, db) => {
    needStaff(ctx);
    db.customer_tags[a.p_user_id] = [...new Set((a.p_tags || []).map((t) => String(t).trim().slice(0, 30)).filter(Boolean))];
    return null;
  },

  /* --- задачи (supabase-tasks.sql) --- */
  tasks_list: (a, ctx, db) => {
    const me = needStaff(ctx);
    const fresh = Date.now() - 14 * 864e5;
    return db.staff_tasks.filter((t) => (a.p_customer == null || same(t.customer_id, a.p_customer))
        && (a.p_customer != null || (a.p_all && me.role === "admin") || t.assignee_id === me.id || t.created_by_id === me.id)
        && (!t.done_at || new Date(t.done_at).getTime() > fresh))
      .sort((x, y) => Number(Boolean(x.done_at)) - Number(Boolean(y.done_at)) || x.due_at.localeCompare(y.due_at))
      .map((t) => taskJson(t, me));
  },
  tasks_staff: (a, ctx, db) => {
    const me = needStaff(ctx);
    return { me: me.id, telegram: Boolean(me.telegram_id),
      staff: [...db.staff_accounts].sort((x, y) => x.full_name.localeCompare(y.full_name, "ru")).map((s) => ({ id: s.id, name: s.full_name })) };
  },
  task_save: (a, ctx, db) => {
    const me = needStaff(ctx);
    const title = String(a.p_title || "").trim();
    if (!title) fail("staff:empty", "22023");
    if (!a.p_due) fail("staff:no_due", "22023");
    const who = db.staff_accounts.find((s) => same(s.id, a.p_assignee ?? me.id));
    if (!who) fail("staff:no_assignee", "22023");
    const due = new Date(a.p_due).toISOString();
    let t;
    if (a.p_id == null) {
      t = { id: ++db.seq.staff_tasks, title: title.slice(0, 500), due_at: due, customer_id: a.p_customer ?? null,
        customer_name: String(a.p_customer_name || "").trim() || null, order_id: a.p_order ?? null, assignee_id: who.id, assignee_name: who.full_name,
        created_by_id: me.id, created_by: me.full_name, created_at: nowIso(), done_at: null, done_by: null };
      db.staff_tasks.push(t);
    } else {
      t = db.staff_tasks.find((x) => same(x.id, a.p_id) && (x.assignee_id === me.id || x.created_by_id === me.id || me.role === "admin"));
      if (!t) fail("staff:forbidden", "42501");
      Object.assign(t, { title: title.slice(0, 500), due_at: due, assignee_id: who.id, assignee_name: who.full_name });
    }
    return taskJson(t, me);
  },
  task_done: (a, ctx, db) => {
    const me = needStaff(ctx);
    const t = db.staff_tasks.find((x) => same(x.id, a.p_id) && (x.assignee_id === me.id || x.created_by_id === me.id || me.role === "admin"));
    if (!t) fail("staff:forbidden", "42501");
    Object.assign(t, { done_at: a.p_done ? nowIso() : null, done_by: a.p_done ? me.full_name : null });
    return null;
  },
  task_delete: (a, ctx, db) => {
    const me = needStaff(ctx);
    const t = db.staff_tasks.find((x) => same(x.id, a.p_id) && (x.created_by_id === me.id || me.role === "admin"));
    if (!t) fail("staff:forbidden", "42501");
    db.staff_tasks = db.staff_tasks.filter((x) => x !== t);
    return null;
  },
  staff_link_telegram: () => fail("staff:demo", "22023"), // напоминания в Telegram в демо недоступны
  staff_unlink_telegram: (a, ctx) => { needStaff(ctx); return null; },

  /* --- отзывы (supabase-reviews.sql) --- */
  reviews_summary: (a, ctx, db) => {
    const by = {};
    for (const r of db.product_reviews.filter((x) => !x.hidden)) (by[r.product_id] ||= []).push(r.rating);
    return Object.fromEntries(Object.entries(by).map(([id, list]) =>
      [id, { avg: Math.round((list.reduce((s, n) => s + n, 0) / list.length) * 10) / 10, count: list.length }]));
  },
  product_reviews_get: (a, ctx, db) => {
    const staff = ctx.staffSide;
    const mine = db.product_reviews.find((r) => same(r.product_id, a.p_product) && same(r.user_id, ctx.me));
    return {
      reviews: db.product_reviews.filter((r) => same(r.product_id, a.p_product) && (staff || !r.hidden))
        .sort((x, y) => y.created_at.localeCompare(x.created_at)).map((r) => reviewJson(r, staff)),
      can_review: reviewAllowed(db, ctx.me, a.p_product),
      mine: mine ? { ...reviewJson(mine, false), hidden: mine.hidden } : null,
    };
  },
  my_reviews: (a, ctx, db) => Object.fromEntries(db.product_reviews.filter((r) => same(r.user_id, ctx.me)).map((r) => [String(r.product_id), r.rating])),
  review_save: (a, ctx, db) => {
    if (!reviewAllowed(db, ctx.me, a.p_product)) fail("staff:not_bought", "42501");
    const rating = Number(a.p_rating);
    if (!(rating >= 1 && rating <= 5)) fail("staff:bad_rating", "22023");
    const fio = [...db.orders].filter((o) => same(o.user_id, ctx.me) && o.customer_name).sort((x, y) => y.created_at.localeCompare(x.created_at))[0]?.customer_name || "";
    const parts = fio.trim().split(/\s+/).filter(Boolean);
    const author = parts.length >= 2 ? `${parts[1]} ${parts[0][0]}.` : parts[0] || "Покупатель";
    const body = String(a.p_body || "").trim().slice(0, 1000);
    let r = db.product_reviews.find((x) => same(x.product_id, a.p_product) && same(x.user_id, ctx.me));
    if (r) Object.assign(r, { rating, body, author, updated_at: nowIso() });
    else {
      r = { id: ++db.seq.product_reviews, product_id: Number(a.p_product), user_id: ctx.me, author, rating, body, created_at: nowIso(), updated_at: nowIso(),
        hidden: false, hidden_by: null, reply: null, reply_by: null, reply_at: null };
      db.product_reviews.push(r);
    }
    return reviewJson(r, false);
  },
  review_delete: (a, ctx, db) => {
    const r = db.product_reviews.find((x) => same(x.id, a.p_id));
    const admin = ctx.staffSide && ctx.staff?.role === "admin";
    if (!r || (!admin && !same(r.user_id, ctx.me))) { if (admin) return null; fail("staff:forbidden", "42501"); }
    db.product_reviews = db.product_reviews.filter((x) => x !== r);
    return null;
  },
  reviews_list: (a, ctx, db) => {
    needStaff(ctx);
    return [...db.product_reviews].sort((x, y) => y.created_at.localeCompare(x.created_at)).slice(0, 500).map((r) => reviewJson(r, true));
  },
  review_hide: (a, ctx, db) => {
    const me = needStaff(ctx);
    const r = db.product_reviews.find((x) => same(x.id, a.p_id));
    if (r) Object.assign(r, { hidden: Boolean(a.p_hidden), hidden_by: a.p_hidden ? me.full_name : null });
    return null;
  },
  review_reply: (a, ctx, db) => {
    const me = needStaff(ctx);
    const text = String(a.p_text || "").trim().slice(0, 1000) || null;
    const r = db.product_reviews.find((x) => same(x.id, a.p_id));
    if (r) Object.assign(r, { reply: text, reply_by: text ? me.full_name : null, reply_at: text ? nowIso() : null });
    return null;
  },

  /* --- каталог (supabase-catalog.sql) --- */
  catalog_save: (a, ctx, db) => {
    if (!ctx.staff) fail("catalog:forbidden", "42501");
    if (!a.p_data || typeof a.p_data !== "object") fail("catalog:bad_data", "22023");
    if (a.p_version !== db.catalog_state.version) fail("catalog:conflict", "40001");
    db.catalog_state = { data: clone(a.p_data), version: db.catalog_state.version + 1 };
    return db.catalog_state.version;
  },
};

/* ---------- Фото товаров: вместо хранилища Supabase — уменьшенная копия прямо в данных (data URL) ---------- */
const uploads = new Map();
async function shrink(blob) {
  try {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, 900 / Math.max(bitmap.width, bitmap.height));
    const canvas = Object.assign(document.createElement("canvas"), { width: Math.round(bitmap.width * scale), height: Math.round(bitmap.height * scale) });
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.75);
  } catch {
    return new Promise((resolve) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => resolve(""); r.readAsDataURL(blob); });
  }
}
const demoStorage = {
  from: () => ({
    async upload(name, blob) {
      const url = await shrink(blob);
      if (!url) return { data: null, error: { message: "upload failed" } };
      uploads.set(name, url);
      return { data: { path: name }, error: null };
    },
    getPublicUrl: (name) => ({ data: { publicUrl: uploads.get(name) || "" } }),
    remove: async () => ({ data: [], error: null }),
  }),
};

/* ---------- Функция online-pay: create открывает настоящую тестовую страницу Stripe ----------
   Заказы демо хранятся в браузере, поэтому сумму функции передаём сами (demo_create). Stripe после оплаты
   возвращает на pay.html, та проверяет оплату (demo_check) и отмечает заказ оплаченным. */
const payUrl = (id) => new URL(`pay.html?order=${id}&sig=d${id}`, location.href).href;
const payError = (code) => ({ data: null, error: { name: "FunctionsHttpError", context: { json: async () => ({ error: code }) } } });

async function payInvoke(client, name, { action, order_id: id }) {
  await new Promise((r) => setTimeout(r, 0));
  if (name !== "online-pay") return payError("not_found");
  const db = readDb(), ctx = client.context(db), o = findOrder(db, id);
  if (action === "link") return ctx.staff ? { data: { url: payUrl(id) }, error: null } : payError("unauthorized");
  if (!o) return payError("not_found");
  if (action === "check") return { data: { paid: o.status === "paid", status: o.status === "paid" ? "complete" : "open" }, error: null };
  if (action !== "create") return payError("bad_request");
  if (o.status === "paid") return { data: { paid: true }, error: null };
  if (o.status !== "awaiting_payment") return payError("not_awaiting");
  return stripeSession(o);
}

/** Тестовая страница оплаты Stripe для демо-заказа */
async function stripeSession(o) {
  if (!DEMO_PAY_FUNCTION) return payError("not_configured");
  try {
    const response = await fetch(DEMO_PAY_FUNCTION, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "demo_create", order_id: o.id, amount: Number(o.total) }) });
    const data = await response.json().catch(() => ({}));
    if (response.ok && data.url) return { data: { url: data.url }, error: null };
    // bad_action — в Supabase ещё старая функция online-pay без демо-оплаты
    return payError(["bad_action", "bad_order", "not_configured"].includes(data.error) ? "not_configured" : data.error || "server");
  } catch { return payError("network"); }
}

/* ---------- Клиент с API supabase-js ---------- */
export function createDemoClient({ staffToken = "" } = {}) {
  const client = {
    /** Кто делает запрос: сотрудник по токену (только на странице сотрудников он действует как сотрудник) */
    context(db) {
      const token = String(staffToken || "");
      const id = token === "demo" ? 1 : Number(/^demo-(\d+)$/.exec(token)?.[1]);
      const staff = token ? db.staff_accounts.find((s) => s.id === id) || null : null;
      const staffSide = Boolean(staff) && document.documentElement.classList.contains("staff-mode");
      return { me: ME, staff, staffSide, actor: staffSide ? staff.full_name : "Покупатель" };
    },
    from: (table) => new Query(client, table),
    async rpc(name, args = {}) {
      await new Promise((r) => setTimeout(r, 0));
      const fn = RPC[name];
      if (!fn) return { data: null, error: { code: "PGRST202", message: `function ${name} not found` }, status: 404 };
      const db = readDb();
      const before = JSON.stringify(db);
      try {
        const data = fn(args || {}, client.context(db), db);
        // записываем, только если что-то изменилось: чтение не должно затирать заказ, только что оформленный в соседней вкладке
        if (JSON.stringify(db) !== before) writeDb(db);
        return { data: data === undefined ? null : clone(data), error: null, status: 200 };
      } catch (error) {
        if (error instanceof RpcError) return { data: null, error: { message: error.message, code: error.code }, status: 400 };
        console.warn("demo rpc", name, error);
        return { data: null, error: { message: "server", code: "XX000" }, status: 500 };
      }
    },
    channel(topic) {
      const handlers = [];
      return {
        on(type, filter, handler) { handlers.push(handler); return this; },
        subscribe(onStatus) {
          if (!listeners.has(topic)) listeners.set(topic, new Set());
          handlers.forEach((h) => listeners.get(topic).add(h));
          setTimeout(() => onStatus?.("SUBSCRIBED"), 0);
          return this;
        },
      };
    },
    storage: demoStorage,
    functions: { invoke: (name, { body } = {}) => payInvoke(client, name, body || {}) },
  };
  return client;
}

/* ---------- Полоса «Демо-версия» сверху страницы ---------- */
function initDemoBar() {
  const reset = document.getElementById("demoReset");
  if (reset) reset.onclick = () => {
    if (!reset.hasAttribute("data-armed")) {
      reset.setAttribute("data-armed", "");
      reset.textContent = "Точно сбросить?";
      setTimeout(() => { reset.removeAttribute("data-armed"); reset.textContent = "Сбросить демо"; }, 4000);
      return;
    }
    resetDemo();
    location.reload();
  };
  // Кнопки, которым нужен Telegram или сервер, в демо только объясняют это
  document.addEventListener("click", (e) => {
    const off = e.target.closest?.("[data-demo-off]");
    if (!off) return;
    e.preventDefault();
    toast("В демо-версии недоступно");
  }, true);
  // Заказ, оформленный в соседней вкладке, или сброс там же — перерисовываем
  window.addEventListener("storage", (e) => {
    if (e.key === EVENT_KEY && e.newValue && /"op":"reset"/.test(e.newValue)) location.reload();
  });
}
initDemoBar();
readDb();
// Реквизиты, которые подставятся в форму «Принять заказ»
if (!storage.get("temp_last_pay", "")) storage.set("temp_last_pay", PAY_TEXT); // первый запуск — заполняем демо-данными
