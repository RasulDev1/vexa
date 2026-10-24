-- =====================================================================
--  VEXA · заказ по ссылке из шапки профиля Instagram, уведомления — в директ
--  Запускать ПОСЛЕ supabase-instagram.sql.
--  Supabase → SQL Editor → новая вкладка (New query) → вставить ЦЕЛИКОМ → Run.
--  Можно запускать повторно. Заказы, переписка и клиенты не меняются.
--
--  Как это работает:
--   • в шапке профиля — обычная ссылка на сайт, без личного ключа. Покупатель оформляет заказ, и сайт
--     заводит его как покупателя из Instagram (ig_users, отрицательный ID), только пока без аккаунта Instagram;
--   • после заказа сайт показывает кнопку «Получать статус в Instagram». Она открывает директ магазина
--     по ссылке ig.me/m/магазин?ref=код. Покупатель пишет любое сообщение (или код из кнопки) — бот
--     по коду привязывает его заказы к этому аккаунту Instagram и сразу присылает заказ и «Мои заказы»;
--   • если этот человек уже писал боту раньше, его новые заказы с сайта переносятся к нему —
--     в «Мои заказы» и в CRM они видны вместе со старыми.
-- =====================================================================

-- ---------- 1. Покупатель с сайта: пока без аккаунта Instagram, с кодом привязки ----------
alter table public.ig_users alter column igsid drop not null;
alter table public.ig_users add column if not exists link_code text unique;

-- Код привязки: «VX» и 8 знаков. Его видно в кнопке и в директе — коротко, чтобы можно было отправить руками.
create or replace function public.ig_new_link_code()
returns text language sql volatile set search_path = '' as $$
  select 'VX' || upper(substr(md5(gen_random_uuid()::text), 1, 8))
$$;
revoke execute on function public.ig_new_link_code() from public, anon, authenticated;

-- Сайт без ключа из директа: новый покупатель и ключ входа. Сайт вызывает это только при оформлении заказа.
create or replace function public.ig_guest_login()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare uid bigint; t text := md5(gen_random_uuid()::text) || md5(gen_random_uuid()::text);
begin
  -- защита от накрутки: не больше 30 новых покупателей с сайта в минуту
  if (select count(*) from public.ig_users where igsid is null and created_at > now() - interval '1 minute') >= 30 then
    raise exception 'tg:guest_busy' using errcode = '42501';
  end if;
  insert into public.ig_users (igsid, link_code) values (null, public.ig_new_link_code()) returning user_id into uid;
  insert into public.ig_logins (token, user_id) values (t, uid);
  return jsonb_build_object('token', t);
end $$;
revoke execute on function public.ig_guest_login() from public;
grant execute on function public.ig_guest_login() to anon, authenticated;

-- Вход по ключу — как в supabase-instagram.sql, плюс: привязан ли директ (linked) и код для кнопки
create or replace function public.ig_login()
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare me bigint := public.ig_id(); u public.ig_users;
begin
  if me is null then raise exception 'tg:ig_expired' using errcode = '42501'; end if;
  update public.ig_logins set last_used_at = now()
  where token = current_setting('request.headers', true)::json ->> 'x-ig-token';
  select * into u from public.ig_users where user_id = me;
  if u.igsid is null and u.link_code is null then
    update public.ig_users set link_code = public.ig_new_link_code() where user_id = me returning * into u;
  end if;
  return jsonb_build_object('telegram_id', me, 'username', u.username, 'role', 'user', 'channel', 'instagram',
    'topic', public.realtime_topic('user', me),
    'linked', u.igsid is not null, 'link_code', case when u.igsid is null then u.link_code end);
end $$;
revoke execute on function public.ig_login() from public;
grant execute on function public.ig_login() to anon, authenticated;

