# 🚀 DMCloser — Checklist final para salir a vender

**Estado actual** (verificado en vivo 25/04/2026):
- ✅ Bot conversacional Hormozi funcionando
- ✅ Inbox unificado, lead magnets, referidos, plantillas, cupones
- ✅ Analytics dashboard con KPIs + heatmap + funnel + comparativa + keywords + tabla filtrable
- ✅ CSV de 31 columnas
- ✅ Chat público en landing con bot real (verificado: responde Hormozi-style)
- ✅ Hero animado en vivo
- ✅ Plausible tracking
- ✅ SEO/OG/JSON-LD/sitemap
- ✅ Error monitoring + backup/restore
- ✅ Persistencia configurable

**Lo que YO hice por vos hoy** (no necesita acción tuya):
- Generé `/og-cover.html` listo para screenshot
- Animé el hero de la landing
- Creé `DOMAIN_SETUP.md` con guía DNS por provider
- Creé el endpoint `/api/admin/self-test` que valida 10 puntos del sistema
- Creé el endpoint `/api/admin/env-status` que muestra qué env vars faltan
- Probé el chat público end-to-end (responde como Brian, calificación antes del precio)

---

# 📋 LO QUE TENÉS QUE HACER VOS

Ordenado por prioridad. Tiempos reales.

## 🔴 BLOQUEANTE 1 · Persistencia DB (10 min)

**Sin esto, perdés todos los datos en cada deploy de Railway.**

1. Railway → tu servicio → **Variables** tab → **+ New Variable**
2. Nombre: `DB_PATH` · Valor: `/data` → **Add**
3. **Settings** tab → scroll hasta **Volumes** → **+ Create Volume**
4. Mount path: `/data` · Size: 1 GB → **Create**
5. Esperar redeploy automático (~1 min)
6. Verificar: hacé `GET https://dmcloser-app.up.railway.app/api/admin/health` (logueado como admin) → el campo `database` debe decir `"NeDB persistente en /data"` ✅

---

## 🔴 BLOQUEANTE 2 · Completar Lemon Squeezy (10 min)

Ya tenés `LS_API_KEY` y `LS_WEBHOOK_SECRET`. Te faltan **4 valores**:

1. Lemon Squeezy → **Settings → General → Store ID** (es un número como `82345`). Copialo.
2. **Products** → click en cada producto:
   - Starter → click en la variante → URL: `/products/X/variants/1570462` → **`LS_VARIANT_STARTER=1570462`** ✅ (ya me lo diste)
   - Pro → variant → **`LS_VARIANT_PRO=1570490`** ✅
   - Agency → variant → **`LS_VARIANT_AGENCY=1570496`** ✅
3. Railway → Variables → pegar:

```
LS_STORE_ID=<el número del paso 1>
LS_VARIANT_STARTER=1570462
LS_VARIANT_PRO=1570490
LS_VARIANT_AGENCY=1570496
```

4. Redeploy automático
5. Verificar: `GET /api/admin/self-test` → el test `lemonsqueezy` debe estar **pass** (verde)

---

## 🔴 BLOQUEANTE 3 · Configurar emails (15 min)

Ya tenés `RESEND_API_KEY`. Falta:

### A. Verificar dominio en Resend (5 min + espera DNS)
1. https://resend.com → **Domains** → Add `dmcloser.app`
2. Resend te muestra 4 DNS records (TXT MX DKIM SPF). Pegarlos en tu DNS provider.
3. Click **Verify**. Si no verifica de una, esperar 5-30 min y reintentar.

### B. Cloudflare Email Routing (5 min) — para RECIBIR emails
*Este paso solo aplica si tu DNS está en Cloudflare. Si no, decime qué provider usás.*

1. Cloudflare → tu dominio → **Email** → **Email Routing** → **Get started**
2. **Routes** → **+ Create address**:
   - Custom address: `soporte`
   - Action: Send to → tu Gmail personal
3. Cloudflare agrega los MX records automáticamente. Verificar.
4. Probá: enviá email a `soporte@dmcloser.app` desde tu celular. Debe llegar a tu Gmail en segundos.

### C. Pegar en Railway:
```
EMAIL_FROM=DMCloser <soporte@dmcloser.app>
EMAIL_REPLY_TO=soporte@dmcloser.app
```

5. Verificar: `GET /api/admin/self-test` → test `resend` debe estar **pass** con `1 dominio(s) verificado(s)`

---

## 🔴 BLOQUEANTE 4 · Conectar tu Instagram real (5 min)

1. Loguéate en `https://dmcloser-app.up.railway.app/app`
2. **Settings** → **Conectar Instagram** → OAuth con Meta
3. Autorizá los permisos (`instagram_business_basic`, `instagram_business_manage_messages`)
4. Verificar: `Settings → Cuenta` debe mostrar tu `@usuario_real` (no el demo).

---

## 🔴 BLOQUEANTE 5 · Aplicar preset DMCloser (1 min)

Para que tu cuenta sea el "demo en vivo" del bot vendiendo DMCloser:

1. `/admin` → **Usuarios** → click en tu user → **Ver**
2. Sección "🔄 Preset DMCloser" → **⚠️ Resetear y aplicar**
3. Confirmar 2 veces

