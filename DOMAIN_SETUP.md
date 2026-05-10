# 🌐 Apuntar `atinov.com` a Railway

**Importante**: Yo (Claude) no puedo hacer esto por vos. La configuración DNS es en el **provider donde compraste el dominio** (Namecheap, GoDaddy, Google Domains, Cloudflare, etc) y solo vos tenés acceso a esa cuenta.

Te dejo los pasos para los providers más comunes. Es 5-10 minutos de trabajo.

---

## Paso 1: Conseguir el target de Railway

1. Andá a https://railway.app → tu proyecto **autosetter-app**
2. **Settings** → tab **Networking** → **Custom Domain**
3. Click **+ Custom Domain** → escribí `atinov.com` → Submit
4. Railway te da algo como: `xxx-production.up.railway.app` o un valor para CNAME

5. **Repetí** para `www.atinov.com` (también Custom Domain).

---

## Paso 2: Configurar DNS según tu provider

### 🟧 Cloudflare (recomendado, gratis + más rápido)

1. https://dash.cloudflare.com → tu dominio `atinov.com` → **DNS** → **Records**
2. **Eliminá cualquier A record o CNAME existente para `@` y `www`** que tengas
3. **+ Add record**:
   - **Type**: CNAME
   - **Name**: `@`
   - **Target**: `xxx-production.up.railway.app` (lo que te dio Railway)
   - **Proxy status**: **DNS only** (nube gris, NO naranja — Railway hace su propio SSL)
4. **+ Add record** otro:
   - **Type**: CNAME
   - **Name**: `www`
   - **Target**: el mismo target de arriba
   - **Proxy status**: DNS only
5. Save

⏱️ Cloudflare propaga en 1-5 minutos. Railway emite SSL automáticamente en otros 1-2 minutos.

### 🟦 Namecheap

1. https://ap.www.namecheap.com → **Domain List** → click en `atinov.com` → **Manage**
2. Tab **Advanced DNS** → **Host Records**
3. Eliminar URL Redirect Records y A records existentes para `@` y `www`
4. **Add New Record**:
   - **Type**: CNAME Record
   - **Host**: `@`
   - **Value**: `xxx-production.up.railway.app`
   - **TTL**: Automatic
5. **Add New Record** otro:
   - **Type**: CNAME Record
   - **Host**: `www`
   - **Value**: el mismo
6. Save All Changes

⚠️ Namecheap a veces no permite CNAME en `@` (apex). Si te tira error:
- Usá **ALIAS Record** en lugar de CNAME (mismo target)
- O usá CNAME solo en `www` y un **URL Redirect** de `@` → `www.atinov.com`

### 🟩 GoDaddy

1. https://dcc.godaddy.com → **My Products** → tu dominio → **DNS**
2. Eliminar A y CNAME records existentes para `@` y `www`
3. **Add → CNAME**:
   - **Name**: `@`
   - **Value**: `xxx-production.up.railway.app`
4. Repetir para `www`
5. Save

### 🔵 Google Domains / Squarespace

1. https://domains.google.com → tu dominio → **DNS** → **Resource records**
2. **Create new record**:
   - **Host name**: vacío (es @)
   - **Type**: CNAME
   - **Data**: `xxx-production.up.railway.app`
3. Otro record para `www` (mismo target)
4. Save

---

## Paso 3: Verificar que funciona

Después de 5-30 minutos:

1. Abrí https://www.whatsmydns.net/#CNAME/atinov.com
2. Debería resolver al target de Railway en la mayoría de servidores del mundo
3. Probá https://atinov.com y https://www.atinov.com en el browser
4. Railway → **Settings → Networking** debería mostrar ✅ verde junto a tu dominio (con SSL emitido)

---

## Paso 4: Actualizar APP_URL en Railway

Cuando el dominio funcione:

1. Railway → **Variables** → editar `APP_URL`
2. Nuevo valor: `https://atinov.com`
3. Save → redeploy automático

Esto hace que:
- Los emails de welcome / referral tengan link a `atinov.com/app` (no a railway.app)
- El sitemap.xml tenga URLs correctas
- OpenGraph image refleje la URL canónica

---

## ❓ ¿Dónde compraste el dominio?

Si no recordás, podés averiguarlo así:

```bash
whois atinov.com
```

(o usá https://www.whois.com/whois/atinov.com)

Te muestra el "Registrar" — ese es tu provider.

---

## 🆘 Si algo falla

Lo más común:
- **"DNS not propagated"**: esperá más, hasta 24h en algunos providers (raro)
- **"SSL pending"**: Railway puede tardar hasta 30 min en emitir el certificado después de que DNS resuelve
- **CNAME en `@` no permitido**: usá ALIAS o ANAME (Cloudflare/Namecheap los soportan), o redirect del `@` al `www`

Decime en qué provider tenés el dominio y te guío paso a paso.
