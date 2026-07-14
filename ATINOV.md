# ATINOV — Documento maestro del proyecto

> Contexto completo del proyecto para trabajar desde cualquier entorno (repo, chats de Claude, celular).
> **Sin secretos**: las credenciales se referencian solo por nombre de variable de entorno.
> Última actualización: 2026-07-07.

---

## 1. Qué es Atinov

**Atinov** es un SaaS de inteligencia artificial que atiende el inbox de **Instagram y WhatsApp** de negocios: responde cada DM al instante con la información del negocio, **califica** a cada persona (score de 0-100 de probabilidad de compra) y avisa al dueño cuándo entrar a cerrar. El pitch diferenciador: **"Los bots responden. Atinov aprende"** — cada conversación (venda o no) se convierte en inteligencia de mercado para el negocio.

- **Posicionamiento**: "Asistente de inbox para Instagram Business". PROHIBIDO usar las palabras "bot", "setter", "automatización", "captación de leads" en copy público (causaron el rechazo del procesador de pagos en 2026-05).
- **Fundador**: Brayan Villalobos, La Serena, Chile. Proyecto principal #1 (meta personal: $5K USD/mes).
- **Historia**: nació como "DMCloser"; el 2026-05-09 se rebrandeó a **Atinov** tras el rechazo de Lemon Squeezy (el nombre "DM+Closer" + copy de automatización = categoría restringida por Stripe). **Nunca usar "DMCloser" ni "Lemon Squeezy" en nada nuevo.**
- **Por qué "Atinov"**: inventado, brandable, pronunciable en español (a-ti-NOV), evoca *atinar* (dar en el blanco), SEO virgen, 15 TLDs libres al momento de elegirlo.

## 2. Modelo de negocio

