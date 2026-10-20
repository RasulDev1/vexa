-- =====================================================================
--  VEXA · онлайн-оплата прямо в окне магазина: заказ появляется только после оплаты
--  Запускать ПОСЛЕ supabase-online-pay.sql (и supabase-auto-accept.sql, если он уже запущен).
--  Supabase → SQL Editor → новая вкладка (New query) → вставить ЦЕЛИКОМ → Run.
--  Можно запускать повторно. Существующие заказы не меняются.
--
--  Как работает:
--   • покупатель выбрал оплату картой онлайн и нажал «Подтвердить заказ» → товар резервируется на 30 минут,
--     а в том же окне открывается форма оплаты Stripe. Заказа в базе и у менеджера ещё нет;
--   • оплата прошла → функция online-pay создаёт заказ сразу оплаченным, он появляется в CRM
--     и в «Мои заказы», бот пишет «Оплата получена»;
--   • не оплатил за 30 минут или закрыл окно с отменой → резерв снимается, заказа нет.
--  Если что-то не настроено (нет ключа Stripe), магазин сам откатывается на прежний порядок: заказ, потом ссылка.
-- =====================================================================

-- ---------- 1. Резерв под оплату ----------
create table if not exists public.held_orders (
  id            bigint generated always as identity primary key,
  user_id       bigint not null,                       -- как orders.user_id (у покупателя из Instagram меньше нуля)
  items         jsonb not null,
  total         numeric not null,
  customer_name text,
  phone         text,
  delivery_way  text,
  address       text,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default now() + interval '30 minutes',
  status        text not null default 'pending' check (status in ('pending', 'paid', 'expired', 'cancelled')),
  pay_id        text,                                  -- страница оплаты Stripe
  order_id      bigint                                 -- заказ, созданный после оплаты
);
create index if not exists held_orders_pending_idx on public.held_orders (status, expires_at);
alter table public.held_orders enable row level security;
revoke all on public.held_orders from anon, authenticated;

