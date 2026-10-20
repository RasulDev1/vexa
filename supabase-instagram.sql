-- =====================================================================
--  VEXA · магазин в директе Instagram: тот же сайт, те же заказы и та же CRM
--  Запускать ПОСЛЕДНИМ: после основного скрипта, supabase-chat.sql, supabase-bot.sql и supabase-crm.sql.
--  Supabase → SQL Editor → новая вкладка (New query) → вставить ЦЕЛИКОМ → Run.
--  Можно запускать повторно. Заказы, переписка и клиенты Telegram не меняются.
--
--  Как это работает:
--   • покупатель пишет в директ — функция instagram-bot заводит его в таблице ig_users под отрицательным ID
--     (−1, −2, …): так он не пересечётся с Telegram ID, а CRM видит, что клиент из Instagram;
--   • бот присылает личную ссылку на сайт (…/?ig=ключ). Сайт запоминает ключ и отправляет его в заголовке
--     X-Ig-Token, а tg_id() по нему узнаёт покупателя. Поэтому заказы, «Мои заказы», чат заказа и все правила
--     доступа работают для него так же, как для покупателя из Telegram;
--   • менеджер пишет в чате заказа, принимает заказ, отмечает оплату или возврат — база зовёт функцию
--     instagram-bot, и та пишет покупателю в директ.
-- =====================================================================

create extension if not exists pg_net;

-- ---------- 1. Покупатели из Instagram и их ссылки входа на сайт ----------
create sequence if not exists public.ig_user_seq;
create table if not exists public.ig_users (
  user_id         bigint primary key default -nextval('public.ig_user_seq'), -- как orders.user_id, но меньше нуля
  igsid           text not null unique,  -- ID покупателя, который Instagram присылает боту
  username        text,
  name            text,
  created_at      timestamptz not null default now(),
  last_message_at timestamptz
);
create table if not exists public.ig_logins (
  token        text primary key,
  user_id      bigint not null references public.ig_users (user_id) on delete cascade,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);
create index if not exists ig_logins_user_idx on public.ig_logins (user_id);

-- Секрет, которым база подписывает вызовы функции instagram-bot. Создаётся сам, вписывать ничего не нужно.
create table if not exists public.ig_settings (
  id          int primary key default 1 check (id = 1),
  hook_secret text not null default md5(gen_random_uuid()::text) || md5(gen_random_uuid()::text)
);
insert into public.ig_settings default values on conflict (id) do nothing;
-- Токен аккаунта Instagram, если его подключили по ссылке (функция получает и продлевает его сама)
alter table public.ig_settings add column if not exists access_token     text;
alter table public.ig_settings add column if not exists token_expires_at timestamptz;

-- Таблицы читает и меняет только функция instagram-bot (ключ service_role)
revoke all on public.ig_users, public.ig_logins, public.ig_settings from anon, authenticated;
grant all on public.ig_users, public.ig_logins, public.ig_settings to service_role;
grant usage on sequence public.ig_user_seq to service_role;
alter table public.ig_users enable row level security;
alter table public.ig_logins enable row level security;
alter table public.ig_settings enable row level security;

-- Покупатель из Instagram — такой же пользователь магазина, как из Telegram: без строки в users база не примет заказ
create or replace function public.ig_users_to_users()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.users (telegram_id, username, first_name)
  values (new.user_id, new.username, new.name)
  on conflict (telegram_id) do update set username = excluded.username, first_name = excluded.first_name;
  return null;
end $$;
drop trigger if exists ig_users_to_users on public.ig_users;
create trigger ig_users_to_users after insert or update of username, name on public.ig_users
  for each row execute function public.ig_users_to_users();
-- тем, кто уже написал боту
insert into public.users (telegram_id, username, first_name)
select user_id, username, name from public.ig_users
on conflict (telegram_id) do update set username = excluded.username, first_name = excluded.first_name;

-- ---------- 2. Кто покупатель: Telegram или ссылка из директа ----------
-- Нынешняя проверка подписи Telegram сохраняется под именем tg_id_telegram (один раз, при первом запуске).
do $$
begin
  if to_regprocedure('public.tg_id_telegram()') is null then
    if to_regprocedure('public.tg_id()') is null then
      raise exception 'В базе нет функции tg_id: сначала запустите основной скрипт настройки базы';
    end if;
    execute replace(pg_get_functiondef('public.tg_id()'::regprocedure), 'public.tg_id()', 'public.tg_id_telegram()');
  end if;
end $$;

-- Покупатель по ключу из заголовка X-Ig-Token; null — ключа нет или он не подходит
create or replace function public.ig_id()
returns bigint language sql stable security definer set search_path = '' as $$
  select l.user_id from public.ig_logins l
  where l.token = nullif(coalesce(nullif(current_setting('request.headers', true), ''), '{}')::json ->> 'x-ig-token', '')
$$;

-- Все правила доступа и функции магазина спрашивают tg_id(): теперь она понимает и покупателей из Instagram
create or replace function public.tg_id()
returns bigint language plpgsql stable security definer set search_path = '' as $$
declare ig bigint;
begin
  if coalesce(nullif(current_setting('request.headers', true), ''), '{}')::json ->> 'x-ig-token' is not null then
    ig := public.ig_id();
    if ig is null then raise exception 'tg:ig_expired' using errcode = '42501'; end if;
    return ig;
  end if;
  return public.tg_id_telegram();
end $$;

