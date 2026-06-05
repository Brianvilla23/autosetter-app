# Atinov — Arquitectura V2: Dos Agentes + RAG + WhatsApp

> Documento técnico de diseño. Estado: **propuesta para revisión** (2026-05).
> Restricciones: cumplimiento 100% políticas Meta · cost-effective · no romper
> producción · cambios incrementales y testeables · mercado MX + CL.

---

## PARTE 0 — Mapa de la arquitectura actual (resultado de la exploración)

### Stack en producción (Railway)
- **Runtime**: Node.js + Express (`server.js` = fuente de verdad)
- **Datos**: NeDB file-based (23 colecciones, `db/database.js`), persistido en Railway Volume (`DB_PATH`)
- **IA**: OpenAI — `gpt-4o-mini` (fast) + `o4-mini` (reasoning), selección por complejidad
- **Canales**: Instagram Graph API (`services/meta.js`) + WhatsApp Cloud API (`services/whatsapp.js`, dormante)
- **Pagos**: Polar (USD) + Mercado Pago (CLP) + Lemon Squeezy (deprecado)
- **Email**: Resend · **Notif**: Telegram/CallMeBot

### Dónde vive la lógica del agente
| Pieza | Archivo | Qué hace |
|---|---|---|
| Motor de respuesta | `services/openai.js:98` `generateReply()` | Arma system prompt de 6 capas + elige modelo + llama OpenAI |
| Clasificación | `services/openai.js:356` `classifyLead()` | HOT/WARM/COLD tras ≥2 msgs del lead |
| Prompt base | `services/defaultAgentPrompt.js` | Template de 9 capas (anti-voseo, 3 momentos, 4 ángulos ICP) |
| Preset dogfooding | `services/atinovPreset.js` | Agente "Brian" + knowledge + magnets de Atinov |
| Orquestación | `routes/webhook.js:337` `runConversation()` | Ingesta → contexto → reply → encola → clasifica |
| Selección de agente | `routes/webhook.js:152` | **Toma el PRIMER agente `enabled`** (un agente por cuenta) |

**Composición del system prompt** (orden, `openai.js`):
`agent.instructions` + knowledge + links + lead magnets + extraContext + humanizationPrompt.

### Cómo se almacenan conversaciones y leads
- **`leads`** (NeDB): identidad (ig/wa), `channel`, `status`, `automation`, `qualification`, `pipeline_stage`, `deal_value`, `tags`, `activity_log[]`, `triggered_by`, `email/phone`, `is_converted`. (~30 campos)
- **`messages`** (NeDB): `lead_id`, `role` (`user`|`agent`|`manual`), `content`, `createdAt`. Se reconstruye el historial por `lead_id` ordenado por fecha.
- **`knowledge`** (NeDB): `title`, `content`, `is_main`, `agent_ids[]`, `account_id`. **Texto plano, se inyecta COMPLETO en cada prompt.**
- **NO hay embeddings, vectores ni RAG hoy.** Cero búsqueda semántica.

### El problema central detectado en beta (26 conversaciones)
El agente se diseñó para **nutrir/calificar leads que ya mostraron interés**, pero se usó también para **prospección en frío**. Síntomas: conversaciones largas/redundantes, usuarios que detectaron el bot, cierre apurado. **Riesgo regulatorio**: Meta puede banear cuentas por automatizar el **primer contacto en frío**.

> Confirmado en el código: hoy existe **UN solo agente activo por cuenta** (el primero `enabled`), sin distinción inbound/outbound. El `triggered_by` registra el origen (`dm_keyword`/`comment`/`wa_dm`) pero el mismo prompt responde a todos.

---

## DECISIONES DE STACK (condicionan TODO lo siguiente)

Tus Tareas 2 y 3 introducen tecnología nueva. Antes de codear hay que cerrar 3 decisiones, porque cambian el diseño de raíz y chocan con la restricción "no romper producción / cost-effective".