| Item | Valor |
|---|---|
| Plan único | **Founder $148 USD/mes** (o $135.000 CLP/mes) |
| Cupos | 20 fundadores, precio congelado de por vida (ancla: $296 "precio público") |
| Ancla de venta | Setter humano part-time = $600+ USD/mes |
| Trial | 3 días gratis sin tarjeta + garantía reembolso 7 días |
| Procesador CLP | **Mercado Pago Chile** (cuenta vendedor activa; credenciales/plan PENDIENTES — bloqueador #1 para cobrar) |
| Procesador USD | Polar.sh (aplicación pendiente) |
| Incluye | IG + WhatsApp, 6.000 conversaciones/mes, 5 agentes, panel inteligencia, score+CRM, alertas Telegram/email, export Excel |

## 3. Marca e identidad visual (definitiva, 2026-07-01)

- **Logo**: wordmark **"ATINOV" en Cinzel 500** (capitales romanas tipo Trajan), interletrado amplio, + **filete partido** (línea fina interrumpida por un rombo hueco al centro). **Blanco puro sobre negro `#0a0a0a`** — monocromo deliberado (estilo Chanel/The Row). El dorado `#c9a227` es acento OPCIONAL y quirúrgico (nunca en el logo).
- **Derivados**: avatar de redes = "A" Cinzel + filete partido · favicon/ícono app = rombo solo.
- **Paleta**: negro `#0a0a0a` / blanco hueso `#f5f2ea` / dorado `#c9a227` (acento) / grises cálidos. Hairlines `rgba(245,242,234,.16)`.
- **Tipografías**: **Cinzel** (display/títulos) + **Inter** (cuerpo).
- **Reglas**: cero gradientes, cero emojis de UI, cero sombras duras, línea fina y aire. El logo nunca lleva tagline (los grandes no explican qué hacen).
- **Assets**: `branding/social/` en el repo — logo principal/inversa (2400px), avatar 1080, banners LinkedIn/X/Facebook/YouTube a medida, og-cover 1200×630, icon 512.
- ⚠️ Paleta esmeralda `#10b981` = la identidad ANTERIOR (aún viva en la app/dashboard; en migración hacia la nueva).

## 4. Presencia digital

| Canal | Estado | Dónde |
|---|---|---|
| Dominio | ✅ LIVE | `atinov.com` (Cloudflare, **DNS-only/nube gris SIEMPRE** — proxy naranja rompe TLS en Chile) |
| Web/App | ✅ LIVE | https://atinov.com (Railway; subdominio legacy `dmcloser-app.up.railway.app` pendiente de rename) |
| Correo | ✅ COMPLETO | `contacto@atinov.com` y `soporte@atinov.com` — reciben vía Cloudflare Email Routing → Gmail del founder; envían desde Gmail vía SMTP Resend. Filtro Gmail anti-spam para @atinov.com activo |
| Instagram | ✅ Creado | **@atinov.ia** (@atinov estaba tomado) |
| Facebook Page | ✅ Creada | "Atinov", id `61591637547934` |
| LinkedIn | ✅ Creada | **linkedin.com/company/atinov-ia** |
| Pendientes redes | — | Fotos de perfil/portada (manual), Google Business Profile, reservar X/TikTok/YouTube, primer post |
| Analytics | ✅ | Plausible en atinov.com |

## 5. Producto — funcionalidades en producción

1. **Agente IA conectado a Instagram** (API oficial Meta, OAuth) que responde DMs con la Knowledge Base del negocio. Dos roles: *nurture* (auto, inbound) y *prospect* (asiste al humano, nunca envía frío).
2. **RAG con Supabase pgvector** (proyecto `atinov-rag`, embeddings OpenAI `text-embedding-3-small`, umbral similitud 0.35): el agente aprende de conversaciones ganadas/perdidas; ingest automático al cerrar un lead.
3. **Panel de Inteligencia**: objeciones top, motivos de pérdida, "lo que funciona", extraídos de las conversaciones.
4. **Huecos de conocimiento**: cuando el agente no sabe algo, trae la pregunta al dueño ("Tu agente necesita aprender esto") → el dueño responde una vez → knowledge permanente.
5. **Score CRM 0-100** por lead (comparado contra ventas reales) + kanban ordenado por score.
6. **Reporte semanal por email** (lunes, idempotente; requiere Resend verificado).
7. **Export Excel nativo** (XLSX 4 hojas con librería `write-excel-file`; CSV solo para importar a otros CRMs — Excel es-CL usa punto y coma, por eso XLSX).
8. **Chat de landing = recolector autónomo**: el chat público de atinov.com ES el agente real; persiste visitantes como leads canal `landing` en el CRM del founder (captura email/tel/@IG por regex). Probado E2E.
9. **WhatsApp Business**: backend listo (`services/channels/`, bandeja unificada, merge de identidades) pero **dormante** hasta tener WABA.
10. **Temas personalizables** en el dashboard (6 acentos + 4 fondos).

## 6. Stack técnico

| Capa | Tecnología |
|---|---|
| Backend | Node.js + Express (monolito) |
| DB local | NeDB (archivos; leads/agentes/conversaciones) |
| DB vectorial | Supabase pgvector (solo RAG) |
| LLM | OpenAI (GPT-4o para agentes; embeddings small) |
| Hosting | Railway (deploy por git push) |
| DNS/Email routing | Cloudflare |
| Email transaccional | Resend (dominio atinov.com, región São Paulo) |
| Mensajería | Meta Graph API (Instagram DM + WhatsApp Cloud dormante) |
| Frontend | HTML/CSS/JS vanilla servido por Express (`public/`) — sin framework |
| Analytics | Plausible |

**Repo**: `Brianvilla23/autosetter-app` (GitHub; el nombre del repo es legacy, no renombrado). Carpeta local: `C:\Users\braya\OneDrive\Escritorio\Claude\autosetter-app`.

**Estructura relevante**:
```
/server.js              entrada
/routes/                intelligence.js, etc.
/services/              atinovPreset.js, weeklyReport.js, whatsapp.js,
                        rag/ (supabase/ingest/retrieve/score), channels/ (core + dispatcher)
/config/agentRoles.js   roles nurture/prospect
/public/                home.html (landing LIVE), home-v3.html (rediseño en aprobación),
                        index.html (dashboard SPA), admin.html, pricing/privacy/terms/about/contact,
                        main.js, styles.css
/branding/social/       assets de marca (PNG)
/scripts/verify-deploy.js   ~19 checks automatizados contra producción
/docs/                  DEPLOY_PRODUCTION.md, LAUNCH_CHECKLIST.md
```

**Variables de entorno clave (solo nombres — valores en Railway)**: `OPENAI_API_KEY`, `META_APP_ID`/`META_APP_SECRET` (⚠️ hay DOS apps Meta: usar la sub-app, no la principal), `META_VERIFY_TOKEN`, `APP_URL=https://atinov.com`, `RESEND_API_KEY`, `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` (formato nuevo `sb_secret_...`), `RAG_MIN_SIMILARITY=0.35`, `MP_ACCESS_TOKEN`+`MP_PLAN_*` (**vacías = bloqueador de cobro**), `LS_*` (deprecadas, no usar).

## 7. Estado actual (2026-07-07)

**Funcionando y verificado**:
- atinov.com LIVE con cert Railway directo, app 19/19 checks, webhook Meta respondiendo en el dominio nuevo
- RAG activo (si aparece vacío tras inactividad: `POST /api/admin/rag/backfill {mode:'all'}`)
- Correo corporativo completo (recibir + enviar verificado)
- Chat de landing capturando leads
- Redes sociales creadas (IG/FB/LinkedIn)
- Logo e identidad visual definitivos + assets generados
- **WhatsApp end-to-end VERIFICADO** (2026-07-14) con el número de PRUEBA de Meta: el agente recibe, procesa, crea lead y responde por WhatsApp igual que en Instagram. Se arreglaron 3 bugs de plataforma (WABA sin suscribir, firma 401 por doble app de Meta → validar ambos secrets, `needs_reauth` de IG bloqueaba WA). Limitación del número de prueba: solo responde a 5 números pre-autorizados (NO es bug — desaparece con número de producción).

**En curso**:
- **Landing v3** (`public/home-v3.html`): rediseño completo con la identidad negro/Cinzel/filete — pendiente aprobación del founder para reemplazar a `home.html` (+ swap de favicon y og-cover)

**Bloqueadores / pendientes priorizados**:
1. 🔴 **Mercado Pago**: crear app en developers MP, cargar `MP_ACCESS_TOKEN`, crear preapproval_plan Founder $135.000 CLP + webhook. Sin esto no se puede cobrar.
2. 🔴 **Bugs reportados por el founder en la app** (lista pendiente de detallar) + auditoría con `scripts/verify-deploy.js` y logs Railway.
3. 🟠 **Rediseño del dashboard** a la identidad nueva + mejoras de estructura/UX.
4. 🟠 Confirmar webhook Meta con DM de prueba → renombrar subdominio Railway `dmcloser-app` → `atinov-app` → revisar OAuth redirect (`https://atinov.com/auth/callback` en Meta App).
5. 🟡 Knowledge Base del agente demo tiene precios viejos ($197 → real $148/135k).
6. 🟡 Verificar estado "Verified" de atinov.com en Resend (destraba reporte semanal).
7. 🟡 Redes: subir fotos, GBP, reservar handles, primer post, "Acerca de" LinkedIn.
8. 🟠 **WhatsApp a PRODUCCIÓN** (2 fases):
   - **Fase A — número propio de Atinov** (rápido, quita el límite de 5): comprar SIM/número NUEVO dedicado (nunca usado en la app de WhatsApp; capaz de recibir SMS/llamada para el código; evitar VoIP gratis que Meta rechaza; NO el personal). En Meta → WhatsApp → Paso 2 "Registra tu número" → verificar código → nombre visible. En Atinov: cambiar el `wa_phone_number_id` de prueba por el real + token permanente (System User, no el de 24h). Con un número real registrado, responder a inbound (ventana 24h) funciona para CUALQUIERA, sin lista blanca, aun antes de App Review.
   - **Fase B — autoservicio de clientes (Embedded Signup)**: Business Verification de Atinov + App Review (advanced access whatsapp_business_management/messaging) + Tech Provider + construir botón "Conectar WhatsApp" (Facebook JS SDK + endpoint token-exchange). Después de esto, cada cliente conecta su WhatsApp solo en ~2 min (popup Meta, sin pasos técnicos, WABA auto-suscrita, token auto-gestionado). El backend ya está listo (webhook dual-secret, envío, campos por-cuenta, refresh). El flujo manual de hoy (Explorador API, suscribir WABA, pegar token) NO lo hace ningún cliente.
9. 🟢 Futuro: Polar.sh, SpA, comprar atinov.app, Loom v2, anuncio + 20 testers.

## 8. Reglas y lecciones permanentes del proyecto

1. **Nunca** "DMCloser", "Lemon Squeezy", "bot/setter/automatización" en copy público.
2. **Cloudflare + Railway = nube GRIS (DNS-only) siempre**; el proxy naranja rompe TLS con ISPs chilenos.
3. Verificar dominios con DNS 1.1.1.1, no 8.8.8.8 (falsos "libres").
4. Railway: cambio de env-var NO reinstala dependencias; si `require` falla, forzar rebuild.
5. Dos IDs de app Meta — la sub-app es la correcta; `graph.facebook.com` ≠ `graph.instagram.com`.
6. Los emails de verificación reenviados por Cloudflare pueden caer a spam de Gmail (ya mitigado con filtro para @atinov.com).
7. Sesión Cloudflare vencida = dashboard colgado en spinner; se arregla re-entrando con Google SSO.
8. El agente del chat público se llama **"Atinov Sales"** y debe estar *enabled* (el chat lo busca por nombre).
9. Excel es-CL: separador punto y coma → exportar XLSX nativo, no CSV.
10. Rebrand barato antes de clientes; con clientes es 100x más caro. Tiempo > nombre perfecto.

## 9. Contexto comercial

- **ICP**: negocios hispanohablantes con alto volumen de DMs — clínicas estéticas, dermatólogos, dentistas, inmobiliarias, tiendas IG, coaches.
- **Mentor**: Alejo Muñoz (framework: 3 momentos + 4 ángulos de ICP).
- **Estrategia de lanzamiento**: 20 cupos fundadores con precio congelado + demo en vivo en la landing (sin testimonios inventados — FAQ lo explica con honestidad) + outbound IG personal (playbook aparte).
- **Sinergias**: Atinov es la "ventaja injusta" de la futura Agencia IA Canadá (mismo motor, mercado canadiense) y de los derivados (bot WhatsApp para ATINOV-servicios, detector de prospectos con Google Places).

---

*Para retomar trabajo en un chat nuevo de Claude: pegar este documento completo como contexto inicial, o referenciar este archivo del repo. Las credenciales viven únicamente en Railway/Cloudflare/gestor de contraseñas del founder — nunca en este documento ni en el repo.*