-- Вход на сайте по ссылке из директа — отвечает так же, как tg_login
create or replace function public.ig_login()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare me bigint := public.ig_id(); u public.ig_users;
begin
  if me is null then raise exception 'tg:ig_expired' using errcode = '42501'; end if;
  update public.ig_logins set last_used_at = now()
  where token = current_setting('request.headers', true)::json ->> 'x-ig-token';
  select * into u from public.ig_users where user_id = me;
  return jsonb_build_object('telegram_id', me, 'username', u.username, 'role', 'user', 'channel', 'instagram',
    'topic', public.realtime_topic('user', me));
end $$;
revoke execute on function public.ig_login() from public;
grant execute on function public.ig_login() to anon, authenticated;

-- ---------- 3. Заказ из Instagram: в CRM виден логин Instagram ----------
create or replace function public.orders_instagram_username()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.user_id < 0 then
    new.username := (select u.username from public.ig_users u where u.user_id = new.user_id);
  end if;
  return new;
end $$;
-- «zz» — срабатывает после основного триггера, который ставит user_id
drop trigger if exists orders_zz_instagram_username on public.orders;
create trigger orders_zz_instagram_username before insert on public.orders
  for each row execute function public.orders_instagram_username();

-- ---------- 4. Сообщение в чате заказа: покупатель на сайте, через бота (Telegram или Instagram) или сотрудник ----------
-- Как в supabase-crm.sql (чат открыт и во время возврата) плюс отправитель из бота (temp.bot_sender).
create or replace function public.order_messages_before_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  me bigint := nullif(current_setting('temp.bot_sender', true), '')::bigint;
  staff boolean := public.is_staff();
  o public.orders;
begin
  if me is null then
    begin me := public.tg_id(); exception when others then me := null; end;
  end if;
  select * into o from public.orders where id = new.order_id;
  if o.id is null or (me is null and not staff) then raise exception 'chat:denied' using errcode = '42501'; end if;
  if o.status not in ('awaiting_payment', 'paid', 'return_requested', 'return_approved') then raise exception 'chat:closed' using errcode = '42501'; end if;
  if not staff and (select count(*) from public.order_messages
      where user_id = me and created_at > now() - interval '10 minutes') >= 30 then
    raise exception 'chat:too_many' using errcode = '42501';
  end if;
  if new.file_data is not null and (select count(*) from public.order_messages
      where order_id = new.order_id and file_data is not null) >= 20 then
    raise exception 'chat:too_many_files' using errcode = '42501';
  end if;
  new.user_id    := me;
  new.from_staff := staff and (me is null or o.user_id <> me);
  new.file_size  := case when new.file_data is null then null else length(new.file_data) * 3 / 4 end;
  if new.file_data is null then new.file_name := null; new.file_type := null; end if;
  new.created_at := now();
  return new;
end $$;

-- ---------- 5. База → функция instagram-bot: она пишет покупателю в директ ----------
create or replace function public.ig_function_url()
returns text language sql immutable set search_path = '' as $$
  select 'https://ztcltngfpnhhuzyyqnfw.supabase.co/functions/v1/instagram-bot'
$$;

create or replace function public.ig_notify(p_body jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform net.http_post(
    url := public.ig_function_url(),
    body := p_body,
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-ig-hook', (select s.hook_secret from public.ig_settings s where s.id = 1)),
    timeout_milliseconds := 30000);
exception when others then null; -- бот не смог отправить — на сайте и в CRM всё равно всё есть
end $$;
revoke execute on function public.ig_notify(jsonb) from public, anon, authenticated;

-- Менеджер написал в чате заказа → покупателю в директ; его ответ в директе уйдёт в чат этого заказа
create or replace function public.order_messages_to_instagram()
returns trigger language plpgsql security definer set search_path = '' as $$
declare owner bigint;
begin
  if not new.from_staff then return null; end if;
  select user_id into owner from public.orders where id = new.order_id;
  if owner is null or owner >= 0 then return null; end if;
  insert into public.bot_chat_state (telegram_id, order_id) values (owner, new.order_id)
  on conflict (telegram_id) do update set order_id = excluded.order_id, updated_at = now();
  perform public.ig_notify(jsonb_build_object('message', new.id));
  return null;
end $$;
drop trigger if exists order_messages_to_instagram on public.order_messages;
create trigger order_messages_to_instagram after insert on public.order_messages
  for each row execute function public.order_messages_to_instagram();

-- Заказ принят (реквизиты), отказ, оплата, вручение, возврат → покупателю в директ
create or replace function public.orders_status_to_instagram()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.user_id is null or new.user_id >= 0 or new.status = old.status then return null; end if;
  if old.status = 'new' and new.status = 'awaiting_payment' then
    -- ответ покупателя (чек) уйдёт в чат этого заказа
    insert into public.bot_chat_state (telegram_id, order_id) values (new.user_id, new.id)
    on conflict (telegram_id) do update set order_id = excluded.order_id, updated_at = now();
  end if;
  perform public.ig_notify(jsonb_build_object('order', new.id, 'from', old.status));
  return null;
end $$;
drop trigger if exists orders_status_to_instagram on public.orders;
create trigger orders_status_to_instagram after update of status on public.orders
  for each row execute function public.orders_status_to_instagram();

notify pgrst, 'reload schema';

-- ---------- Проверка: всё должно быть «true» ----------
select exists (select 1 from pg_proc where proname = 'tg_id_telegram')          as "проверка Telegram сохранена",
       exists (select 1 from pg_proc where proname = 'ig_login')                as "вход по ссылке из директа готов",
       exists (select 1 from pg_trigger where tgname = 'orders_status_to_instagram') as "статусы заказа приходят в директ",
       exists (select 1 from public.ig_settings)                               as "секрет для бота создан",
       not exists (select 1 from public.ig_users i where not exists
         (select 1 from public.users u where u.telegram_id = i.user_id))      as "покупатели из Instagram могут оформить заказ";