### Decisión A — RAG: ¿Supabase+pgvector total, o híbrido?
- **Opción A1 (recomendada): Híbrido.** NeDB sigue siendo la DB operacional (leads, messages, agents — lo que ya funciona). Supabase+pgvector se agrega **solo** como capa de memoria/RAG (embeddings de conversaciones + ejemplos). Cero migración de lo existente, riesgo mínimo, incremental.
- **Opción A2: Migración total a Postgres/Supabase.** Mueve todo de NeDB a Postgres. Más limpio a largo plazo pero es un proyecto de semanas, alto riesgo de romper producción, contradice "incremental".

→ **Recomiendo A1.** Cumple "no romper" + "cost-effective" (Supabase free tier alcanza para el RAG inicial).

### Decisión B — Embeddings: ¿con qué modelo?
Dato técnico importante: **Anthropic (Claude) NO ofrece API de embeddings propia** — su doc recomienda Voyage AI. Opciones reales para pgvector:
- **OpenAI `text-embedding-3-small`** (recomendado): 1536 dims, ~$0.02 / 1M tokens, ya tenés la key configurada. Barato y suficiente.
- Voyage AI / Cohere: buenos pero suman otra cuenta + key.

→ **Recomiendo OpenAI embeddings** (mismo proveedor que ya usás, sin fricción). La **generación** de respuestas puede seguir en OpenAI o sumar Claude como segundo cerebro — eso lo decidís aparte (ver Decisión C).

### Decisión C — Generación: ¿seguir OpenAI, o sumar Claude?
- **Opción C1 (recomendada para ahora): seguir OpenAI.** El motor `generateReply()` ya está afinado (selección fast/reasoning, humanización). Cambiar de LLM ahora = re-tunear toda la humanización. No urgente.
- **Opción C2: Claude para razonamiento.** Claude 4.x es excelente para conversaciones largas/empáticas. Se puede sumar como modelo "reasoning" para objeciones (reemplazando o4-mini). Mejora futura, no bloqueante.

→ **Recomiendo C1 ahora, C2 como experimento A/B medible más adelante.**

---

## TAREA 1 — Separación en dos agentes (PRIORIDAD #1)

> Es la tarea más urgente (resuelve el problema de baneos) y la menos disruptiva
> (se hace sobre el stack actual, sin Supabase ni Claude).

### Concepto
Un campo nuevo `agent.role` distingue dos tipos de agente que **comparten la misma knowledge base** de la cuenta:

```
                    ┌─────────────────── KNOWLEDGE BASE (compartida) ───────────────────┐
                    │  knowledge[] del account (is_main + agent_ids)                     │
                    └───────────────────────────────────────────────────────────────────┘
                              ▲                                        ▲
                              │                                        │
        ┌─────────────────────┴───────────┐      ┌─────────────────────┴────────────────┐
        │  AGENTE NUTRICIÓN / CLOSER       │      │  AGENTE PROSPECCIÓN (asistente humano) │
        │  role: 'nurture'                 │      │  role: 'prospect'                      │
        │  ────────────────────────────    │      │  ───────────────────────────────────  │
        │  • Opera AUTOMÁTICO sobre leads   │      │  • NO automatiza primer contacto frío  │
        │    que YA mostraron interés       │      │  • Asiste al HUMANO:                    │
        │    (DM, comentario, trigger)      │      │    - sugiere mensajes de apertura       │
        │  • Califica, nutre, agenda        │      │    - redacta respuestas (draft)         │
        │  • Compatible con políticas Meta  │      │    - prepara el handoff                 │
        │  • = el flujo actual del webhook  │      │  • Salida: borradores, NO envíos auto   │
        └───────────────────────────────────┘      └─────────────────────────────────────┘
                              │                                        │
                              └──────────── HANDOFF ───────────────────┘
                         (cuando el lead frío "entra en calor" y responde,
                          pasa del flujo asistido-humano al flujo automático)
```

