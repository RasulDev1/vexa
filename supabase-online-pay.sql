-- =====================================================================
--  VEXA · онлайн-оплата картой через ЮKassa (сначала — тестовый магазин, деньги не списываются)
--  Запускать ПОСЛЕ supabase-payments.sql.
--  Supabase → SQL Editor → новая вкладка (New query) → вставить ЦЕЛИКОМ → Run.
--  Можно запускать повторно. Заказы не меняются.
--
--  Как работает:
--   • менеджер принял заказ → у покупателя в «Мои заказы» кнопка «Оплатить картой онлайн»;
--   • функция online-pay создаёт платёж в ЮKassa на сумму заказа из базы и открывает страницу оплаты;
--   • ЮKassa сообщает функции об оплате, функция перепроверяет платёж в ЮKassa и отмечает заказ оплаченным.
--  В аналитике онлайн-оплата считается как «карта», в истории заказа видно, что оплачено онлайн.
-- =====================================================================

-- ---------- 1. Платёж ЮKassa у заказа ----------
alter table public.orders add column if not exists online_pay_id   text;     -- id платежа в ЮKassa
alter table public.orders add column if not exists online_pay_url  text;     -- страница оплаты, пока платёж не завершён
alter table public.orders add column if not exists online_pay_test boolean;  -- платёж тестового магазина
create unique index if not exists orders_online_pay_id_idx on public.orders (online_pay_id) where online_pay_id is not null;

-- ---------- 2. Покупатель: свой заказ, который ждёт оплаты ----------
-- Функцию online-pay зовёт покупатель, она пересылает его подпись Telegram — база сама проверяет, чей заказ.
-- Сумму берём из базы, а не со страницы.
create or replace function public.online_pay_order(p_id bigint)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare me bigint; o public.orders;
begin
  begin me := public.tg_id(); exception when others then me := null; end;
  if me is null then raise exception 'pay:denied' using errcode = '42501'; end if;
  select * into o from public.orders where id = p_id and user_id = me;
  if o.id is null then raise exception 'pay:not_found' using errcode = '42501'; end if;
  if o.status <> 'awaiting_payment' then raise exception 'pay:not_awaiting' using errcode = '40001'; end if;
  return jsonb_build_object('id', o.id, 'user_id', o.user_id, 'total', o.total, 'pay_id', o.online_pay_id, 'pay_url', o.online_pay_url);
end $$;

-- ---------- 3. Только функция online-pay (ключ service_role): запомнить платёж и отметить оплату ----------
create or replace function public.online_pay_start(p_id bigint, p_pay_id text, p_url text, p_test boolean)
returns void language sql volatile security definer set search_path = '' as $$
  update public.orders set online_pay_id = p_pay_id, online_pay_url = p_url, online_pay_test = p_test
  where id = p_id and status = 'awaiting_payment'
$$;

-- Заказ уже оплачен (или отменён) — повторный вызов ничего не меняет и возвращает false
create or replace function public.online_pay_confirm(p_id bigint, p_pay_id text, p_amount numeric, p_test boolean)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
declare done bigint;
begin
  update public.orders set status = 'paid', payment_method = 'card', paid_amount = round(p_amount, 2), paid_at = now(),
    paid_by = case when p_test then 'Онлайн-оплата ЮKassa (тест)' else 'Онлайн-оплата ЮKassa' end,
    online_pay_id = p_pay_id, online_pay_url = null, online_pay_test = p_test
  where id = p_id and status = 'awaiting_payment'
  returning id into done;
  return done is not null;
end $$;

revoke execute on function public.online_pay_order(bigint) from public;
grant execute on function public.online_pay_order(bigint) to anon, authenticated;
revoke execute on function public.online_pay_start(bigint, text, text, boolean), public.online_pay_confirm(bigint, text, numeric, boolean)
  from public, anon, authenticated;
grant execute on function public.online_pay_start(bigint, text, text, boolean), public.online_pay_confirm(bigint, text, numeric, boolean)
  to service_role;

-- ---------- 4. Списки заказов у персонала видят новые столбцы ----------
do $$ begin
  if to_regclass('public.order_archive') is not null then
    drop view if exists public.orders_active, public.orders_archived;
    create view public.orders_active with (security_invoker = true) as
      select o.* from public.orders o
      where not exists (select 1 from public.order_archive a where a.order_id = o.id);
    create view public.orders_archived with (security_invoker = true) as
      select o.*, a.archived_at from public.orders o
      join public.order_archive a on a.order_id = o.id;
    revoke all on public.orders_active, public.orders_archived from anon, authenticated;
    grant select on public.orders_active, public.orders_archived to anon, authenticated;
  end if;
end $$;

notify pgrst, 'reload schema';

-- ---------- Проверка: должно быть «true» ----------
select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'orders' and column_name = 'online_pay_id')
   and exists (select 1 from pg_proc where proname = 'online_pay_confirm') as "онлайн-оплата настроена";
