# DMCloser — Deploy a Producción

Lista de pasos para que el SaaS quede listo para vender. Ordenado por prioridad: **lo crítico primero, lo nice-to-have al final**.

---

## 🚨 1. Persistencia de datos (CRÍTICO — hacelo HOY)

Railway containers son efímeros. Sin volumen montado, **cada deploy o restart pierde todos los datos** (usuarios, leads, mensajes, suscripciones).

### Pasos en Railway

1. Entrá a tu servicio en Railway → tab **Variables**
2. Agregá: `DB_PATH = /data`
3. Tab **Settings** → sección **Volumes** → **+ New Volume**
4. Mount path: `/data` · Size: 1 GB (alcanza para meses)
5. Railway hace redeploy automático

### Cómo verificar que quedó persistente

`GET https://dmcloser-app.up.railway.app/api/admin/health` — el campo `checks.database` debe decir `"NeDB persistente en /data"`. Si dice `⚠️ DB en path EFÍMERO`, no está bien configurado.

---

## 💳 2. Configurar billing (Lemon Squeezy + Mercado Pago)

### Lemon Squeezy (USD — para internacional + Chile/México/Colombia)

1. https://app.lemonsqueezy.com → crear store
2. Crear 3 productos: **Starter** ($197), **Pro** ($297), **Agency** ($497)
3. Copiar el `variant_id` de cada uno desde la URL del producto
4. **API Keys** → crear API Key
5. **Webhooks** → URL: `https://TU_DOMINIO/api/billing/ls-webhook`, signing secret guardarlo

Variables en Railway:
```
LS_API_KEY=tu_api_key
LS_STORE_ID=12345
LS_VARIANT_STARTER=111111
LS_VARIANT_PRO=222222
LS_VARIANT_AGENCY=333333
LS_WEBHOOK_SECRET=el_signing_secret
```

### Mercado Pago (CLP/ARS/MXN/BRL — CRÍTICO para LATAM)

**Sin MP perdés casi todo el mercado argentino y buena parte de Brasil.** Si solo vendés en Chile USD, podés saltearlo, pero la recomendación fuerte es activarlo.

1. https://www.mercadopago.cl/developers → crear app
2. Crear 3 planes con `preapproval_plan` (suscripción recurrente):
   - Starter: $180.000 CLP/mes
   - Pro: $270.000 CLP/mes
   - Agency: $450.000 CLP/mes
3. Copiá el `id` de cada plan
4. **Notificaciones** → URL: `https://TU_DOMINIO/api/billing/mp-webhook`

Variables:
```
MP_ACCESS_TOKEN=APP_USR-...
MP_PLAN_STARTER=2c93808...
MP_PLAN_PRO=2c93808...
MP_PLAN_AGENCY=2c93808...
```

---

## 📧 3. Emails transaccionales (Resend)

Sin esto, los emails (welcome, alerta lead HOT, lead magnet delivery, recompensa de referido) se guardan en `db.emailLog` pero NO salen al usuario.

1. https://resend.com → crear cuenta
2. Agregar dominio (`dmcloser.app` o tu dominio)
3. Configurar los DNS records (TXT, MX, DKIM) que Resend te muestra
4. Esperar verificación (5-30 min)
5. Crear API key

Variables:
```
RESEND_API_KEY=re_...
EMAIL_FROM=DMCloser <soporte@dmcloser.app>
APP_URL=https://dmcloser.app
```

---

## 🔐 4. Meta App + Instagram Business

1. https://developers.facebook.com → crear app
2. Agregar producto **Instagram** + **Webhooks**
3. Webhook URL: `https://TU_DOMINIO/webhook` con verify token random largo
4. Suscribirse a campos: `messages`, `messaging_postbacks`, `comments`
5. Aprobar permisos: `instagram_business_basic`, `instagram_business_manage_messages`
6. Solicitar **App Review** para uso público (toma 7-15 días)

Variables:
```
META_APP_ID=...
META_APP_SECRET=...
META_VERIFY_TOKEN=string_random_largo (mismo que pusiste en Meta)
```

---

## 🌐 5. Dominio custom (dmcloser.app)

Hoy: `dmcloser-app.up.railway.app`

1. Comprar el dominio (ya lo tenés según pricing)
2. Railway → **Settings** → **Domains** → Add custom domain → `dmcloser.app`
3. Apuntar el CNAME que Railway te indica desde tu DNS provider
4. Configurar también `www.dmcloser.app` (CNAME al mismo)
5. Esperar que SSL se provisione automáticamente
6. Actualizar `APP_URL` en envs a `https://dmcloser.app`

---