-- Хватает ли товара: у позиций с учётом количества остаток по цвету и размеру не меньше заказанного
create or replace function public.held_stock_ok(p_items jsonb)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare cat jsonb; i jsonb; path text[];
begin
  select data into cat from public.catalog_state where id = 1;
  if cat is null then return true; end if;
  for i in select * from jsonb_array_elements(p_items) loop
    path := array['stock', i ->> 'id', 'qty', (i ->> 'color') || '|' || (i ->> 'size')];
    continue when i ->> 'id' is null or cat #> path is null;
    if coalesce((cat #>> path)::int, 0) < greatest(coalesce((i ->> 'qty')::int, 1), 1) then return false; end if;
  end loop;
  return true;
end $$;
revoke execute on function public.held_stock_ok(jsonb) from public, anon, authenticated;

-- ---------- 2. Покупатель: зарезервировать товар под оплату ----------
create or replace function public.order_hold(p_items jsonb, p_total numeric, p_name text, p_phone text, p_way text, p_addr text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare me bigint; h public.held_orders;
begin
  begin me := public.tg_id(); exception when others then me := null; end;
  if me is null then raise exception 'hold:denied' using errcode = '42501'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 50
     or p_total is null or p_total < 50 or p_total > 10000000
     or p_way ~ 'оплата наличными' or p_way ~ 'оплата при получении' then
    raise exception 'hold:bad_data' using errcode = '22023';
  end if;
  -- просроченные резервы освобождаем; прежние незавершённые резервы этого же покупателя заменяются новым
  perform public.hold_expire();
  for h in select * from public.held_orders where user_id = me and status = 'pending' for update loop
    perform public.stock_apply(h.items, 1);
    update public.held_orders set status = 'cancelled' where id = h.id;
  end loop;
  if not public.held_stock_ok(p_items) then raise exception 'hold:conflict' using errcode = '40001'; end if;
  perform public.stock_apply(p_items, -1);
  insert into public.held_orders (user_id, items, total, customer_name, phone, delivery_way, address)
  values (me, p_items, round(p_total, 2), left(p_name, 200), left(p_phone, 50), left(p_way, 300), left(p_addr, 500))
  returning * into h;
  return jsonb_build_object('id', h.id, 'total', h.total);
end $$;
revoke execute on function public.order_hold(jsonb, numeric, text, text, text, text) from public;
grant execute on function public.order_hold(jsonb, numeric, text, text, text, text) to anon, authenticated;

-- Покупатель передумал или закрыл окно оплаты: резерв снимается
create or replace function public.order_hold_cancel(p_id bigint)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
declare me bigint; h public.held_orders;
begin
  begin me := public.tg_id(); exception when others then me := null; end;
  if me is null then raise exception 'hold:denied' using errcode = '42501'; end if;
  select * into h from public.held_orders where id = p_id and user_id = me and status = 'pending' for update;
  if h.id is null then return false; end if;
  perform public.stock_apply(h.items, 1);
  update public.held_orders set status = 'cancelled' where id = h.id;
  return true;
end $$;
revoke execute on function public.order_hold_cancel(bigint) from public;
grant execute on function public.order_hold_cancel(bigint) to anon, authenticated;

-- Резерв покупателя: функция online-pay пересылает его подпись, база сама проверяет, чей резерв
create or replace function public.hold_pay_order(p_id bigint)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare me bigint; h public.held_orders;
begin
  begin me := public.tg_id(); exception when others then me := null; end;
  if me is null then raise exception 'pay:denied' using errcode = '42501'; end if;
  select * into h from public.held_orders where id = p_id and user_id = me;
  if h.id is null then raise exception 'pay:not_found' using errcode = '42501'; end if;
  return jsonb_build_object('id', h.id, 'user_id', h.user_id, 'total', h.total, 'status', h.status,
    'pay_id', h.pay_id, 'order_id', h.order_id);
end $$;
revoke execute on function public.hold_pay_order(bigint) from public;
grant execute on function public.hold_pay_order(bigint) to anon, authenticated;

-- ---------- 3. Только функция online-pay (ключ service_role) ----------
create or replace function public.hold_pay_start(p_id bigint, p_pay_id text)
returns void language sql volatile security definer set search_path = '' as $$
  update public.held_orders set pay_id = p_pay_id where id = p_id and status in ('pending', 'expired', 'cancelled')
$$;

-- Оплата прошла → заказ создаётся сразу оплаченным. Резерв уже оплачен деньгами: возвращаем товар на склад,
-- а обычный триггер заказа резервирует его заново. Повторный вызов ничего не меняет и возвращает null.
-- Если резерв успел истечь (оплатил позже 30 минут), заказ всё равно создаётся: деньги уже у нас.
create or replace function public.hold_confirm(p_id bigint, p_pay_id text, p_amount numeric, p_test boolean)
returns bigint language plpgsql volatile security definer set search_path = '' as $$
declare h public.held_orders; oid bigint;
begin
  select * into h from public.held_orders where id = p_id and status in ('pending', 'expired', 'cancelled') for update;
  if h.id is null then return null; end if;
  if h.status = 'pending' then perform public.stock_apply(h.items, 1); end if;
  insert into public.orders (user_id, items, total, customer_name, phone, delivery_way, address)
  values (h.user_id, h.items, h.total, h.customer_name, h.phone, h.delivery_way, h.address)
  returning id into oid;
  update public.orders set status = 'paid', payment_method = 'card', paid_amount = round(p_amount, 2), paid_at = now(),
    paid_by = case when p_test then 'Онлайн-оплата (тест)' else 'Онлайн-оплата' end,
    online_pay_id = p_pay_id, online_pay_url = null, online_pay_test = p_test
  where id = oid;
  update public.held_orders set status = 'paid', order_id = oid, pay_id = p_pay_id where id = h.id;
  return oid;
end $$;

-- Резервы без оплаты снимаются по таймеру (и при каждом новом резерве)
create or replace function public.hold_expire()
returns void language plpgsql volatile security definer set search_path = '' as $$
declare h public.held_orders;
begin
  for h in select * from public.held_orders where status = 'pending' and expires_at < now() for update skip locked loop
    perform public.stock_apply(h.items, 1);
    update public.held_orders set status = 'expired' where id = h.id;
  end loop;
end $$;

revoke execute on function public.hold_pay_start(bigint, text), public.hold_confirm(bigint, text, numeric, boolean), public.hold_expire()
  from public, anon, authenticated;
grant execute on function public.hold_pay_start(bigint, text), public.hold_confirm(bigint, text, numeric, boolean), public.hold_expire()
  to service_role;

do $$ begin
  create extension if not exists pg_cron;
  perform cron.unschedule(jobid) from cron.job where jobname = 'hold-expire';
  perform cron.schedule('hold-expire', '* * * * *', 'select public.hold_expire()');
exception when others then raise notice 'pg_cron недоступен: резервы снимутся при следующем резерве или оплате (%)', sqlerrm;
end $$;

-- ---------- «Будильник» функции оплаты: раз в минуту, чтобы форма открывалась без «холодного старта» ----------
create or replace function public.online_pay_keep_warm()
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform net.http_post(
    url := 'https://ztcltngfpnhhuzyyqnfw.supabase.co/functions/v1/online-pay',
    body := '{"action":"ping"}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json'),
    timeout_milliseconds := 10000);
exception when others then null;
end $$;
revoke execute on function public.online_pay_keep_warm() from public, anon, authenticated;
do $$ begin
  create extension if not exists pg_cron;
  perform cron.unschedule(jobid) from cron.job where jobname = 'online-pay-keep-warm';
  perform cron.schedule('online-pay-keep-warm', '* * * * *', 'select public.online_pay_keep_warm()');
exception when others then raise notice 'pg_cron недоступен (%)', sqlerrm;
end $$;

notify pgrst, 'reload schema';

-- ---------- Проверка: всё должно быть «true» ----------
select exists (select 1 from pg_proc where proname = 'order_hold')                 as "резерв под оплату готов",
       exists (select 1 from pg_proc where proname = 'hold_confirm')               as "заказ после оплаты готов",
       exists (select 1 from pg_extension where extname = 'pg_cron')               as "снятие резерва по таймеру (pg_cron)",
       exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'orders'
               and column_name = 'online_pay_id')                                  as "онлайн-оплата настроена";
