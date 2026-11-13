-- Channel online schema. Every row belongs to an owner (a Supabase Auth user).
-- Security model: RLS is on for every table. A signed-in owner may READ their own rows (the screen needs this for
-- live updates). Nobody writes through the browser: all writes go through the Channel server with the service
-- role. Token hashes are never readable from the browser.

create table public.agents (
  owner uuid not null references auth.users(id) on delete cascade,
  id text not null check (id ~ '^[a-z][a-z0-9_-]{0,39}$'),
  name text not null,
  description text not null default '',
  skills jsonb not null default '[]',
  kind text not null check (kind in ('a2a', 'mcp')),
  base_url text not null default '',
  rpc_url text not null default '',
  created_at timestamptz not null default now(),
  primary key (owner, id)
);

create table public.chats (
  id bigint generated always as identity primary key,
  owner uuid not null references auth.users(id) on delete cascade,
  title text not null,
  kind text not null check (kind in ('direct', 'group')),
  auto boolean not null default false,
  hop_limit int not null default 4 check (hop_limit between 1 and 10),
  generation int not null default 0,
  created_at timestamptz not null default now()
);
create index chats_owner on public.chats(owner, id desc);

create table public.members (
  chat_id bigint not null references public.chats(id) on delete cascade,
  owner uuid not null,
  agent_id text not null,
  context_id text,
  last_seen bigint not null default 0,
  intro_sent boolean not null default false,
  position int not null default 0,
  primary key (chat_id, agent_id),
  foreign key (owner, agent_id) references public.agents(owner, id) on delete cascade
);

create table public.messages (
  id bigint generated always as identity primary key,
  chat_id bigint not null references public.chats(id) on delete cascade,
  owner uuid not null references auth.users(id) on delete cascade,
  author text not null,
  kind text not null check (kind in ('text', 'handoff', 'notice', 'error')),
  text text not null,
  meta jsonb,
  root_id bigint,
  hop int not null default 0,
  created_at timestamptz not null default now()
);
create index messages_chat on public.messages(chat_id, id);

create table public.deliveries (
  id bigint generated always as identity primary key,
  chat_id bigint not null references public.chats(id) on delete cascade,
  owner uuid not null references auth.users(id) on delete cascade,
  agent_id text not null,
  agent_kind text not null check (agent_kind in ('a2a', 'mcp')),
  payload text not null,
  up_to bigint not null,
  root_id bigint not null,
  hop int not null,
  generation int not null,
  status text not null default 'queued' check (status in ('queued', 'working', 'done', 'failed', 'dropped')),
  created_at timestamptz not null default now(),
  taken_at timestamptz,
  finished_at timestamptz
);
create index deliveries_queue on public.deliveries(owner, agent_kind, status, id);
create index deliveries_chat on public.deliveries(chat_id, status);

-- Tokens for the bridge and for outside agents. Only a SHA-256 hash is stored.
create table public.api_tokens (
  token_hash text primary key,
  owner uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('bridge', 'agent')),
  agent_id text,
  label text not null default '',
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

alter table public.agents enable row level security;
alter table public.chats enable row level security;
alter table public.members enable row level security;
alter table public.messages enable row level security;
alter table public.deliveries enable row level security;
alter table public.api_tokens enable row level security;

create policy "owner reads agents" on public.agents for select to authenticated using (owner = (select auth.uid()));
create policy "owner reads chats" on public.chats for select to authenticated using (owner = (select auth.uid()));
create policy "owner reads members" on public.members for select to authenticated using (owner = (select auth.uid()));
create policy "owner reads messages" on public.messages for select to authenticated using (owner = (select auth.uid()));
create policy "owner reads deliveries" on public.deliveries for select to authenticated using (owner = (select auth.uid()));
-- api_tokens: no policy at all, so no browser access.

-- Claim the oldest queued delivery for a set of a2a agents (the bridge). Safe when several bridges ask at once.
create function public.claim_delivery(p_owner uuid, p_kind text, p_agent_ids text[])
returns setof public.deliveries
language sql
set search_path = ''
as $$
  update public.deliveries d
     set status = 'working', taken_at = now()
   where d.id = (
     select id from public.deliveries
      where owner = p_owner and agent_kind = p_kind and status = 'queued'
        and (p_agent_ids is null or agent_id = any(p_agent_ids))
      order by id
      limit 1
      for update skip locked)
  returning d.*;
$$;

-- Claim every queued delivery for one agent (an MCP agent checking its inbox).
create function public.claim_inbox(p_owner uuid, p_agent_id text)
returns setof public.deliveries
language sql
set search_path = ''
as $$
  update public.deliveries
     set status = 'working', taken_at = now()
   where owner = p_owner and agent_id = p_agent_id and status = 'queued'
  returning *;
$$;

revoke all on function public.claim_delivery(uuid, text, text[]) from public, anon, authenticated;
revoke all on function public.claim_inbox(uuid, text) from public, anon, authenticated;

-- Live updates for the screen.
alter publication supabase_realtime add table public.messages, public.deliveries, public.chats;