## 🚀 6. Aplicar el preset DMCloser a tu cuenta (dogfooding)

Para que el bot venda DMCloser usando DMCloser:

1. Iniciá sesión en `/admin` con tu cuenta admin
2. Tab **Usuarios** → click en tu usuario → **Ver**
3. Sección "🔄 Preset DMCloser"
4. Click **⚠️ Resetear y aplicar** (doble confirm)
5. Ahora la cuenta tiene: agente "Brian" con instrucciones Hormozi, knowledge real, 3 links DMCloser, 4 lead magnets

Después conectá tu Instagram Business real desde **Settings → Conectar Instagram**.

---

## 📊 7. Analytics (Plausible)

La landing ya tiene Plausible.io trackeo. Solo tenés que:

1. https://plausible.io → registrar `dmcloser.app`
2. Plausible te dará un dashboard donde ver:
   - Visitas a la landing
   - CTA clicks (con prop `position`: hero/mid/final)
   - Scroll depth (25/50/75/100%)
   - Outbound links

Si no querés usar Plausible, borrá los 2 tags `<script>` de Plausible en `public/home.html`.

---

## 📦 8. Resources de Lead Magnets

El preset DMCloser referencia estos URLs (que NO existen):
- `dmcloser.app/resources/guia-7-errores-dm.pdf`
- `dmcloser.app/resources/diagnostico`
- `dmcloser.app/resources/caso-exito-coach`
- `dmcloser.app/resources/audio-reglas-dm.mp3`

Tenés 2 opciones:
- **Subir los archivos reales** a tu dominio (en `public/resources/` o un bucket S3)
- **Cambiar las URLs** en `/app → Lead Magnets` por links a recursos que ya tengas (Drive, Dropbox, Notion público, etc)

---

## 💾 9. Backup periódico

`GET /api/admin/backup` descarga un JSON con TODOS los datos de la app.

**Recomendación**: hacerlo manualmente una vez por semana mientras el SaaS arranca. Después armar un cron job:

```bash
# Cron diario a las 3 AM
0 3 * * * curl -H "Authorization: Bearer $JWT_ADMIN" \
  https://dmcloser.app/api/admin/backup -o /backups/dmcloser-$(date +%F).json
```

Para restaurar: `POST /api/admin/restore` con el JSON + `{ "confirm": "YES" }`.

---

## 🎨 10. Branding final

- **og-cover.png**: hoy `home.html` usa `/icon-1024.png` como fallback. Generar uno propio de **1200×630px** con tu branding y reemplazar en `home.html` (hay un `<!-- TODO -->` que lo marca).
- **Favicon**: ya está (`/icon.svg`).
- **Casos de uso reales**: cuando tengas 3+ clientes con resultados, reemplazar los "casos típicos" en `home.html` por testimonios reales con foto + nombre + métrica.

---

## ✅ Checklist rápido pre-launch

- [ ] `DB_PATH=/data` + Volume montado en Railway → `/api/admin/health` dice "persistente"
- [ ] `META_APP_SECRET` configurado en Railway (sin esto el webhook devuelve 401 a TODO)
- [ ] LS configurado y un test de checkout pasa
- [ ] MP configurado (si target LATAM, especialmente Argentina)
- [ ] Resend con dominio verificado, email de welcome llega al inbox
- [ ] Meta App Review aprobada, webhook recibe DMs
- [ ] Dominio custom apuntado y SSL OK
- [ ] Preset DMCloser aplicado a tu cuenta + IG real conectado
- [ ] Plausible registrado y trackeando
- [ ] Recursos de lead magnets subidos (o URLs cambiadas)
- [ ] Backup de la DB descargado y guardado seguro
- [ ] `node scripts/verify-deploy.js` pasa los 16 checks (incluye verificación de seguridad post-fix)

Cuando todo esto esté ✅, el SaaS está listo para que pongas el primer ad y empieces a vender.

---

## 🔍 Verificación automática post-deploy

Hay un script que corre 16 checks contra producción y reporta verde/rojo:

```bash
node scripts/verify-deploy.js
# o contra otra URL:
node scripts/verify-deploy.js https://otra-url.up.railway.app
```

Ejecutalo siempre después de cada push para confirmar que no se rompió nada. Verifica:
- Endpoints públicos responden (home, /privacy, /terms, sitemap)
- Webhooks rechazan correctamente requests sin firma (Meta + LS)
- Endpoints protegidos requieren auth
- Headers de seguridad presentes (CSP, HSTS, X-Frame, Permissions-Policy)
- `X-Powered-By` ausente

Sale con código 0 si pasa todo, 1 si algo falla. Apto para CI/CD.