Ahora tu cuenta tiene: agente "Brian", knowledge real con precios, 3 links DMCloser, 4 lead magnets.

---

## 🟡 IMPORTANTE 6 · Meta App Review (5 min de tu lado, 7-15 días Meta)

**Esto NO bloquea tus primeros 10 clientes**. Mientras esperás, agregás cada cliente como "tester" en Meta Dashboard manualmente.

1. https://developers.facebook.com → tu app DMCloser → **App Review**
2. **Permissions and Features** → solicitar:
   - `instagram_business_basic` ✅ Standard Access
   - `instagram_business_manage_messages` ✅ Standard Access
3. Llenar el formulario con video de 60s mostrando cómo se usa el bot
4. Submit → Meta tarda 7-15 días en aprobar

**Mientras esperás**: Meta Dashboard → **Roles → Testers** → agregás los IGs de tus primeros clientes manual. Hasta 25 testers permitidos.

---

## 🟡 IMPORTANTE 7 · Apuntar dmcloser.app a Railway (10 min)

Sigue **DOMAIN_SETUP.md** del repo. Resumen rápido:

1. Railway → Settings → Networking → **+ Custom Domain** → `dmcloser.app`
2. Tu DNS provider → CNAME `@` y `www` → el target que te dio Railway
3. Esperar 5-30 min (SSL automático)
4. Railway → Variables → editar `APP_URL=https://dmcloser.app` → save

**Si me decís en qué provider compraste el dominio**, te guío clic a clic.

---

## 🟡 IMPORTANTE 8 · Subir og-cover.png (5 min)

1. Andá a https://dmcloser-app.up.railway.app/og-cover.html (lee las instrucciones que le agregué)
2. F12 → DevTools → toggle device toolbar (Ctrl+Shift+M) → setear `1200×630`
3. Right-click sobre el cover → **Capture node screenshot**
4. Guardar como `og-cover.png`
5. Subilo al repo: `public/og-cover.png`
6. En `public/home.html` reemplazar las 2 referencias `icon-1024.png` → `og-cover.png`
7. Commit + push

---

## 🟡 IMPORTANTE 9 · Cuenta MP de tu novia (cuando esté lista)

1. Crear cuenta MP de ella → marketplace o developers
2. Crear 3 planes preapproval:
   - Starter: $180.000 CLP/mes
   - Pro: $270.000 CLP/mes
   - Agency: $450.000 CLP/mes
3. Pegar en Railway:

```
MP_ACCESS_TOKEN=APP_USR-...
MP_PLAN_STARTER=2c93808...
MP_PLAN_PRO=2c93808...
MP_PLAN_AGENCY=2c93808...
```

4. MP Dashboard → **Webhooks** → URL: `https://dmcloser.app/api/billing/mp-webhook`

---

## 🟢 NICE-TO-HAVE 10 · Resto

- **Plausible**: registrar `dmcloser.app` en https://plausible.io para ver analytics reales (el tracking ya está activo)
- **Backup automático**: armá un cron que llame `GET /api/admin/backup` 1x por semana → guardá el JSON en Drive/S3
- **Casos de éxito reales**: cuando tengas 3+ clientes, reemplazar los "casos típicos" en home.html por testimonios reales con foto

---

## ✅ Verificar que todo está listo para vender

Cuando termines los 5 bloqueantes (puntos 1-5), corré:

```
GET https://dmcloser-app.up.railway.app/api/admin/self-test
```

Debe devolver `"ready": true`. Si te dice false, mirá qué test está en **fail** y corregilo.

Si querés UI: `GET https://dmcloser-app.up.railway.app/api/admin/env-status` te muestra qué env vars están seteadas con flags booleanos.

---

## 🎯 Cronograma realista

| Cuándo | Qué |
|---|---|
| **HOY** | Bloqueantes 1-5 (45 min total). Ya podés vender a tu red. |
| **Mañana** | Bloqueante 6 (Meta App Review submit) + 7 (DNS) |
| **Esta semana** | 8 (og-cover) + 9 (MP cuando esté) |
| **Próximas 2 semanas** | Mientras Meta procesa la review, vendés a 5-10 contactos personales con descuento "fundadores" |
| **+1-2 semanas** | Meta Review aprobada → escalar con ads/outreach frío |

---

## 🤝 Cuando lances

**Estrategia para los primeros 5 clientes** (lo que más recomiendo):

1. Lista mental de coaches/agencias/infoproductos que conozcas en LATAM
2. DM personal: *"Eh, estoy lanzando DMCloser, un bot de IA para Instagram que califica leads y agenda citas solo. ¿Te bancás probarlo gratis 1 mes con descuento de fundador? Solo necesito feedback honesto."*
3. Cobrar **50% off los primeros 3 meses** ($148 USD) — el cliente arriesga poco, vos validás
4. Activá su cuenta como **tester en Meta Dashboard** mientras esperás Review
5. Onboarding personal de 30 min vía Zoom: les dejás todo configurado
6. A los 7 días, pedís testimonio + caso de éxito → reemplazás los placeholders en home.html

Con 5 clientes pagando $148/mes ya cubrís OpenAI + Railway + Resend con sobra. Y validaste el producto.

---

**Cualquier paso que te trabe, decime y vamos juntos.**
