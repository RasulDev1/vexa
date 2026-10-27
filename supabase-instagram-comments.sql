-- =====================================================================
--  VEXA · «Пишите + в комментариях»: ответ в директ со ссылкой на товар
--  Запускать ПОСЛЕ supabase-instagram.sql.
--  Supabase → SQL Editor → новая вкладка (New query) → вставить ЦЕЛИКОМ → Run.
--  Можно запускать повторно. Заказы, переписка и клиенты не меняются.
--
--  Как это работает:
--   • в CRM в карточке товара сотрудник вставляет ссылки на посты с этим товаром (хранятся в каталоге, igPosts);
--   • человек пишет «+» под таким постом — Instagram присылает комментарий боту (поле comments в Webhooks);
--   • бот ставит ответ в очередь (эта таблица) и отправляет его не сразу, а через 20–60 секунд и не чаще
--     одного ответа в 25–60 секунд: так Instagram не принимает бота за рассылку спама;
--   • на один комментарий — один ответ в директ (так требует Instagram), одному человеку под одним постом — тоже один,
--     сколько бы «+» он ни написал. Instagram разрешает ответить в течение 7 дней после комментария.
--   • очередь разбирает «будильник» ig-keep-warm из supabase-instagram.sql: раз в минуту он будит бота.
-- =====================================================================

create table if not exists public.ig_comment_replies (
  comment_id  text primary key,          -- ID комментария в Instagram
  media_id    text not null,             -- ID поста
  post_code   text,                      -- код поста из ссылки instagram.com/p/КОД
  product_id  bigint,                    -- товар, ссылку на который отправили
  from_id     text not null,             -- кто написал «+»
  username    text,
  text        text,
  status      text not null default 'queued'
              check (status in ('queued', 'sending', 'sent', 'skipped', 'failed')),
  send_after  timestamptz not null default now(),
  attempts    int not null default 0,
  error       text,                      -- почему не отправилось (или почему пропущен)
  created_at  timestamptz not null default now(),
  sent_at     timestamptz
);
create index if not exists ig_comment_replies_queue on public.ig_comment_replies (send_after) where status = 'queued';
create index if not exists ig_comment_replies_person on public.ig_comment_replies (from_id, media_id);

alter table public.ig_comment_replies enable row level security;
revoke all on public.ig_comment_replies from anon, authenticated;
grant all on public.ig_comment_replies to service_role;

-- ---------- 1. Новый «+»: в очередь со случайной паузой ----------
-- Ответ: { queued: true, send_after } или { queued: false, reason: 'duplicate' | 'already_replied' }.
create or replace function public.ig_comment_enqueue(p_comment_id text, p_media_id text, p_post_code text,
  p_product_id bigint, p_from_id text, p_username text, p_text text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare last_slot timestamptz; slot timestamptz; reason text;
begin
  -- очередь одна на всех: берём блокировку, чтобы два «+» одновременно не получили одно и то же время
  perform pg_advisory_xact_lock(hashtext('ig_comment_queue'));
  if exists (select 1 from public.ig_comment_replies where comment_id = p_comment_id) then
    return jsonb_build_object('queued', false, 'reason', 'duplicate');
  end if;
  if exists (select 1 from public.ig_comment_replies where from_id = p_from_id and media_id = p_media_id
             and status in ('queued', 'sending', 'sent')) then
    reason := 'already_replied';
  end if;
  select max(send_after) into last_slot from public.ig_comment_replies
  where status in ('queued', 'sending', 'sent') and send_after > now() - interval '5 minutes';
  -- 20–60 с после комментария и 25–60 с после предыдущего ответа
  slot := greatest(now() + make_interval(secs => 20 + floor(random() * 41)),
                   coalesce(last_slot, now()) + make_interval(secs => 25 + floor(random() * 36)));
  insert into public.ig_comment_replies (comment_id, media_id, post_code, product_id, from_id, username, text,
    status, send_after, error)
  values (p_comment_id, p_media_id, p_post_code, p_product_id, p_from_id, p_username, left(p_text, 300),
    case when reason is null then 'queued' else 'skipped' end, slot, reason);
  if reason is not null then return jsonb_build_object('queued', false, 'reason', reason); end if;
  return jsonb_build_object('queued', true, 'send_after', slot);
end $$;
revoke execute on function public.ig_comment_enqueue(text, text, text, bigint, text, text, text) from public, anon, authenticated;
grant execute on function public.ig_comment_enqueue(text, text, text, bigint, text, text, text) to service_role;

-- ---------- 2. Бот берёт из очереди то, что пора отправить ----------
-- Каждую строку получает только один запуск бота (skip locked). Застрявшие «sending» (бот упал) — через 10 минут снова в очередь.
create or replace function public.ig_comment_claim(p_limit int default 3)
returns setof public.ig_comment_replies language plpgsql volatile security definer set search_path = '' as $$
begin
  update public.ig_comment_replies set status = 'queued'
  where status = 'sending' and send_after < now() - interval '10 minutes' and attempts < 3;
  -- Instagram разрешает ответить в директ только в течение 7 дней после комментария
  update public.ig_comment_replies set status = 'failed', error = 'прошло больше 7 дней'
  where status = 'queued' and created_at < now() - interval '7 days';
  return query
  update public.ig_comment_replies r set status = 'sending', attempts = r.attempts + 1, send_after = now()
  where r.comment_id in (select q.comment_id from public.ig_comment_replies q
                         where q.status = 'queued' and q.send_after <= now()
                         order by q.send_after limit greatest(1, least(p_limit, 10))
                         for update skip locked)
  returning r.*;
end $$;
revoke execute on function public.ig_comment_claim(int) from public, anon, authenticated;
grant execute on function public.ig_comment_claim(int) to service_role;

notify pgrst, 'reload schema';

-- ---------- Проверка: всё должно быть «true» ----------
select exists (select 1 from information_schema.tables
               where table_schema = 'public' and table_name = 'ig_comment_replies') as "очередь ответов на «+»",
       exists (select 1 from pg_proc where proname = 'ig_comment_enqueue')            as "постановка в очередь",
       exists (select 1 from pg_extension where extname = 'pg_cron')                  as "будильник бота (разбирает очередь)";
