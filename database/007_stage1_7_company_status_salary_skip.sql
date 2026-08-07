-- ALL FINANCE CASH Stage 1.7 migration
-- Korxona statuslari va ayrim davrlarda ish haqi hisoblanmasligini boshqarish.
-- Mavjud Supabase bazani o'chirmang. Ushbu SQL ni bir marta SQL Editor'da ishga tushiring.

create extension if not exists "pgcrypto";

alter table if exists public.afc_companies
  add column if not exists status text not null default 'active';

-- Tanlangan oy/davr bo'yicha korxona holati.
-- Masalan: aynan shu oyda ish haqi hisoblanmasin, lekin qo'shimcha xizmatlar hisoblansin.
create table if not exists public.afc_company_period_statuses (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.afc_companies(id) on delete cascade,
  period_id uuid not null references public.afc_periods(id) on delete cascade,
  status text not null default 'active',
  salary_enabled boolean not null default true,
  comment text,
  created_by uuid references public.afc_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(company_id, period_id)
);

create index if not exists idx_afc_company_period_statuses_period_company
  on public.afc_company_period_statuses(period_id, company_id);

create index if not exists idx_afc_company_period_statuses_company
  on public.afc_company_period_statuses(company_id);

-- Agar RLS yoqilgan bo'lsa, backend service_role to'liq ishlashi uchun siyosat.
do $$ begin
  if exists (select 1 from pg_tables where schemaname='public' and tablename='afc_company_period_statuses') then
    execute 'alter table public.afc_company_period_statuses enable row level security';
  end if;
exception when others then null;
end $$;

drop policy if exists "service_role_full_access_afc_company_period_statuses" on public.afc_company_period_statuses;
create policy "service_role_full_access_afc_company_period_statuses"
on public.afc_company_period_statuses
as permissive for all to service_role using (true) with check (true);
