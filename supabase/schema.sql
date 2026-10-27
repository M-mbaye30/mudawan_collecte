

-- ---------------------------------------------------------------------
-- 1. Profils et rôles
-- ---------------------------------------------------------------------
create table public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  display_name  text,
  role          text not null default 'contributor'
                check (role in ('contributor', 'validator', 'admin')),
  created_at    timestamptz not null default now()
);

-- Crée automatiquement le profil quand quelqu'un se connecte pour la 1re fois.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id) values (new.id) on conflict do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Rôle de l'utilisateur connecté (null si personne n'est connecté).
-- « security definer » : la fonction lit profiles sans être bloquée par RLS.
create or replace function public.my_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.profiles where id = auth.uid();
$$;

-- Seul un admin peut changer un rôle. auth.uid() est null quand on passe
-- par le SQL Editor ou la clé service : c'est ainsi que vous nommerez
-- le premier admin.
create or replace function public.protect_role()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.role is distinct from old.role
     and auth.uid() is not null
     and coalesce(public.my_role(), '') <> 'admin' then
    raise exception 'Seul un admin peut changer un rôle.' using errcode = '42501';
  end if;
  new.created_at := old.created_at;
  return new;
end;
$$;

create trigger profiles_protect_role
  before update on public.profiles
  for each row execute function public.protect_role();


-- ---------------------------------------------------------------------
-- 2. Paires
-- ---------------------------------------------------------------------
create table public.pairs (
  id              bigint generated always as identity primary key,
  wolof           text not null check (length(btrim(wolof)) > 0),
  arabic          text not null check (length(btrim(arabic)) > 0),

  -- Provenance de la traduction arabe :
  --   human_native : traduite par le contributeur lui-même
  --   published    : traduction existante trouvée dans une source
  --   mt_postedit  : traduction automatique corrigée par le contributeur
  origin          text not null
                  check (origin in ('human_native', 'published', 'mt_postedit')),

  domain          text not null
                  check (domain in ('religion', 'news', 'daily', 'education',
                                    'literature', 'other')),

  source_title    text,
  source_url      text,

  -- contributor : le texte est la propre traduction du contributeur,
  --               publiée sous la licence du corpus (voir consent)
  license         text not null
                  check (license in ('contributor', 'cc_by', 'cc_by_sa', 'cc_by_nc',
                                     'public_domain', 'unknown')),

  -- Accord du contributeur pour publier SON travail sous la licence du corpus.
  consent         boolean not null default false,

  status          text not null default 'pending'
                  check (status in ('pending', 'validated', 'rejected')),
  version         int not null default 1,

  submitted_by    uuid not null default auth.uid() references public.profiles(id),
  reviewed_by     uuid references public.profiles(id),
  review_comment  text,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  -- Empreinte du texte normalisé (espaces, casse du wolof) : empêche les
  -- doublons exacts. Calculée par PostgreSQL, jamais saisie.
  pair_key        text generated always as (
                    md5(lower(regexp_replace(btrim(wolof), '\s+', ' ', 'g'))
                        || '|' ||
                        regexp_replace(btrim(arabic), '\s+', ' ', 'g'))
                  ) stored unique,

  -- Une traduction du contributeur exige son consentement.
  constraint consent_required check (
    origin not in ('human_native', 'mt_postedit') or consent
  ),
  -- Une traduction trouvée doit indiquer d'où elle vient.
  constraint published_needs_source check (
    origin <> 'published'
    or coalesce(btrim(source_title), '') <> ''
    or coalesce(btrim(source_url), '') <> ''
  )
);

create index pairs_status_idx on public.pairs (status, created_at);
create index pairs_submitted_by_idx on public.pairs (submitted_by);


-- ---------------------------------------------------------------------
-- 3. Historique
-- ---------------------------------------------------------------------
create table public.pair_versions (
  id          bigint generated always as identity primary key,
  pair_id     bigint not null references public.pairs(id) on delete cascade,
  version     int not null,
  wolof       text not null,
  arabic      text not null,
  action      text not null
              check (action in ('submit', 'correct', 'validate', 'reject', 'reopen')),
  status      text not null,
  comment     text,
  author      uuid references public.profiles(id),
  created_at  timestamptz not null default now()
);

create index pair_versions_pair_idx on public.pair_versions (pair_id, id);


-- ---------------------------------------------------------------------
-- 4. Triggers sur pairs
-- ---------------------------------------------------------------------

-- Avant insertion : une nouvelle paire est toujours « pending », version 1,
-- et appartient à la personne connectée, quoi que le navigateur ait envoyé.
create or replace function public.pairs_before_insert()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.status         := 'pending';
  new.version        := 1;
  new.reviewed_by    := null;
  new.review_comment := null;
  new.created_at     := now();
  new.updated_at     := now();
  if auth.uid() is not null then
    new.submitted_by := auth.uid();
  end if;
  return new;
end;
$$;

create trigger pairs_before_insert
  before insert on public.pairs
  for each row execute function public.pairs_before_insert();

-- Avant modification : règles de relecture.
create or replace function public.pairs_before_update()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  text_changed boolean;
begin
  -- auth.uid() null = SQL Editor ou clé service : pas de restriction.
  if auth.uid() is not null then
    if coalesce(public.my_role(), '') not in ('validator', 'admin') then
      raise exception 'Seuls les validateurs peuvent modifier une paire.'
        using errcode = '42501';
    end if;
    -- Un validateur ne relit pas ses propres paires (l'admin le peut).
    if old.submitted_by = auth.uid() and public.my_role() <> 'admin' then
      raise exception 'self_review' using errcode = '42501';
    end if;
    -- Rejeter exige une explication.
    if new.status = 'rejected' and coalesce(btrim(new.review_comment), '') = '' then
      raise exception 'reject_needs_comment' using errcode = '23514';
    end if;
  end if;

  -- Champs que personne ne réécrit.
  new.submitted_by := old.submitted_by;
  new.created_at   := old.created_at;
  new.consent      := old.consent;
  new.origin       := old.origin;

  text_changed := new.wolof is distinct from old.wolof
               or new.arabic is distinct from old.arabic;
  if text_changed then
    new.version := old.version + 1;
  else
    new.version := old.version;
  end if;

  if new.status is distinct from old.status or text_changed then
    new.reviewed_by := auth.uid();
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger pairs_before_update
  before update on public.pairs
  for each row execute function public.pairs_before_update();

-- Après insertion / modification : écrire l'historique.
-- « security definer » : écrit dans pair_versions malgré RLS.
create or replace function public.pairs_log_version()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  act text;
begin
  if tg_op = 'INSERT' then
    act := 'submit';
  else
    if new.wolof is distinct from old.wolof or new.arabic is distinct from old.arabic then
      act := 'correct';
    elsif new.status is distinct from old.status then
      act := case new.status
               when 'validated' then 'validate'
               when 'rejected'  then 'reject'
               else 'reopen'
             end;
    else
      return new;  -- seule la métadonnée a changé : pas de nouvelle version
    end if;
  end if;

  insert into public.pair_versions
    (pair_id, version, wolof, arabic, action, status, comment, author)
  values
    (new.id, new.version, new.wolof, new.arabic, act, new.status,
     case when tg_op = 'UPDATE' then new.review_comment end,
     coalesce(auth.uid(), new.submitted_by));
  return new;
end;
$$;

create trigger pairs_after_write
  after insert or update on public.pairs
  for each row execute function public.pairs_log_version();


-- ---------------------------------------------------------------------
-- 5. Row Level Security
-- ---------------------------------------------------------------------
alter table public.profiles      enable row level security;
alter table public.pairs         enable row level security;
alter table public.pair_versions enable row level security;

-- profiles : chacun voit et renomme son profil ; les relecteurs voient tout.
create policy profiles_select on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.my_role() in ('validator', 'admin'));

create policy profiles_update_self on public.profiles
  for update to authenticated
  using (id = auth.uid() or public.my_role() = 'admin')
  with check (id = auth.uid() or public.my_role() = 'admin');

-- pairs : un contributeur voit ses paires ; un relecteur voit tout.
create policy pairs_select on public.pairs
  for select to authenticated
  using (submitted_by = auth.uid() or public.my_role() in ('validator', 'admin'));

create policy pairs_insert on public.pairs
  for insert to authenticated
  with check (submitted_by = auth.uid());

create policy pairs_update on public.pairs
  for update to authenticated
  using (public.my_role() in ('validator', 'admin'))
  with check (public.my_role() in ('validator', 'admin'));

-- Pas de policy delete : la suppression ne se fait que depuis le tableau
-- de bord Supabase.

-- pair_versions : lecture si on peut lire la paire ; écriture par trigger seulement.
create policy pair_versions_select on public.pair_versions
  for select to authenticated
  using (exists (select 1 from public.pairs p where p.id = pair_id));


-- ---------------------------------------------------------------------
-- 6. Fonctions appelées par les pages
-- ---------------------------------------------------------------------

-- Compteurs affichés sur la page d'accueil, même sans connexion.
create or replace function public.public_stats()
returns json
language sql
stable
security definer
set search_path = public
as $$
  select json_build_object(
    'validated',    count(*) filter (where status = 'validated'),
    'pending',      count(*) filter (where status = 'pending'),
    'contributors', count(distinct submitted_by)
  )
  from public.pairs;
$$;

-- Rapport par personne (pour la rémunération) : admin seulement,
-- ou depuis le SQL Editor (auth.uid() y est null).
create or replace function public.contributor_report()
returns table (
  user_id           uuid,
  email             text,
  display_name      text,
  role              text,
  submitted         bigint,
  validated         bigint,
  rejected          bigint,
  reviews_done      bigint,
  corrections_done  bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and coalesce(public.my_role(), '') <> 'admin' then
    raise exception 'Réservé aux admins.' using errcode = '42501';
  end if;
  return query
  select pr.id,
         u.email::text,
         pr.display_name,
         pr.role,
         (select count(*) from pairs p where p.submitted_by = pr.id),
         (select count(*) from pairs p where p.submitted_by = pr.id and p.status = 'validated'),
         (select count(*) from pairs p where p.submitted_by = pr.id and p.status = 'rejected'),
         (select count(*) from pair_versions v
            where v.author = pr.id and v.action in ('validate', 'reject', 'correct')),
         (select count(*) from pair_versions v
            where v.author = pr.id and v.action = 'correct')
  from profiles pr
  join auth.users u on u.id = pr.id
  order by 5 desc;
end;
$$;

-- Droits d'exécution : public_stats pour tous, le reste pour les connectés.
revoke all on function public.public_stats()        from public;
revoke all on function public.contributor_report()  from public;
grant execute on function public.public_stats()       to anon, authenticated;
grant execute on function public.contributor_report() to authenticated;
grant execute on function public.my_role()            to authenticated;
