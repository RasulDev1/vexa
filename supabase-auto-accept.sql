-- =====================================================================
--  VEXA · автоприём заказов (Telegram и Instagram одинаково)
--  Запускать ПОСЛЕ supabase-payments.sql, supabase-crm.sql и supabase-online-pay.sql.
--  Supabase → SQL Editor → новая вкладка (New query) → вставить ЦЕЛИКОМ → Run.
--  Можно запускать повторно. Существующие заказы не меняются.
--
--  Как работает:
--   • покупатель оформил заказ → он сразу принимается сам, менеджер ничего не нажимает
--     (товар уже зарезервирован при оформлении, способ оплаты покупатель выбрал в корзине);
--   • наличные или оплата при получении → покупатель сразу видит это в «Мои заказы» и в чате бота;
--   • онлайн-оплата → функция online-pay создаёт ссылку, и она сразу уходит покупателю в чат бота
--     (Telegram или директ Instagram) и появляется в «Мои заказы»; оплата отмечается сама;
--   • не получилось (онлайн-оплата не настроена, тестовый режим, сбой) → заказ остаётся «новым»,
--     и менеджер принимает его кнопкой, как раньше.
--  Отключить автоприём:  update public.shop_settings set auto_accept = false where id = 1;
-- =====================================================================

-- ---------- 1. Настройки магазина ----------
create table if not exists public.shop_settings (
  id          int primary key default 1 check (id = 1),
  auto_accept boolean not null default true,
  auto_secret text not null default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '') -- подпись запроса базы к online-pay
);
insert into public.shop_settings (id) values (1) on conflict do nothing;
alter table public.shop_settings enable row level security;
revoke all on public.shop_settings from anon, authenticated;

-- ---------- 2. Принять заказ: только функция online-pay (ключ service_role) ----------
create or replace function public.order_auto_accept(p_id bigint, p_text text)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
declare done bigint;
begin
  update public.orders set status = 'awaiting_payment', payment_details = p_text
  where id = p_id and status = 'new'
  returning id into done;
  return done is not null;
end $$;
revoke execute on function public.order_auto_accept(bigint, text) from public, anon, authenticated;
grant execute on function public.order_auto_accept(bigint, text) to service_role;

-- ---------- 3. Новый заказ → принимается сам ----------
-- Наличные и оплата при получении — прямо здесь, текст вместо реквизитов (как в CRM по кнопке «Принять»).
-- Онлайн — просим функцию online-pay: ссылка на оплату подписана ключом Stripe, который знает только она.
-- Дальше всё как при ручном приёме: статус меняется, и покупателю в чат уходит «✅ Заказ принят!».
create or replace function public.orders_auto_accept()
returns trigger language plpgsql security definer set search_path = '' as $$
declare s public.shop_settings; way text;
begin
  select * into s from public.shop_settings where id = 1;
  if s.id is null or not s.auto_accept or new.status <> 'new' then return null; end if;
  way := case when new.delivery_way ~ 'оплата наличными' then 'cash'
              when new.delivery_way ~ 'оплата при получении' then 'cod' else 'online' end;
  if way = 'online' then
    begin
      perform net.http_post(
        url := 'https://ztcltngfpnhhuzyyqnfw.supabase.co/functions/v1/online-pay',
        body := jsonb_build_object('action', 'auto_accept', 'order_id', new.id),
        headers := jsonb_build_object('Content-Type', 'application/json', 'x-auto-accept', s.auto_secret),
        timeout_milliseconds := 30000);
    exception when others then null; -- не вышло — заказ останется «новым», менеджер примет его сам
    end;
  else
    update public.orders set status = 'awaiting_payment',
      payment_details = case way when 'cash' then 'Оплата наличными при самовывозе' else 'Оплата при получении. Возврат платный' end
    where id = new.id and status = 'new';
  end if;
  return null;
end $$;
drop trigger if exists orders_auto_accept on public.orders;
create trigger orders_auto_accept after insert on public.orders
  for each row execute function public.orders_auto_accept();

-- ---------- 4. История заказа: «Принят автоматически» (приём без сотрудника) ----------
-- Копия orders_log_events из supabase-crm.sql, изменена одна строка: приём без сотрудника и без покупателя.
create or replace function public.orders_log_events()
returns trigger language plpgsql security definer set search_path = '' as $$
declare actor text := public.event_actor(new.user_id); body text;
  st jsonb := '{"new":"Новый","awaiting_payment":"Ждёт оплаты","paid":"Оплачен","delivered":"Вручён","cancelled":"Отказ","return_requested":"Возврат запрошен","return_approved":"Возврат одобрен","returned":"Возврат вручён"}';
  way jsonb := '{"cash":"наличными","card":"картой"}';
begin
  if tg_op = 'INSERT' then
    insert into public.order_events (order_id, actor, body) values (new.id, coalesce(actor, 'Покупатель'),
      'Заказ оформлен на ' || public.rub(new.total));
    return null;
  end if;
  if new.status is distinct from old.status then
    body := case
      when new.status = 'awaiting_payment' and old.status = 'new' then
        case when actor is null then 'Принят автоматически, покупателю отправлены реквизиты для оплаты'
             else 'Принят, покупателю отправлены реквизиты для оплаты' end
      when new.status = 'cancelled' then 'Отказ' || coalesce(': «' || nullif(trim(new.manager_note), '') || '»', '')
      when new.status = 'paid' then 'Оплачен' || coalesce(' ' || (way ->> new.payment_method), '') || coalesce(': ' || public.rub(new.paid_amount), '')
      when new.status = 'delivered' and old.status in ('return_requested', 'return_approved') then 'В возврате отказано' || coalesce(': «' || nullif(trim(new.return_declined), '') || '»', '')
      when new.status = 'delivered' then 'Вручён покупателю'
      when new.status = 'return_requested' then 'Покупатель запросил возврат' || coalesce(': «' || nullif(trim(new.return_request_reason), '') || '»', '')
      when new.status = 'return_approved' then 'Возврат одобрен' || coalesce(': «' || nullif(trim(new.return_reason), '') || '»', '')
        || '. Вернём ' || public.rub(new.return_amount) || coalesce(' ' || (way ->> new.return_method), '') || ', ждём вещь'
      when new.status = 'returned' then 'Возврат вручён' || coalesce(': «' || nullif(trim(new.return_reason), '') || '»', '')
        || '. Вернули ' || public.rub(new.refund_amount) || coalesce(' ' || (way ->> new.refund_method), '')
        || case when new.restocked then ', товар вернулся на склад' else ', товар не возвращается на склад' end
      else 'Статус: ' || coalesce(st ->> old.status, old.status) || ' → ' || coalesce(st ->> new.status, new.status) end;
    insert into public.order_events (order_id, actor, body) values (new.id, actor, body);
  elsif new.paid_amount is distinct from old.paid_amount or new.payment_method is distinct from old.payment_method then
    insert into public.order_events (order_id, actor, body) values (new.id, actor,
      'Оплата изменена: ' || public.rub(new.paid_amount) || coalesce(' ' || (way ->> new.payment_method), ''));
  end if;
  return null;
end $$;

notify pgrst, 'reload schema';

-- ---------- Проверка: всё должно быть «true» ----------
select exists (select 1 from pg_trigger where tgname = 'orders_auto_accept')                 as "автоприём включён",
       (select auto_accept from public.shop_settings where id = 1)                            as "автоприём не отключён",
       exists (select 1 from pg_extension where extname = 'pg_net')                           as "отправка из базы включена";