### Cambios de schema (incremental, sin migración destructiva)
NeDB es schemaless → agregar campos no rompe nada. En `agents`:
```js
{
  role: 'nurture' | 'prospect',   // default 'nurture' para agentes existentes
  // 'nurture' = el comportamiento actual (automático sobre inbound)
  // 'prospect' = modo asistente (genera drafts, no envía)
}
```
En `leads` (para el handoff):
```js
{
  handoff_state: 'human_assisted' | 'automated' | null,
  // human_assisted = lead frío, el humano maneja con sugerencias del agente prospect
  // automated = ya respondió/entró en calor, lo toma el agente nurture
  handoff_at: ISO8601,
}
```

### Estructura de módulos (nueva)
```
services/
  agents/
    index.js            # selectAgent(account, lead, context) → decide nurture vs prospect
    nurtureAgent.js     # wrapper de generateReply() para role=nurture (= flujo actual)
    prospectAgent.js    # NUEVO: genera drafts/sugerencias, NUNCA encola envíos
  prompts/
    nurturePrompt.js    # = defaultAgentPrompt actual (refactor, sin cambio de comportamiento)
    prospectPrompt.js   # NUEVO: prompt de "asistente de prospección" (sugerir aperturas,
                        #        redactar respuestas, detectar señal de calor → handoff)
config/
  agentRoles.js         # definición de roles + capabilities (puede_enviar_auto: bool)
```

### Enrutamiento + handoff (sin perder contexto)
1. **Lead nuevo en frío** (lo cargó el humano manualmente, o vino de una lista) → `handoff_state='human_assisted'`. El webhook **NO auto-responde**; en su lugar, el agente `prospect` genera un **draft** que aparece en el inbox para que el humano lo edite y envíe (cumple Meta: el humano hace el primer contacto).
2. **El lead responde / muestra interés** (trigger, keyword, pregunta real) → `selectAgent()` detecta la señal → setea `handoff_state='automated'` + `handoff_at` → a partir de ahí el agente `nurture` toma el control **automático** (flujo actual intacto).
3. **El contexto no se pierde** porque ambos agentes leen el **mismo** `messages[]` del lead. El handoff es solo un cambio de `handoff_state` + qué prompt se usa.

### Compatibilidad con producción
- Agentes existentes → `role='nurture'` por default (migración de 1 línea en `db/database.js`, idempotente). **Comportamiento idéntico al actual.**
- El agente `prospect` es **opt-in**: solo se activa si el cliente crea uno. Cero impacto en cuentas actuales.
- Testeable: `services/conversationSimulator.js` ya existe → se extiende para simular ambos roles.

---

## TAREA 2 — Capa RAG con aprendizaje continuo

> Depende de Decisión A (híbrido) + B (embeddings OpenAI). Se construye DESPUÉS
> de Tarea 1, porque el RAG alimenta a ambos agentes.

### Infraestructura: Supabase + pgvector (capa nueva, no toca NeDB)
```
NeDB (operacional, intacto)            Supabase Postgres + pgvector (memoria/RAG, nuevo)
  leads, messages, agents        ──▶     conversation_chunks (embeddings)
  (lo que ya funciona)                    conversation_insights (objeciones, motivos)
                                          retrieval por cosine similarity
```

### Migraciones SQL (esquema propuesto)
```sql
-- extensión
create extension if not exists vector;

-- 1) chunks de conversación con embedding (memoria semántica)
create table conversation_chunks (
  id            uuid primary key default gen_random_uuid(),
  account_id    text not null,            -- tenant isolation (= NeDB account._id)
  lead_id       text not null,
  agent_role    text,                     -- 'nurture' | 'prospect'
  channel       text,                     -- 'instagram' | 'whatsapp'
  outcome       text,                     -- 'ganado' | 'perdido' | 'en_curso'
  content       text not null,            -- el fragmento (turno o par de turnos)
  embedding     vector(1536),             -- OpenAI text-embedding-3-small
  created_at    timestamptz default now()
);
create index on conversation_chunks using ivfflat (embedding vector_cosine_ops) with (lists = 100);
create index on conversation_chunks (account_id);

-- 2) insights extraídos tras cada conversación (aprendizaje etiquetado)
create table conversation_insights (
  id            uuid primary key default gen_random_uuid(),
  account_id    text not null,
  lead_id       text not null,
  kind          text not null,            -- 'objecion' | 'pregunta_calificadora' | 'msg_efectivo' | 'motivo_perdida'
  text          text not null,            -- el contenido del insight
  embedding     vector(1536),
  outcome       text,                     -- resultado de la conversación donde apareció
  weight        real default 1.0,         -- cuánto pesó (ej: apareció en un ganado)
  created_at    timestamptz default now()
);
create index on conversation_insights using ivfflat (embedding vector_cosine_ops) with (lists = 100);
create index on conversation_insights (account_id, kind);

-- 3) lead scoring derivado de embeddings + señales
create table lead_scores (
  lead_id       text primary key,
  account_id    text not null,
  score         real,                     -- 0..100
  signals       jsonb,                    -- {similar_won: 0.8, objections: 2, ...}
  updated_at    timestamptz default now()
);
```

