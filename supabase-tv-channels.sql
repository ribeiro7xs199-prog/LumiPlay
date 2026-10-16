-- Execute uma única vez no Supabase SQL Editor para compartilhar os canais entre aparelhos.
create table if not exists public.tv_channels (
  id text primary key,
  name text not null,
  category text not null default 'Outros',
  url text not null,
  logo text not null default '',
  updated_at timestamptz not null default now()
);

alter table public.tv_channels enable row level security;

-- Visitantes podem ler a lista de canais para assistir em qualquer aparelho.
drop policy if exists "tv_channels_public_read" on public.tv_channels;
create policy "tv_channels_public_read"
on public.tv_channels for select
using (true);

-- Somente a conta administradora configurada no LumiPlay pode cadastrar/alterar canais.
drop policy if exists "tv_channels_admin_insert" on public.tv_channels;
create policy "tv_channels_admin_insert"
on public.tv_channels for insert
with check (auth.uid() = 'f6144686-40dd-4e8e-8e4d-e49febce94ec'::uuid);

drop policy if exists "tv_channels_admin_update" on public.tv_channels;
create policy "tv_channels_admin_update"
on public.tv_channels for update
using (auth.uid() = 'f6144686-40dd-4e8e-8e4d-e49febce94ec'::uuid)
with check (auth.uid() = 'f6144686-40dd-4e8e-8e4d-e49febce94ec'::uuid);

drop policy if exists "tv_channels_admin_delete" on public.tv_channels;
create policy "tv_channels_admin_delete"
on public.tv_channels for delete
using (auth.uid() = 'f6144686-40dd-4e8e-8e4d-e49febce94ec'::uuid);

grant select on public.tv_channels to anon, authenticated;
grant insert, update, delete on public.tv_channels to authenticated;
