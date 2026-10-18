// Настройки сайта. Меняйте здесь, остальной код трогать не нужно.

// ДЕМО-ВЕРСИЯ: сервера и базы нет. Заказы, склад, клиенты и всё остальное хранятся только в браузере
// (localStorage), см. js/demo.js. Ключей, Telegram ID и логинов здесь нет.
export const DEMO = true;

// Сотрудники входят по ссылке …/crm.html. В демо посетитель сразу входит как директор.

// Адрес сервера магазина. В демо — пусто: сервера нет.
export const API_URL = "";

// Имя менеджера в Telegram без @. В демо не используется.
export const MANAGER_USERNAME = "";

// Репозиторий магазина "логин/репозиторий". В демо не используется.
export const GITHUB_REPO = "";

// Supabase. В демо пусто: вместо базы работает js/demo.js.
export const SUPABASE_URL = "";
export const SUPABASE_KEY = "";

// Имя директора в демо-данных
export const DEMO_DIRECTOR = "Директор";

// Онлайн-оплата картой. Кнопка «Оплатить картой онлайн» открывает страницу демо-оплаты (pay.html), а та —
// тестовую страницу Stripe через функцию online-pay магазина (карта 4242 4242 4242 4242, деньги не списываются).
// Функция не ответила — на pay.html можно оплатить и без карты, имитацией.
export const ONLINE_PAY = true;
export const ONLINE_PAY_TESTERS = [];
export const ONLINE_PAY_TEST = true;
// Функция online-pay магазина (действия demo_create и demo_check). Пусто — только имитация оплаты.
export const DEMO_PAY_FUNCTION = "https://ztcltngfpnhhuzyyqnfw.supabase.co/functions/v1/online-pay";