### Módulo de ingest (`services/rag/ingest.js`)
Se dispara **tras cerrar una conversación** (lead pasa a `ganado`/`perdido`, o inactividad >7d):
1. Toma el `messages[]` del lead desde NeDB.
2. **Chunking**: agrupa en pares pregunta-respuesta (~500 tokens).
3. **Embeddings**: OpenAI `text-embedding-3-small` por chunk.
4. **Extracción de insights** (1 llamada LLM): pide al modelo etiquetar:
   - objeciones que aparecieron
   - preguntas que llevaron a calificación alta
   - mensajes del agente que generaron respuesta del lead
   - motivo de pérdida (si `perdido`)
5. Inserta en `conversation_chunks` + `conversation_insights` con el `outcome`.

### Módulo de retrieval (`services/rag/retrieve.js`)
Antes de que el agente responda (`runConversation`):
1. Embeddea el último mensaje del lead + contexto reciente.
2. Query a Supabase: top-K `conversation_insights` similares **del mismo account**, priorizando los que vienen de conversaciones `ganado`.
3. Devuelve 2-3 ejemplos → se inyectan en el system prompt como **few-shot dinámico** (capa nueva en `generateReply`, vía `extraContext` que YA existe).

### Lead scoring (`services/rag/score.js`)
`score = f(similitud_con_ganados, nº_objeciones, señales_explícitas, recencia)`.
Corre async tras cada mensaje (junto a `classifyLead`). Alimenta el orden del CRM y el umbral de notificación HOT.

### "Mejora sin reentrenamiento"
El RAG **es** la memoria que crece: cada conversación cerrada agrega chunks + insights. El retrieval inyecta los mejores ejemplos del propio cliente → el agente "aprende" su estilo y sus objeciones reales **sin tocar el prompt base ni reentrenar**. Costo marginal: ~$0.001 por conversación (embeddings).

### Punto de integración (mínimo, no invasivo)
- `runConversation()` en `webhook.js`: 1 llamada nueva a `retrieve()` antes de `generateReply()`, su resultado va en `extraContext` (parámetro que ya acepta).
- Worker nuevo (cada N min): `ingest()` sobre conversaciones recién cerradas.

---

## TAREA 3 — Integración WhatsApp Business (API oficial)

> El backend ya está parcialmente hecho (`services/whatsapp.js` + handler en webhook,
> dormante). Falta: abstracción de canal formal, certificación Meta, bandeja unificada.

### Abstracción de canal (`services/channels/`)
```
services/channels/
  index.js          # send(channel, {...}) → despacha al adapter correcto
  instagram.js      # adapter IG (wrap de services/meta.js)
  whatsapp.js       # adapter WA (wrap de services/whatsapp.js)
  types.js          # interfaz común: send(), markRead(), within24hWindow()
```
Un mismo agente, un mismo `runConversation()`, el adapter resuelve el transporte. **El campo `lead.channel` ya existe** → la base está.

### Bandeja unificada (un lead, un hilo, multi-canal)
Problema: un lead que llega por IG y sigue por WhatsApp hoy serían **dos leads**. Solución:
```js
// lead.identities[] — vincula múltiples canales a un mismo contacto
{
  identities: [
    { channel: 'instagram', id: 'ig_123', username: '@juan' },
    { channel: 'whatsapp',  id: '5215555', name: 'Juan' },
  ],
  primary_channel: 'whatsapp',
}
```
Matching: por email/teléfono capturado, o por flujo explícito ("seguimos por WhatsApp? pasame tu número"). El `messages[]` se unifica bajo el `lead._id`.