-- ---------- 2. Привязка к директу: бот получил код от аккаунта Instagram ----------
-- Ответ: { user_id } — покупатель, к которому теперь относятся заказы; { error: 'no_code' | 'taken' }.
create or replace function public.ig_bind(p_code text, p_igsid text, p_username text, p_name text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare g public.ig_users; e public.ig_users; target bigint;
begin
  select * into g from public.ig_users where link_code = upper(trim(p_code)) for update;
  if g.user_id is null then return jsonb_build_object('error', 'no_code'); end if;
  if g.igsid = p_igsid then return jsonb_build_object('user_id', g.user_id); end if;
  if g.igsid is not null then return jsonb_build_object('error', 'taken'); end if;

  select * into e from public.ig_users where igsid = p_igsid for update;
  if e.user_id is null then
    -- новый в директе: этот покупатель с сайта и есть он
    -- код остаётся за ним: повторное сообщение с тем же кодом просто снова покажет заказ
    update public.ig_users set igsid = p_igsid, username = coalesce(p_username, username), name = coalesce(p_name, name),
      last_message_at = now()
    where user_id = g.user_id;
    target := g.user_id;
  else
    -- уже писал боту: заказы и переписку с сайта переносим к нему, ключ входа на сайте — тоже
    target := e.user_id;
    update public.orders set user_id = target where user_id = g.user_id;
    update public.order_messages set user_id = target where user_id = g.user_id;
    update public.ig_logins set user_id = target where user_id = g.user_id;
    begin update public.held_orders set user_id = target where user_id = g.user_id;
    exception when undefined_table then null; end;
    begin update public.product_reviews set user_id = target where user_id = g.user_id;
    exception when undefined_table or unique_violation then null; end;
    delete from public.bot_chat_state where telegram_id = g.user_id;
    delete from public.ig_users where user_id = g.user_id;
    update public.ig_users set link_code = g.link_code, last_message_at = now() where user_id = target;
    begin delete from public.users where telegram_id = g.user_id;
    exception when others then null; end; -- на него ещё что-то ссылается — строка просто останется
  end if;
  -- в CRM у этих заказов появится логин Instagram
  update public.orders set username = (select u.username from public.ig_users u where u.user_id = target)
  where user_id = target and username is null;
  return jsonb_build_object('user_id', target);
end $$;
revoke execute on function public.ig_bind(text, text, text, text) from public, anon, authenticated;
grant execute on function public.ig_bind(text, text, text, text) to service_role;

-- ---------- 2б. Без кода: свежие заказы с сайта, ещё не привязанные к директу ----------
-- Бот спрашивает «Это ваш заказ?», если код из ссылки не дошёл (на iPhone ссылка иногда открывает веб-версию).
-- Только заказы за последние 30 минут и только состав и сумма — без имени, телефона и адреса.
create or replace function public.ig_recent_site_orders()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(x order by x.created_at desc), '[]'::jsonb) from (
    select u.link_code as code, o.id, o.total, o.items, o.created_at
    from public.orders o join public.ig_users u on u.user_id = o.user_id
    where u.igsid is null and u.link_code is not null and o.created_at > now() - interval '30 minutes'
    order by o.created_at desc limit 3
  ) x
$$;
revoke execute on function public.ig_recent_site_orders() from public, anon, authenticated;
grant execute on function public.ig_recent_site_orders() to service_role;

-- ---------- 3. Уборка: покупатели с сайта, которые так и не оформили заказ ----------
create or replace function public.ig_guests_cleanup()
returns void language plpgsql security definer set search_path = '' as $$
declare uid bigint;
begin
  for uid in select u.user_id from public.ig_users u
    where u.igsid is null and u.created_at < now() - interval '2 days'
      and not exists (select 1 from public.orders o where o.user_id = u.user_id) loop
    delete from public.ig_users where user_id = uid;
    begin delete from public.users where telegram_id = uid; exception when others then null; end;
  end loop;
end $$;
revoke execute on function public.ig_guests_cleanup() from public, anon, authenticated;

do $$ begin
  create extension if not exists pg_cron;
  perform cron.unschedule(jobid) from cron.job where jobname = 'ig-guests-cleanup';
  perform cron.schedule('ig-guests-cleanup', '17 4 * * *', 'select public.ig_guests_cleanup()');
exception when others then raise notice 'pg_cron недоступен: уборка покупателей без заказов не включена (%)', sqlerrm;
end $$;

notify pgrst, 'reload schema';

-- ---------- Проверка: всё должно быть «true» ----------
select exists (select 1 from pg_proc where proname = 'ig_guest_login') as "заказ с сайта без ссылки",
       exists (select 1 from pg_proc where proname = 'ig_bind')        as "привязка заказа к директу по коду",
       exists (select 1 from pg_proc where proname = 'ig_recent_site_orders') as "заказ без кода",
       exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'ig_users' and column_name = 'link_code') as "коды привязки";
