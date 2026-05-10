# Atinov — Guía de configuración de pagos

Este documento te explica paso a paso cómo configurar los dos proveedores de pago: **Lemon Squeezy** (USD internacional) y **Mercado Pago** (CLP Chile).

---

## 🍋 LEMON SQUEEZY (USD · Internacional)

### 1. Crear cuenta y store
1. Ve a https://app.lemonsqueezy.com/register
2. Completa el registro (selecciona Chile como país; LS acepta sellers chilenos)
3. Crea una Store:
   - Name: `Atinov`
   - Currency: `USD`
   - Default country: `Chile`

### 2. Crear los 3 productos de suscripción
En el dashboard de LS → **Products** → **New product**. Repite para cada plan:

| Plan    | Name                   | Price    | Billing     |
|---------|------------------------|----------|-------------|
| Starter | Atinov Starter       | $197 USD | Monthly     |
| Pro     | Atinov Pro           | $297 USD | Monthly     |
| Agency  | Atinov Agency        | $497 USD | Monthly     |

Cada producto tiene una **variant** — copia el `variant_id` desde la URL o la tabla de variants.

### 3. Obtener credenciales
- **API Key**: Settings → API → Create API Key → copia el token
- **Store ID**: Settings → Stores → tu store → ID visible en la URL o card
- **Webhook Secret**: Settings → Webhooks → New webhook
  - URL: `https://TU_DOMINIO_RAILWAY.up.railway.app/api/billing/ls-webhook`
  - Events: marca `subscription_created`, `subscription_payment_success`, `subscription_payment_failed`, `subscription_cancelled`, `subscription_expired`
  - Copia el `Signing secret`

### 4. Pegar en Railway → Variables
```
LS_API_KEY=eyJ0eXAi...
LS_STORE_ID=123456
LS_WEBHOOK_SECRET=whsec_...
LS_VARIANT_STARTER=111111
LS_VARIANT_PRO=222222
LS_VARIANT_AGENCY=333333
```

---

## 🇨🇱 MERCADO PAGO (CLP · Chile)

### 1. Crear cuenta
1. Ve a https://www.mercadopago.cl/developers/panel
2. Inicia sesión con tu cuenta MP Chile (o regístrate)
3. Ve a **Tus integraciones** → **Crear aplicación**
   - Nombre: `Atinov`
   - Tipo: `Pagos online` + `Suscripciones`

### 2. Crear los 3 preapproval plans
Usa este comando cURL (reemplaza `ACCESS_TOKEN` con tu token de producción):

```bash
# Plan STARTER
curl -X POST https://api.mercadopago.com/preapproval_plan \
  -H "Authorization: Bearer ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "reason": "Atinov Starter",
    "auto_recurring": {
      "frequency": 1,
      "frequency_type": "months",
      "transaction_amount": 180000,
      "currency_id": "CLP"
    },
    "back_url": "https://TU_DOMINIO_RAILWAY.up.railway.app/?billing=success&plan=starter&provider=mp"
  }'

# Plan PRO (cambia reason y transaction_amount a 270000)
# Plan AGENCY (cambia reason y transaction_amount a 450000)
```

Guarda el `id` que devuelve cada request.

### 3. Obtener credenciales
- **Access Token**: Panel developer → tu app → Credenciales de producción → Access Token
- **Webhook**: tu app → Webhooks → URL de notificación
  - URL: `https://TU_DOMINIO_RAILWAY.up.railway.app/api/billing/mp-webhook`
  - Eventos: marca `subscription_preapproval` y `subscription_authorized_payment`

### 4. Pegar en Railway → Variables
```
MP_ACCESS_TOKEN=APP_USR-...
MP_PLAN_STARTER=2c938...
MP_PLAN_PRO=2c938...
MP_PLAN_AGENCY=2c938...
```

Los precios CLP ya están hardcodeados como defaults; solo configúralos si quieres cambiarlos.

---

## ✅ VERIFICACIÓN POST-DEPLOY

Una vez configurado todo en Railway, verifica:

1. **Status de billing** → `GET /api/billing/status` debe devolver JSON con `plan`, `daysLeft`, etc.
2. **Logs de Railway** al arrancar deben mostrar:
   ```
   💳 LS Webhook         → http://localhost:PORT/api/billing/ls-webhook
   💳 MP Webhook         → http://localhost:PORT/api/billing/mp-webhook
   ```
3. **Test de checkout LS**: Login en la app → `/upgrade` → tab USD → Elegir Pro → deberías ser redirigido a LS
4. **Test de checkout MP**: tab CLP → Elegir Pro → deberías ser redirigido a MP

## 💰 COMISIONES

| Proveedor      | Comisión        | Moneda | Payout       |
|----------------|-----------------|--------|--------------|
| Lemon Squeezy  | 5% + $0.50 USD  | USD    | Semanal (wise/bank) |
| Mercado Pago CL| ~3.19% + IVA    | CLP    | Al día hábil siguiente |

LS actúa como **Merchant of Record** — ellos manejan VAT/taxes internacionales, chargebacks y facturación a clientes. MP es pasarela directa.