### Compliance WhatsApp (crítico)
- **Ventana de 24h**: fuera de ella, **solo plantillas pre-aprobadas** por Meta. Dentro, mensajes libres. El helper `within24hWindow()` ya está esbozado en `services/whatsapp.js`.
- **Plantillas a aprobar** (Meta Business Manager, 1-3 días review):
  - `seguimiento_24h` (reabrir conversación inactiva)
  - `bienvenida_optin` (tras opt-in del lead)
- **Cero prospección fría automatizada por WhatsApp** (igual que IG).

### Certificación Meta — pasos
1. **Business Manager verificado** (requiere SpA/persona jurídica — en curso).
2. **WABA** (WhatsApp Business Account) creada + número dedicado (SIM nueva).
3. **Display name** aprobado (1-3 días).
4. **System User + token permanente** para la Cloud API.
5. **Webhook** suscrito a `messages` (ya soportado en `webhook.js`).
6. **Tech Provider / App Review** para operar en cuentas de clientes (multi-tenant) — el bloqueo grande, requiere SpA.

### Estimación de costos WhatsApp Cloud API (2026, MX/CL)
- **Conversaciones de servicio** (iniciadas por el usuario, dentro de 24h): **gratis** (las primeras 1.000/mes, luego ~$0.00-0.03).
- **Conversaciones de marketing/utility** (plantillas): MX ~$0.03-0.05, CL ~$0.05-0.08 por conversación de 24h.
- **Infra**: $0 extra (corre en el Railway actual).
- Para el ICP (negocios que responden inbound), la mayoría cae en service window → **costo casi nulo**.

---

## ROADMAP 30 / 60 / 90 días

### 30 días — Tarea 1 + base del RAG (sin romper nada)
- [ ] `agent.role` + migración idempotente (`nurture` default)
- [ ] `prospectAgent.js` + `prospectPrompt.js` (modo asistente: drafts en inbox)
- [ ] `selectAgent()` + `handoff_state` en leads
- [ ] UI: toggle de rol al crear agente + "draft sugerido" en inbox
- [ ] Tests en `conversationSimulator` para ambos roles
- [ ] Supabase project + migraciones SQL aplicadas (vacío, listo)
- **Hito**: cero prospección fría automatizada; el humano hace el primer toque con asistencia.

### 60 días — RAG operativo (memoria que crece)
- [ ] `services/rag/ingest.js` + worker de cierre de conversación
- [ ] `services/rag/retrieve.js` integrado en `runConversation` (few-shot dinámico)
- [ ] `services/rag/score.js` → lead scoring en CRM
- [ ] Backfill: ingest de las conversaciones históricas (las 26 del beta + las nuevas)
- **Hito**: el agente inyecta ejemplos reales del cliente; mejora medible en tasa de respuesta.

### 90 días — WhatsApp unificado + Tech Provider
- [ ] `services/channels/` (abstracción formal)
- [ ] Bandeja unificada (`lead.identities[]`)
- [ ] Plantillas WA aprobadas + ventana 24h
- [ ] Certificación Meta Tech Provider (post-SpA)
- **Hito**: un lead, un hilo, IG+WhatsApp; listo para escalar con ads.

---

## Resumen de decisiones que necesito de Brayan

| # | Decisión | Recomendación |
|---|---|---|
| A | RAG: Supabase híbrido vs migración total | **Híbrido** (no toca NeDB) |
| B | Embeddings: qué modelo | **OpenAI text-embedding-3-small** |
| C | Generación: OpenAI vs Claude | **OpenAI ahora**, Claude como A/B futuro |
| D | Orden de implementación | **Tarea 1 → 2 → 3** (urgencia + dependencias) |

Una vez confirmadas, arranco la **Tarea 1** (la más urgente y la que no depende de stack nuevo).
