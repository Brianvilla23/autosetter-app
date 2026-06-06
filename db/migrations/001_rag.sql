-- Atinov — Migración RAG (Tarea 2)
-- Capa de memoria semántica en Supabase + pgvector. HÍBRIDO: NeDB sigue siendo
-- la DB operacional (leads, messages, agents). Esto es SOLO la memoria/RAG.
--
-- Cómo aplicar: Supabase → SQL Editor → pegar todo → Run.
-- Embeddings: OpenAI text-embedding-3-small (1536 dims).
-- Tenant isolation: account_id en cada tabla (= NeDB account._id).

-- ── extensión vector ─────────────────────────────────────────────────────────
create extension if not exists vector;

-- ── 1) Chunks de conversación (memoria semántica) ────────────────────────────
create table if not exists conversation_chunks (
  id          uuid primary key default gen_random_uuid(),
  account_id  text not null,
  lead_id     text not null,
  agent_role  text,                       -- 'nurture' | 'prospect'
  channel     text,                       -- 'instagram' | 'whatsapp'
  outcome     text,                       -- 'ganado' | 'perdido' | 'en_curso'
  content     text not null,              -- el fragmento (par de turnos)
  embedding   vector(1536),               -- OpenAI text-embedding-3-small
  created_at  timestamptz default now()
);
create index if not exists idx_chunks_account on conversation_chunks (account_id);
create index if not exists idx_chunks_embedding on conversation_chunks
  using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- ── 2) Insights etiquetados tras cada conversación (aprendizaje) ─────────────
create table if not exists conversation_insights (
  id          uuid primary key default gen_random_uuid(),
  account_id  text not null,
  lead_id     text not null,
  kind        text not null,              -- 'objecion' | 'pregunta_calificadora' | 'msg_efectivo' | 'motivo_perdida'
  text        text not null,
  embedding   vector(1536),
  outcome     text,                       -- resultado de la conversación donde apareció
  weight      real default 1.0,           -- peso (ej: vino de un 'ganado' → más alto)
  created_at  timestamptz default now()
);
create index if not exists idx_insights_account_kind on conversation_insights (account_id, kind);
create index if not exists idx_insights_embedding on conversation_insights
  using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- ── 3) Lead scoring derivado de embeddings + señales ─────────────────────────
create table if not exists lead_scores (
  lead_id     text primary key,
  account_id  text not null,
  score       real,                       -- 0..100
  signals     jsonb,                      -- {similar_won: 0.8, objections: 2, ...}
  updated_at  timestamptz default now()
);
create index if not exists idx_scores_account on lead_scores (account_id);

-- ── RPC: match de insights por similitud (few-shot dinámico) ─────────────────
-- Devuelve los insights más parecidos a un embedding dado, del mismo account,
-- priorizando los que vienen de conversaciones 'ganado' (weight alto).
create or replace function match_insights(
  p_account_id text,
  p_embedding  vector(1536),
  p_kind       text default null,
  p_limit      int default 3
)
returns table (
  id uuid, kind text, text text, outcome text, weight real, similarity float
)
language sql stable
as $$
  select i.id, i.kind, i.text, i.outcome, i.weight,
         1 - (i.embedding <=> p_embedding) as similarity
  from conversation_insights i
  where i.account_id = p_account_id
    and (p_kind is null or i.kind = p_kind)
  order by (i.embedding <=> p_embedding) * (1.0 / greatest(i.weight, 0.1))
  limit p_limit;
$$;

-- ── RPC: match de chunks (memoria de conversaciones similares) ───────────────
create or replace function match_chunks(
  p_account_id text,
  p_embedding  vector(1536),
  p_outcome    text default null,
  p_limit      int default 3
)
returns table (
  id uuid, lead_id text, content text, outcome text, similarity float
)
language sql stable
as $$
  select c.id, c.lead_id, c.content, c.outcome,
         1 - (c.embedding <=> p_embedding) as similarity
  from conversation_chunks c
  where c.account_id = p_account_id
    and (p_outcome is null or c.outcome = p_outcome)
  order by c.embedding <=> p_embedding
  limit p_limit;
$$;
