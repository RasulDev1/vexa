-- Отмена неоплаченных онлайн-заказов через 30 минут (старая схема: заказ, потом ссылка на оплату).
-- Заказ, оплаченный прямо в окне магазина, создаётся только после оплаты, там действует резерв на 30 минут (hold_expire).
-- Заказы с оплатой наличными и при получении не затрагиваются. Выполняется один раз в SQL Editor.
create or replace function public.unpaid_expire()
returns integer language plpgsql volatile security definer set search_path = '' as $$
declare n integer := 0; o public.orders;
begin
  for o in select * from public.orders
    where status in ('new', 'awaiting_payment')
      and created_at < now() - interval '30 minutes'
      and delivery_way !~ 'оплата наличными' and delivery_way !~ 'оплата при получении'
      and coalesce(payment_details, '') ~ 'https://'
    for update skip locked loop
    update public.orders set status = 'cancelled', manager_note = 'Не оплачен за 30 минут' where id = o.id;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function public.unpaid_expire() from public, anon, authenticated;
grant execute on function public.unpaid_expire() to service_role;

do $$ begin
  create extension if not exists pg_cron;
  perform cron.unschedule(jobid) from cron.job where jobname = 'unpaid-expire';
  perform cron.schedule('unpaid-expire', '* * * * *', 'select public.unpaid_expire()');
exception when others then raise notice 'pg_cron недоступен (%)', sqlerrm;
end $$;

select exists (select 1 from pg_proc where proname = 'unpaid_expire') as "отмена неоплаченных готова",
       exists (select 1 from cron.job where jobname = 'unpaid-expire') as "таймер включён";
