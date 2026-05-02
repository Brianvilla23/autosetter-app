/* ══════════════════════════════════════════════
   AUTOSETTER — Dashboard main.js
══════════════════════════════════════════════ */

const API = '';  // same origin
let ACCOUNT_ID = '';
let AUTH_TOKEN  = '';
let CURRENT_USER = null;
let currentAgent = null;
let testerHistory = [];
let leadsRefreshInterval = null;
let currentLeadId = null;
let chatRefreshInterval = null;

// ── INIT ─────────────────────────────────────────────────────────────────────
async function init() {
  // Capturar ?ref=CODIGO si vino directo a /app sin pasar por la landing
  try {
    const refFromUrl = new URLSearchParams(location.search).get('ref');
    if (refFromUrl) {
      sessionStorage.setItem('ref_code', refFromUrl);
      localStorage.setItem('ref_code', refFromUrl);
      // Trackear click best-effort
      fetch('/api/referrals/track-click', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: refFromUrl }),
      }).catch(() => {});
    }
  } catch {}

  // Check if first-time setup needed
  const check = await fetch('/api/user/check').then(r => r.json()).catch(() => ({ hasUsers: false }));

  if (!check.hasUsers) {
    // First-time: show setup screen (creates admin)
    showAuthScreen('setup');
    return;
  }

  // Check stored token
  const stored = localStorage.getItem('autosetter_token');
  if (stored) {
    AUTH_TOKEN = stored;
    const userData = localStorage.getItem('autosetter_user');
    if (userData) CURRENT_USER = JSON.parse(userData);
    ACCOUNT_ID = CURRENT_USER?.accountId || '';
    showDashboard();
  } else {
    // Check if coming from pricing page wanting to register
    const authMode = sessionStorage.getItem('auth_mode');
    sessionStorage.removeItem('auth_mode');
    showAuthScreen(authMode === 'register' ? 'register' : 'login');
  }
}

function showDashboard() {
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('app-shell').style.display   = 'flex';
  // Update user info in sidebar
  const nameEl = document.getElementById('sidebar-user-name');
  if (nameEl && CURRENT_USER) nameEl.textContent = CURRENT_USER.name;
  initNav();
  loadSection('home');

  // Close upgrade modal button
  const closeBtn = document.getElementById('btn-close-upgrade');
  if (closeBtn) closeBtn.onclick = () => document.getElementById('upgrade-modal').style.display = 'none';

  // Check URL params (OAuth + billing returns)
  const params = new URLSearchParams(window.location.search);
  if (params.get('auth') === 'success') {
    showToast('✅ Instagram conectado: ' + params.get('ig'));
    window.history.replaceState({}, '', '/app');
    loadSection('settings');
  } else if (params.get('auth') === 'error') {
    showToast('❌ ' + decodeURIComponent(params.get('msg') || 'Error desconocido'));
    window.history.replaceState({}, '', '/app');
  } else if (params.get('billing') === 'success') {
    const plan = params.get('plan') || 'plan';
    const provider = params.get('provider') || '';
    const planName = plan.charAt(0).toUpperCase() + plan.slice(1);
    const providerLabel = provider === 'ls' ? ' (Lemon Squeezy)' : provider === 'mp' ? ' (Mercado Pago)' : '';
    showToast(`🎉 ¡Suscripción activada! Bienvenido al plan ${planName}${providerLabel}`);
    window.history.replaceState({}, '', '/app');
    loadBillingStatus();
  } else if (params.get('billing') === 'cancelled') {
    showToast('Pago cancelado. Tu prueba gratuita sigue activa.');
    window.history.replaceState({}, '', '/app');
  }

  // Always check billing status on load
  loadBillingStatus();
}

function showAuthScreen(mode) {
  document.getElementById('auth-screen').style.display = 'flex';
  document.getElementById('app-shell').style.display   = 'none';
  renderAuthForm(mode);
}

function renderAuthForm(mode) {
  const box = document.getElementById('auth-box');

  if (mode === 'login') {
    box.innerHTML = `
      <div class="auth-logo">⚡ DMCloser</div>
      <h2 class="auth-title">Iniciar sesión</h2>
      <p class="auth-sub">Accede a tu panel de control</p>
      <input class="auth-input" id="auth-email" type="email" placeholder="Email" autocomplete="email">
      <input class="auth-input" id="auth-password" type="password" placeholder="Contraseña" autocomplete="current-password">
      <div id="auth-error" class="auth-error" style="display:none"></div>
      <button class="btn-primary auth-btn" id="auth-submit">Entrar</button>
      <p class="auth-footer">¿Nuevo aquí? <a href="#" id="auth-to-register" style="color:var(--orange);font-weight:600">Crear cuenta gratis →</a></p>
    `;
    document.getElementById('auth-submit').onclick = () => submitAuth('login');
    document.getElementById('auth-password').addEventListener('keydown', e => { if (e.key === 'Enter') submitAuth('login'); });
    document.getElementById('auth-to-register').onclick = (e) => { e.preventDefault(); showAuthScreen('register'); };
    document.getElementById('auth-email')?.focus();

  } else if (mode === 'register') {
    box.innerHTML = `
      <div class="auth-logo">⚡ DMCloser</div>
      <h2 class="auth-title">Crear cuenta gratis</h2>
      <p class="auth-sub">3 días de prueba gratuita. Sin tarjeta de crédito.</p>
      <input class="auth-input" id="auth-name" type="text" placeholder="Tu nombre" autocomplete="name">
      <input class="auth-input" id="auth-email" type="email" placeholder="Email" autocomplete="email">
      <input class="auth-input" id="auth-password" type="password" placeholder="Contraseña (mín. 6 caracteres)" autocomplete="new-password">
      <input class="auth-input" id="auth-password2" type="password" placeholder="Confirmar contraseña" autocomplete="new-password">

      <!-- Sección: personalización del bot (opcional pero recomendada) -->
      <div style="margin:14px 0 6px 0;padding:14px;background:linear-gradient(135deg,rgba(255,107,53,0.08),rgba(255,107,53,0.02));border:1px solid rgba(255,107,53,0.25);border-radius:10px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
          <span style="font-size:18px">✨</span>
          <strong style="font-size:13.5px;color:var(--orange)">Personaliza tu bot en 1 minuto</strong>
          <span style="font-size:11px;color:var(--text-3,#888);margin-left:auto">opcional</span>
        </div>
        <p style="font-size:12px;color:var(--text-3,#888);margin:0 0 10px 0;line-height:1.4">
          Cuéntanos sobre tu negocio para configurar tu asistente IA automáticamente. Si lo dejas vacío, lo editas después en el dashboard.
        </p>
        <input class="auth-input" id="biz-nicho" type="text" placeholder="Tu nicho (ej: coach de menopausia, inmobiliaria CDMX)" style="margin-bottom:8px">
        <input class="auth-input" id="biz-servicio" type="text" placeholder="Servicio principal (ej: mentoría 1-on-1 12 semanas)" style="margin-bottom:8px">
        <input class="auth-input" id="biz-precio" type="text" placeholder="Precio o rango (ej: $500-$1500 USD)" style="margin-bottom:8px">
        <input class="auth-input" id="biz-cliente-ideal" type="text" placeholder="Cliente ideal (ej: mujeres 40-55 con perimenopausia)" style="margin-bottom:8px">
        <input class="auth-input" id="biz-link-agenda" type="url" placeholder="Tu link de agenda/Calendly/WhatsApp (opcional)">
      </div>

      <div id="auth-error" class="auth-error" style="display:none"></div>
      <button class="btn-primary auth-btn" id="auth-submit">Crear cuenta y comenzar →</button>
      <p class="auth-legal" style="font-size:12px;color:var(--text-3,#888);text-align:center;margin-top:12px;line-height:1.5">
        Al crear la cuenta aceptás nuestros
        <a href="/terms.html" target="_blank" style="color:var(--orange)">Términos</a>
        y la <a href="/privacy.html" target="_blank" style="color:var(--orange)">Política de Privacidad</a>.
      </p>
      <p class="auth-footer">¿Ya tienes cuenta? <a href="#" id="auth-to-login" style="color:var(--orange);font-weight:600">Iniciar sesión</a></p>
    `;
    document.getElementById('auth-submit').onclick = () => submitAuth('register');
    document.getElementById('auth-password').addEventListener('keydown', e => { if (e.key === 'Enter') submitAuth('register'); });
    document.getElementById('auth-to-login').onclick = (e) => { e.preventDefault(); showAuthScreen('login'); };
    document.getElementById('auth-name')?.focus();

  } else {
    // mode === 'setup' (first admin user)
    box.innerHTML = `
      <div class="auth-logo">⚡ DMCloser</div>
      <h2 class="auth-title">🎉 Bienvenido</h2>
      <p class="auth-sub">Primera vez en el sistema. Crea tu cuenta de administrador.</p>
      <input class="auth-input" id="auth-name" type="text" placeholder="Tu nombre" autocomplete="name">
      <input class="auth-input" id="auth-email" type="email" placeholder="Email" autocomplete="email">
      <input class="auth-input" id="auth-password" type="password" placeholder="Contraseña (mín. 6 caracteres)" autocomplete="new-password">
      <input class="auth-input" id="auth-password2" type="password" placeholder="Confirmar contraseña" autocomplete="new-password">
      <div id="auth-error" class="auth-error" style="display:none"></div>
      <button class="btn-primary auth-btn" id="auth-submit">Crear cuenta y entrar</button>
    `;
    document.getElementById('auth-submit').onclick = () => submitAuth('setup');
    document.getElementById('auth-password').addEventListener('keydown', e => { if (e.key === 'Enter') submitAuth('setup'); });
    document.getElementById('auth-name')?.focus();
  }
}

async function submitAuth(mode) {
  const email    = document.getElementById('auth-email')?.value.trim();
  const password = document.getElementById('auth-password')?.value;
  const name     = document.getElementById('auth-name')?.value.trim();
  const pass2    = document.getElementById('auth-password2')?.value;
  const errEl    = document.getElementById('auth-error');
  const btn      = document.getElementById('auth-submit');

  errEl.style.display = 'none';
  btn.disabled = true;
  btn.textContent = mode === 'setup' ? 'Creando cuenta...' : 'Entrando...';

  const isRegisterMode = mode === 'setup' || mode === 'register';

  if (isRegisterMode && password !== pass2) {
    errEl.textContent = 'Las contraseñas no coinciden';
    errEl.style.display = 'block';
    btn.disabled = false;
    btn.textContent = mode === 'setup' ? 'Crear cuenta y entrar' : 'Crear cuenta y comenzar →';
    return;
  }

  const endpoint = isRegisterMode ? '/api/user/register' : '/api/user/login';
  // Si el user vino con ?ref=CODIGO en la landing, lo enviamos al registro
  let referralCode = null;
  if (isRegisterMode) {
    try {
      referralCode = sessionStorage.getItem('ref_code') || localStorage.getItem('ref_code');
    } catch {}
  }
  // Capturar info opcional del negocio (5 campos del formulario nuevo)
  // Solo aplica al modo 'register' (no 'setup' del primer admin).
  let businessInfo = null;
  if (mode === 'register') {
    const nicho        = document.getElementById('biz-nicho')?.value.trim();
    const servicio     = document.getElementById('biz-servicio')?.value.trim();
    const precio       = document.getElementById('biz-precio')?.value.trim();
    const clienteIdeal = document.getElementById('biz-cliente-ideal')?.value.trim();
    const linkAgenda   = document.getElementById('biz-link-agenda')?.value.trim();
    if (nicho || servicio || precio || clienteIdeal || linkAgenda) {
      businessInfo = {
        nicho:         nicho        || null,
        servicio:      servicio     || null,
        precio:        precio       || null,
        cliente_ideal: clienteIdeal || null,
        link_agenda:   linkAgenda   || null,
      };
    }
  }
  const body = isRegisterMode
    ? {
        email, password, name,
        ...(referralCode ? { referralCode } : {}),
        ...(businessInfo ? { businessInfo } : {}),
      }
    : { email, password };

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) {
      errEl.textContent = data.error || 'Error desconocido';
      errEl.style.display = 'block';
      btn.disabled = false;
      btn.textContent = mode === 'setup' ? 'Crear cuenta y entrar' : mode === 'register' ? 'Crear cuenta y comenzar →' : 'Entrar';
      return;
    }
    // Success
    AUTH_TOKEN   = data.token;
    CURRENT_USER = data.user;
    ACCOUNT_ID   = data.user.accountId;
    localStorage.setItem('autosetter_token',  data.token);
    localStorage.setItem('autosetter_user',   JSON.stringify(data.user));
    localStorage.removeItem('autosetter_account_id'); // legacy
    // Si el registro consumió un referral code, lo limpiamos para no reusarlo
    if (isRegisterMode) {
      try { sessionStorage.removeItem('ref_code'); localStorage.removeItem('ref_code'); } catch {}
    }
    showDashboard();
  } catch (e) {
    errEl.textContent = 'Error de conexión';
    errEl.style.display = 'block';
    btn.disabled = false;
    btn.textContent = mode === 'setup' ? 'Crear cuenta y entrar' : mode === 'register' ? 'Crear cuenta y comenzar →' : 'Entrar';
  }
}

function logout() {
  localStorage.removeItem('autosetter_token');
  localStorage.removeItem('autosetter_user');
  AUTH_TOKEN = ''; CURRENT_USER = null; ACCOUNT_ID = '';
  showAuthScreen('login');
}

// ── NAVIGATION ───────────────────────────────────────────────────────────────
function initNav() {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      const section = item.dataset.section;
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
      item.classList.add('active');
      loadSection(section);
    });
  });
}

function loadSection(name) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  const sec = document.getElementById(`section-${name}`);
  if (sec) sec.classList.add('active');

  if (leadsRefreshInterval) { clearInterval(leadsRefreshInterval); leadsRefreshInterval = null; }

  switch (name) {
    case 'home':      loadHome(); break;
    case 'agents':    loadAgents(); break;
    case 'knowledge': loadKnowledge(); break;
    case 'inbox':     loadInbox(); break;
    case 'analytics': loadAnalytics(); break;
    case 'leads':     loadLeads(); break;
    case 'billing':   loadBillingPage(); break;
    case 'referrals': loadReferralsPage(); break;
    case 'links':     loadLinks(); break;
    case 'magnets':   loadMagnets(); break;
    case 'growth':    loadGrowth(); break;
    case 'settings':  loadSettings(); break;
  }
}

// ── HOME ─────────────────────────────────────────────────────────────────────
async function loadHome() {
  if (!ACCOUNT_ID) return;
  const data = await apiFetch(`/api/settings?accountId=${ACCOUNT_ID}`);
  if (!data) return;

  document.getElementById('stat-agents').textContent    = data.stats.agents;
  document.getElementById('stat-leads').textContent     = data.stats.leads;
  document.getElementById('stat-converted').textContent = data.stats.converted;
  document.getElementById('stat-links').textContent     = data.stats.links;
  document.getElementById('sidebar-username').textContent = '@' + (data.account?.ig_username || 'cuenta');
  document.getElementById('webhook-url').textContent = `${location.origin}/webhook`;
  document.getElementById('settings-webhook-url').textContent = `${location.origin}/webhook`;

  // Carga la card de uso/límites y el checklist de onboarding
  loadUsage();
  loadOnboarding();
}

// ── ONBOARDING CHECKLIST ────────────────────────────────────────────────────
async function loadOnboarding() {
  const card = document.getElementById('onboarding-card');
  if (!card) return;

  // Si el usuario ocultó el checklist manualmente en esta sesión, no lo mostramos
  if (sessionStorage.getItem('onboardingDismissed') === '1') {
    card.style.display = 'none';
    return;
  }

  try {
    const data = await apiFetch(`/api/settings/onboarding?accountId=${ACCOUNT_ID}`);
    if (!data || !data.steps) { card.style.display = 'none'; return; }

    if (data.allDone) {
      // Usuario completó todo → ocultar para siempre
      card.style.display = 'none';
      localStorage.setItem('onboardingCompleted', '1');
      return;
    }

    card.style.display = '';
    document.getElementById('onboarding-progress-text').textContent = `${data.completedSteps}/${data.totalSteps}`;
    document.getElementById('onboarding-progress-bar').style.width = `${data.percent}%`;

    const subtitle = data.nextStep
      ? `Próximo paso: <strong>${escHtmlStep(data.nextStep.title)}</strong>`
      : 'Completá estos pasos para activar tu bot';
    document.getElementById('onboarding-subtitle').innerHTML = subtitle;

    document.getElementById('onboarding-steps').innerHTML = data.steps.map((s, i) => {
      const isNext = !s.done && data.nextStep && data.nextStep.id === s.id;
      const bg     = s.done ? '#f0fdf4' : isNext ? '#fff' : '#fafafa';
      const border = s.done ? '#bbf7d0' : isNext ? '#f97316' : 'var(--border)';
      const check  = s.done
        ? '<span style="width:24px;height:24px;border-radius:50%;background:#22c55e;color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0">✓</span>'
        : `<span style="width:24px;height:24px;border-radius:50%;background:#fff;border:2px solid ${isNext ? '#f97316' : 'var(--border)'};color:${isNext ? '#f97316' : 'var(--text-3)'};display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0">${i+1}</span>`;
      const titleStyle = s.done ? 'color:var(--text-2);text-decoration:line-through' : 'color:var(--text-1);font-weight:600';
      const btnStyle = s.done
        ? 'background:transparent;color:#16a34a;border:1px solid #bbf7d0;cursor:default'
        : isNext
          ? 'background:var(--orange);color:#fff;border:1px solid var(--orange);cursor:pointer'
          : 'background:#fff;color:var(--text-2);border:1px solid var(--border);cursor:pointer';
      const onclickAttr = s.done ? '' : `onclick="goOnboardingStep('${s.cta.section}')"`;
      return `
        <div style="display:flex;align-items:center;gap:14px;padding:12px 14px;background:${bg};border:1px solid ${border};border-radius:8px">
          ${check}
          <div style="flex:1;min-width:0">
            <div style="font-size:14px;${titleStyle}">${s.icon} ${escHtmlStep(s.title)}</div>
            <div style="font-size:12px;color:var(--text-3);margin-top:2px;line-height:1.4">${escHtmlStep(s.description)}</div>
          </div>
          <button ${onclickAttr} style="padding:7px 14px;font-size:12px;font-weight:600;border-radius:6px;white-space:nowrap;${btnStyle}">
            ${escHtmlStep(s.cta.label)}
          </button>
        </div>`;
    }).join('');
  } catch (e) {
    console.warn('onboarding load skip:', e.message);
    card.style.display = 'none';
  }
}

function escHtmlStep(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function goOnboardingStep(section) {
  if (typeof loadSection === 'function') loadSection(section);
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const navItem = document.querySelector(`.nav-item[data-section="${section}"]`);
  if (navItem) navItem.classList.add('active');
}

function dismissOnboarding() {
  sessionStorage.setItem('onboardingDismissed', '1');
  const card = document.getElementById('onboarding-card');
  if (card) card.style.display = 'none';
}

// ── USAGE (uso vs límites del plan) ─────────────────────────────────────────
async function loadUsage() {
  const data = await apiFetch('/api/usage');
  if (!data || !data.plan) return;

  const card = document.getElementById('usage-card');
  if (card) card.style.display = '';

  const { plan, usage, percent, overLimit, overage } = data;

  document.getElementById('usage-plan-name').textContent = plan.name;
  const monthLbl = new Date(usage.month + '-01T00:00:00').toLocaleDateString('es', { month: 'long', year: 'numeric' });
  let periodTxt = `Período: ${monthLbl} (se resetea el día 1 de cada mes)`;
  // Si hay overage activo (DMs > maxDMs), mostrar el costo en USD ya acumulado
  if (overage && overage.extraDMs > 0) {
    periodTxt += ` · ⚡ ${overage.extraDMs} DMs extra · cargo overage: $${overage.costUSD.toFixed(2)} USD`;
  }
  document.getElementById('usage-month').textContent = periodTxt;

  const fmt = (v, max) => max === null || !isFinite(max) ? `${v} / ∞` : `${v} / ${max}`;

  // DMs (en planes con overage permitido, mostrar como "X / max (+Y extra)")
  const maxDMs = isFinite(plan.maxDMs) ? plan.maxDMs : null;
  let dmsLabel = fmt(usage.dms, maxDMs);
  if (overage && overage.extraDMs > 0) dmsLabel += ` (+${overage.extraDMs} extra)`;
  document.getElementById('usage-dms-text').textContent = dmsLabel;
  document.getElementById('usage-dms-fill').style.width = `${Math.min(100, percent.dms)}%`;
  document.getElementById('usage-dms-fill').style.background =
    overage && overage.extraDMs > 0 ? '#10b981' : (percent.dms >= 90 ? '#ef4444' : percent.dms >= 75 ? '#f59e0b' : 'var(--orange)');

  // Agentes
  const maxA = isFinite(plan.maxAgents) ? plan.maxAgents : null;
  document.getElementById('usage-agents-text').textContent = fmt(usage.agents, maxA);
  document.getElementById('usage-agents-fill').style.width = `${percent.agents}%`;
  document.getElementById('usage-row-agents').style.display = maxA === null ? 'none' : '';

  // Cuentas
  const maxAc = isFinite(plan.maxAccounts) ? plan.maxAccounts : null;
  document.getElementById('usage-accounts-text').textContent = fmt(usage.accounts, maxAc);
  document.getElementById('usage-accounts-fill').style.width = `${percent.accounts}%`;
  document.getElementById('usage-row-accounts').style.display = maxAc === null ? 'none' : '';

  // Magnets
  const maxM = isFinite(plan.maxMagnets) ? plan.maxMagnets : null;
  document.getElementById('usage-magnets-text').textContent = fmt(usage.magnets, maxM);
  document.getElementById('usage-magnets-fill').style.width = `${percent.magnets}%`;
  document.getElementById('usage-row-magnets').style.display = maxM === null ? 'none' : '';

  // Warning si algún recurso está al 80%+
  const warnings = [];
  if (percent.dms >= 80)      warnings.push(`DMs al ${percent.dms}%`);
  if (percent.agents >= 100)  warnings.push('agentes al máximo');
  if (percent.magnets >= 100) warnings.push('magnet links al máximo');
  const warnEl = document.getElementById('usage-warning');
  const warnTxt = document.getElementById('usage-warning-text');
  if (warnings.length) {
    warnEl.style.display = '';
    warnTxt.textContent = warnings.join(', ') + '. Considera upgradear.';
  } else {
    warnEl.style.display = 'none';
  }

  // Botón upgrade si cualquier recurso está en rojo o plan es trial/starter
  const needsUpgrade = Object.values(overLimit).some(Boolean) || ['trial', 'starter'].includes(plan.id);
  const upBtn = document.getElementById('btn-usage-upgrade');
  if (upBtn) {
    upBtn.style.display = needsUpgrade ? '' : 'none';
    upBtn.onclick = () => showUpgradeModal(false);
  }
}

// ── AGENTS ───────────────────────────────────────────────────────────────────
async function loadAgents() {
  if (!ACCOUNT_ID) return;
  const agents = await apiFetch(`/api/agents?accountId=${ACCOUNT_ID}`);
  if (!agents) return;

  const list = document.getElementById('agent-tabs-list');
  list.innerHTML = '';

  if (!agents.length) {
    list.innerHTML = '<div style="padding:20px;color:var(--text-3);text-align:center">No hay agentes aún</div>';
    return;
  }

  agents.forEach(agent => {
    const tab = document.createElement('div');
    tab.className = 'agent-tab' + (currentAgent?.id === agent.id ? ' selected' : '');
    tab.dataset.id = agent.id;
    tab.innerHTML = `
      <span class="agent-tab-avatar">${agent.avatar}</span>
      <div class="agent-tab-info">
        <div class="agent-tab-name">${agent.name}</div>
        <div class="agent-tab-status ${agent.enabled ? 'on' : ''}">${agent.enabled ? '● Activo' : '○ Inactivo'}</div>
      </div>
    `;
    tab.addEventListener('click', () => selectAgent(agent.id));
    list.appendChild(tab);
  });

  // Select first agent
  if (!currentAgent && agents.length) selectAgent(agents[0].id);

  // Create agent button
  document.getElementById('btn-create-agent').onclick = () => openAgentModal();
}

async function selectAgent(agentId) {
  const agentData = await apiFetch(`/api/agents/${agentId}`);
  if (!agentData) return;
  currentAgent = agentData;

  // Update tab selection
  document.querySelectorAll('.agent-tab').forEach(t => {
    t.classList.toggle('selected', t.dataset.id === agentId);
  });

  await renderAgentBuilder(agentId);
}

async function renderAgentBuilder(agentId) {
  const agentData = currentAgent && (currentAgent._id === agentId || currentAgent.id === agentId)
    ? currentAgent
    : await apiFetch(`/api/agents/${agentId}`);
  if (!agentData) return;
  currentAgent = agentData;

  // Render builder
  const builder = document.getElementById('agent-builder');
  const allLinks = await apiFetch(`/api/links?accountId=${ACCOUNT_ID}`);
  const agentLinkIds = (agentData.links || []).map(l => l.id || l._id);

  builder.innerHTML = `
    <div class="builder-tabs">
      <div class="builder-tab active" data-tab="configure">Configure</div>
    </div>
    <div class="builder-content">
      <div class="builder-sub-tabs">
        <div class="builder-sub-tab active" data-stab="instructions">Instrucciones</div>
        <div class="builder-sub-tab" data-stab="links">Manage links</div>
      </div>

      <div id="stab-instructions">
        <div class="instructions-label">
          <span>Agent Instructions</span>
          <small style="color:var(--text-3)">System prompt del agente</small>
        </div>
        <textarea class="instructions-area" id="agent-instructions">${escHtml(agentData.instructions)}</textarea>

        <div style="margin-top:16px;padding:14px;background:#0f0f1a;border:1px solid #2a2a4a;border-radius:8px">
          <label style="font-size:0.78rem;color:#a5a5c8;font-weight:600;display:block;margin-bottom:6px">
            🔑 Palabras clave que activan el bot
          </label>
          <input
            type="text"
            id="agent-trigger-keywords"
            value="${escHtml(agentData.trigger_keywords || '')}"
            placeholder="info, precio, cotizar, hola  (separadas por coma)"
            style="width:100%;background:#1a1a2e;border:1px solid #3a3a5a;color:#e0e0e0;padding:8px 10px;border-radius:6px;font-size:0.85rem"
          />
          <small style="color:#666;font-size:0.72rem;display:block;margin-top:6px">
            Dejar vacío = el bot responde a <strong style="color:#a5a5c8">cualquier mensaje</strong>.
            Con keywords = solo se activa cuando el DM o comentario contiene una de estas palabras.
          </small>
        </div>

        <div style="margin-top:16px;padding:14px;background:#0f0f1a;border:1px solid #2a2a4a;border-radius:8px">
          <label style="font-size:0.78rem;color:#a5a5c8;font-weight:600;display:block;margin-bottom:10px">
            ⏱ Delay de respuesta (simula escritura humana)
          </label>
          <div style="display:flex;align-items:center;gap:16px">
            <div style="flex:1">
              <label style="font-size:0.72rem;color:#666;display:block;margin-bottom:4px">Mínimo</label>
              <select id="agent-delay-min" style="width:100%;background:#1a1a2e;border:1px solid #3a3a5a;color:#e0e0e0;padding:7px 10px;border-radius:6px;font-size:0.85rem">
                ${[5,10,15,20,25,30,40,50,60,70,80].map(s => `<option value="${s}" ${(agentData.delay_min??5)===s?'selected':''}>${s}s</option>`).join('')}
              </select>
            </div>
            <div style="flex:1">
              <label style="font-size:0.72rem;color:#666;display:block;margin-bottom:4px">Máximo</label>
              <select id="agent-delay-max" style="width:100%;background:#1a1a2e;border:1px solid #3a3a5a;color:#e0e0e0;padding:7px 10px;border-radius:6px;font-size:0.85rem">
                ${[10,15,20,25,30,40,50,60,70,80,90].map(s => `<option value="${s}" ${(agentData.delay_max??15)===s?'selected':''}>${s}s</option>`).join('')}
              </select>
            </div>
          </div>
          <small style="color:#666;font-size:0.72rem;display:block;margin-top:6px">
            El bot espera un tiempo aleatorio entre estos valores antes de responder.
            <strong>Recomendado: 5-15s</strong> para responder rápido (lead HOT no se enfría) sin parecer instantáneo.
            Si tu cuenta es nueva o querés ser conservador, usá 20-40s.
          </small>
        </div>
      </div>

      <div id="stab-links" style="display:none">
        <p style="color:var(--text-2);font-size:13px;margin-bottom:12px">Marca los links que este agente puede compartir:</p>
        <div id="agent-links-checks">
          ${(allLinks || []).map(l => `
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;background:#0f0f1a;padding:8px 10px;border-radius:8px;border:1px solid #2a2a4a">
              <label style="display:flex;align-items:center;gap:8px;flex:1;cursor:pointer">
                <input type="checkbox" value="${l.id}" ${agentLinkIds.includes(l.id) ? 'checked' : ''} style="width:15px;height:15px;accent-color:#7c5cbf">
                <div>
                  <div style="font-weight:600;font-size:12px;color:#e0e0e0">🔗 ${escHtml(l.name)}</div>
                  <div style="color:var(--text-3);font-size:11px">${escHtml(l.url)}</div>
                </div>
              </label>
              <button onclick="deleteLinkInBuilder('${l.id}')" title="Eliminar link" style="background:none;border:none;color:#f87171;cursor:pointer;font-size:14px;padding:2px 6px;border-radius:4px" onmouseover="this.style.background='#2a1a1a'" onmouseout="this.style.background='none'">🗑</button>
            </div>
          `).join('')}
          ${!allLinks?.length ? '<p style="color:var(--text-3);font-size:12px;padding:8px">Aún no tienes links. Crea uno con el botón de abajo.</p>' : ''}
        </div>

        <div id="inline-link-form" style="display:none;margin-top:10px;padding:12px;background:#0f0f1a;border:1px solid #3a3a5a;border-radius:8px">
          <div style="font-size:12px;font-weight:700;color:#a5a5c8;margin-bottom:8px">➕ Nuevo link</div>
          <input type="text" id="il-name" placeholder="Nombre (ej: Ver ficha técnica)" style="width:100%;box-sizing:border-box;margin-bottom:6px;background:#1a1a2e;border:1px solid #3a3a5a;color:#e0e0e0;padding:7px 10px;border-radius:6px;font-size:12px">
          <input type="url" id="il-url" placeholder="https://..." style="width:100%;box-sizing:border-box;margin-bottom:6px;background:#1a1a2e;border:1px solid #3a3a5a;color:#e0e0e0;padding:7px 10px;border-radius:6px;font-size:12px">
          <input type="text" id="il-desc" placeholder="Descripción breve (opcional)" style="width:100%;box-sizing:border-box;margin-bottom:10px;background:#1a1a2e;border:1px solid #3a3a5a;color:#e0e0e0;padding:7px 10px;border-radius:6px;font-size:12px">
          <div style="display:flex;gap:8px">
            <button class="btn-primary" style="font-size:12px;padding:6px 14px" id="btn-il-save">💾 Guardar link</button>
            <button class="btn-ghost" style="font-size:12px;padding:6px 14px" id="btn-il-cancel">Cancelar</button>
          </div>
        </div>

        <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
          <button class="btn-ghost" id="btn-show-add-link" style="font-size:12px">➕ Agregar link</button>
          <button class="btn-primary" id="btn-save-agent-links" style="font-size:12px">💾 Guardar selección</button>
        </div>
      </div>

      <div class="agent-actions">
        <button class="btn-primary" id="btn-save-instructions">Guardar instrucciones</button>
        <button class="btn-ghost btn-danger" id="btn-delete-agent">🗑 Eliminar agente</button>
      </div>
    </div>
    <div class="agent-toggle-row">
      <span style="font-weight:600;font-size:13px">Agente ${agentData.enabled ? 'activo' : 'inactivo'}</span>
      <label class="toggle">
        <input type="checkbox" id="agent-toggle" ${agentData.enabled ? 'checked' : ''}>
        <span class="toggle-slider"></span>
      </label>
    </div>
  `;

  // Sub-tab switching — refresh links list when opening Manage links
  builder.querySelectorAll('.builder-sub-tab').forEach(st => {
    st.addEventListener('click', async () => {
      builder.querySelectorAll('.builder-sub-tab').forEach(x => x.classList.remove('active'));
      st.classList.add('active');
      document.getElementById('stab-instructions').style.display = st.dataset.stab === 'instructions' ? '' : 'none';
      document.getElementById('stab-links').style.display = st.dataset.stab === 'links' ? '' : 'none';
      // Re-render the links list fresh from API each time the tab opens
      if (st.dataset.stab === 'links') {
        const freshLinks = await apiFetch(`/api/links?accountId=${ACCOUNT_ID}`);
        const freshAgent = await apiFetch(`/api/agents/${agentId}`);
        const freshAgentLinkIds = (freshAgent?.links || []).map(l => l.id || l._id);
        const checksDiv = document.getElementById('agent-links-checks');
        checksDiv.innerHTML = (freshLinks || []).map(l => `
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;background:#0f0f1a;padding:8px 10px;border-radius:8px;border:1px solid #2a2a4a">
            <label style="display:flex;align-items:center;gap:8px;flex:1;cursor:pointer">
              <input type="checkbox" value="${l.id || l._id}" ${freshAgentLinkIds.includes(l.id || l._id) ? 'checked' : ''} style="width:15px;height:15px;accent-color:#7c5cbf">
              <div>
                <div style="font-weight:600;font-size:12px;color:#e0e0e0">🔗 ${escHtml(l.name)}</div>
                <div style="color:var(--text-3);font-size:11px">${escHtml(l.url)}</div>
              </div>
            </label>
            <button onclick="deleteLinkInBuilder('${l.id || l._id}')" title="Eliminar link" style="background:none;border:none;color:#f87171;cursor:pointer;font-size:14px;padding:2px 6px;border-radius:4px" onmouseover="this.style.background='#2a1a1a'" onmouseout="this.style.background='none'">🗑</button>
          </div>
        `).join('') || '<p style="color:var(--text-3);font-size:12px;padding:8px">Aún no tienes links. Crea uno con el botón de abajo.</p>';
      }
    });
  });

  // Save instructions
  document.getElementById('btn-save-instructions').onclick = async () => {
    const instructions     = document.getElementById('agent-instructions').value;
    const trigger_keywords = document.getElementById('agent-trigger-keywords').value.trim();
    const delay_min        = parseInt(document.getElementById('agent-delay-min').value);
    const delay_max        = parseInt(document.getElementById('agent-delay-max').value);
    await apiFetch(`/api/agents/${agentId}`, 'PUT', {
      name: currentAgent.name, avatar: currentAgent.avatar,
      instructions, enabled: currentAgent.enabled, trigger_keywords,
      delay_min, delay_max
    });
    showToast('✅ Configuración guardada');
    currentAgent.instructions     = instructions;
    currentAgent.trigger_keywords = trigger_keywords;
    currentAgent.delay_min        = delay_min;
    currentAgent.delay_max        = delay_max;
  };

  // Save links (assign/unassign checkboxes)
  document.getElementById('btn-save-agent-links').onclick = async () => {
    const checks = [...document.querySelectorAll('#agent-links-checks input[type="checkbox"]:checked')].map(c => c.value);
    await apiFetch(`/api/agents/${agentId}/links`, 'PUT', { linkIds: checks });
    showToast('✅ Links actualizados');
  };

  // Show inline add-link form
  document.getElementById('btn-show-add-link').onclick = () => {
    const f = document.getElementById('inline-link-form');
    f.style.display = f.style.display === 'none' ? 'block' : 'none';
    if (f.style.display === 'block') document.getElementById('il-name').focus();
  };

  // Cancel inline form
  document.getElementById('btn-il-cancel').onclick = () => {
    document.getElementById('inline-link-form').style.display = 'none';
    document.getElementById('il-name').value = '';
    document.getElementById('il-url').value  = '';
    document.getElementById('il-desc').value = '';
  };

  // Save new link from inline form and auto-check it
  document.getElementById('btn-il-save').onclick = async () => {
    const name = document.getElementById('il-name').value.trim();
    const url  = document.getElementById('il-url').value.trim();
    const desc = document.getElementById('il-desc').value.trim();
    if (!name || !url) { showToast('⚠️ Nombre y URL son requeridos'); return; }
    const newLink = await apiFetch('/api/links', 'POST', { accountId: ACCOUNT_ID, name, url, description: desc });
    document.getElementById('inline-link-form').style.display = 'none';
    document.getElementById('il-name').value = '';
    document.getElementById('il-url').value  = '';
    document.getElementById('il-desc').value = '';
    // Refresh builder with updated links list (auto-checks new link)
    const updatedLinks = await apiFetch(`/api/links?accountId=${ACCOUNT_ID}`);
    const currentChecked = [...document.querySelectorAll('#agent-links-checks input[type="checkbox"]:checked')].map(c => c.value);
    if (newLink?._id || newLink?.id) currentChecked.push(newLink._id || newLink.id);
    await apiFetch(`/api/agents/${agentId}/links`, 'PUT', { linkIds: currentChecked });
    showToast('✅ Link creado y asignado al agente');
    renderAgentBuilder(agentId);
  };

  // Toggle enabled
  document.getElementById('agent-toggle').onchange = async (e) => {
    await apiFetch(`/api/agents/${agentId}/toggle`, 'PATCH', {});
    currentAgent.enabled = e.target.checked;
    loadAgents();
  };

  // Delete
  document.getElementById('btn-delete-agent').onclick = async () => {
    if (!confirm(`¿Eliminar el agente "${agentData.name}"?`)) return;
    await apiFetch(`/api/agents/${agentId}`, 'DELETE');
    currentAgent = null;
    document.getElementById('agent-builder').innerHTML = '<div class="agent-builder-empty"><div style="font-size:48px">🤖</div><p>Selecciona un agente</p></div>';
    document.getElementById('agent-tester').style.display = 'none';
    loadAgents();
  };

  // Show tester
  const tester = document.getElementById('agent-tester');
  tester.style.display = 'flex';
  document.getElementById('tester-name').textContent = `${agentData.avatar} ${agentData.name}`;
  testerHistory = [];
  document.getElementById('tester-messages').innerHTML = '<div class="tester-hint">Inicia una conversación para probar tu agente</div>';

  // Tester send
  document.getElementById('btn-tester-send').onclick = sendTesterMessage;
  document.getElementById('tester-input').onkeydown = e => { if (e.key === 'Enter') sendTesterMessage(); };
  document.getElementById('btn-reset-chat').onclick = () => {
    testerHistory = [];
    document.getElementById('tester-messages').innerHTML = '<div class="tester-hint">Inicia una conversación para probar tu agente</div>';
  };
}

async function sendTesterMessage() {
  const input = document.getElementById('tester-input');
  const text  = input.value.trim();
  if (!text) return;
  input.value = '';

  const msgs = document.getElementById('tester-messages');
  msgs.querySelector('.tester-hint')?.remove();

  // Add user message
  msgs.innerHTML += `<div class="tester-msg user">${escHtml(text)}</div>`;
  const loading = document.createElement('div');
  loading.className = 'tester-msg loading';
  loading.textContent = '...escribiendo';
  msgs.appendChild(loading);
  msgs.scrollTop = msgs.scrollHeight;

  testerHistory.push({ role: 'user', content: text });

  try {
    const res = await apiFetch(`/api/agents/${currentAgent.id}/test`, 'POST', {
      message: text,
      history: testerHistory.slice(0, -1),
      accountId: ACCOUNT_ID
    });
    loading.remove();
    const reply = res?.reply || 'Error al generar respuesta';
    msgs.innerHTML += `<div class="tester-msg agent">${escHtml(reply)}</div>`;
    testerHistory.push({ role: 'agent', content: reply });

    // Show live classification if available
    if (res?.classification?.qualification) {
      const c = res.classification;
      msgs.innerHTML += `
        <div class="tester-classification">
          🎯 Clasificación IA: ${qualificationBadge(c.qualification)}
          ${c.reason ? `<span style="font-size:11px;color:var(--text-2)">${escHtml(c.reason)}</span>` : ''}
        </div>`;
    }
  } catch {
    loading.remove();
    msgs.innerHTML += `<div class="tester-msg loading">⚠️ Error de conexión</div>`;
  }
  msgs.scrollTop = msgs.scrollHeight;
}

function openAgentModal() {
  document.getElementById('agent-modal').style.display = 'flex';
  document.getElementById('new-agent-name').focus();
  document.getElementById('btn-close-agent-modal').onclick = () => document.getElementById('agent-modal').style.display = 'none';
  document.getElementById('btn-cancel-agent-modal').onclick = () => document.getElementById('agent-modal').style.display = 'none';
  document.getElementById('btn-save-new-agent').onclick = async () => {
    const name   = document.getElementById('new-agent-name').value.trim();
    const avatar = document.getElementById('new-agent-avatar').value.trim() || '🤖';
    if (!name) return;
    const agent = await apiFetch('/api/agents', 'POST', { accountId: ACCOUNT_ID, name, avatar });
    document.getElementById('agent-modal').style.display = 'none';
    document.getElementById('new-agent-name').value = '';
    currentAgent = null;
    await loadAgents();
    if (agent) selectAgent(agent.id);
  };
}

// ── KNOWLEDGE ─────────────────────────────────────────────────────────────────
async function loadKnowledge() {
  if (!ACCOUNT_ID) return;
  const entries = await apiFetch(`/api/knowledge?accountId=${ACCOUNT_ID}`);
  const list = document.getElementById('knowledge-list');
  list.innerHTML = '';

  if (!entries?.length) {
    list.innerHTML = '<div style="color:var(--text-3);text-align:center;padding:40px">No hay entradas de conocimiento aún</div>';
  } else {
    entries.forEach(e => {
      const card = document.createElement('div');
      card.className = 'knowledge-card';
      const isLong = (e.content || '').length > 200;
      card.innerHTML = `
        <div class="kc-header">
          <div>
            <div class="kc-title">${escHtml(e.title)}</div>
            <div class="kc-sub">${e.is_main ? 'Se adjunta a todos los agentes' : 'Entrada de conocimiento'}</div>
          </div>
          <div class="kc-actions">
            <button class="btn-ghost" onclick="openKnowledgeModal('${e.id}')">✏️ Editar</button>
            <button class="btn-ghost" onclick="deleteKnowledge('${e.id}')">🗑</button>
          </div>
        </div>
        ${e.is_main ? '<span class="kc-tag">⭐ Main context</span>' : ''}
        <div class="kc-content" id="kc-${e.id}" data-kc-id="${escHtml(e.id)}">${escHtml(e.content)}</div>
        ${isLong ? `<span class="kc-show-more" data-kc-toggle="${escHtml(e.id)}">▼ Ver más</span>` : ''}
        ${e.agents?.length ? `
          <div class="kc-agents">
            <span style="font-size:12px;color:var(--text-2)">Agentes vinculados:</span>
            ${e.agents.map(a => `<span class="kc-agent-badge">${a.avatar} ${a.name}</span>`).join('')}
          </div>
        ` : ''}
      `;
      list.appendChild(card);
    });
  }

  document.getElementById('btn-add-knowledge').onclick = () => openKnowledgeModal(null);
}

function toggleKcContent(id) {
  const el = document.getElementById(`kc-${id}`);
  if (!el) return;
  el.classList.toggle('expanded');
  const toggle = document.querySelector(`[data-kc-toggle="${id}"]`);
  if (toggle) toggle.textContent = el.classList.contains('expanded') ? '▲ Ver menos' : '▼ Ver más';
}
window.toggleKcContent = toggleKcContent;

// Event delegation: cualquier click en .kc-show-more dispara toggle
// (más robusto que onclick inline; funciona aunque el script se cargue con CSP estricto)
document.addEventListener('click', (ev) => {
  const t = ev.target.closest?.('[data-kc-toggle]');
  if (t) {
    ev.preventDefault();
    toggleKcContent(t.getAttribute('data-kc-toggle'));
  }
});

async function openKnowledgeModal(id) {
  const modal = document.getElementById('knowledge-modal');
  const agents = await apiFetch(`/api/agents?accountId=${ACCOUNT_ID}`);
  modal.style.display = 'flex';

  // Populate agents checkboxes
  const checksDiv = document.getElementById('km-agents-select');
  checksDiv.innerHTML = (agents || []).map(a => `
    <label>
      <input type="checkbox" value="${a.id}" class="km-agent-check">
      ${a.avatar} ${a.name}
    </label>
  `).join('');

  if (id) {
    // Load existing entry
    const entries = await apiFetch(`/api/knowledge?accountId=${ACCOUNT_ID}`);
    const entry = entries?.find(e => e.id === id);
    if (entry) {
      document.getElementById('km-id').value = entry.id;
      document.getElementById('km-title').textContent = 'Editar entrada';
      document.getElementById('km-title-input').value = entry.title;
      document.getElementById('km-content').value = entry.content;
      document.getElementById('km-is-main').checked = !!entry.is_main;
      entry.agents?.forEach(a => {
        const cb = checksDiv.querySelector(`input[value="${a.id}"]`);
        if (cb) cb.checked = true;
      });
    }
  } else {
    document.getElementById('km-id').value = '';
    document.getElementById('km-title').textContent = 'Nueva entrada';
    document.getElementById('km-title-input').value = '';
    document.getElementById('km-content').value = '';
    document.getElementById('km-is-main').checked = false;
  }

  document.getElementById('btn-close-km').onclick = () => modal.style.display = 'none';
  document.getElementById('btn-cancel-km').onclick = () => modal.style.display = 'none';

  document.getElementById('btn-save-km').onclick = async () => {
    const kmId      = document.getElementById('km-id').value;
    const title     = document.getElementById('km-title-input').value.trim();
    const content   = document.getElementById('km-content').value.trim();
    const is_main   = document.getElementById('km-is-main').checked;
    const agentIds  = [...checksDiv.querySelectorAll('input:checked')].map(c => c.value);
    if (!title || !content) return;

    if (kmId) {
      await apiFetch(`/api/knowledge/${kmId}`, 'PUT', { title, content, is_main, agentIds });
    } else {
      await apiFetch('/api/knowledge', 'POST', { accountId: ACCOUNT_ID, title, content, is_main, agentIds });
    }
    modal.style.display = 'none';
    loadKnowledge();
  };
}

async function deleteKnowledge(id) {
  if (!confirm('¿Eliminar esta entrada de conocimiento? El bot dejará de usar esta info.')) return;
  const r = await apiFetch(`/api/knowledge/${id}`, 'DELETE');
  if (!r) {
    showToast('❌ No se pudo eliminar — recargá la página y probá de nuevo');
    return;
  }
  if (r.removed > 0) showToast('✅ Eliminado');
  loadKnowledge();
}

// ── LEADS ─────────────────────────────────────────────────────────────────────
async function loadLeads() {
  document.querySelectorAll('.leads-tab').forEach(t => {
    t.onclick = () => {
      document.querySelectorAll('.leads-tab').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      document.getElementById('leads-inbound').style.display  = t.dataset.tab === 'inbound'  ? '' : 'none';
      document.getElementById('leads-bypassed').style.display = t.dataset.tab === 'bypassed' ? '' : 'none';
      if (t.dataset.tab === 'bypassed') loadBypassedUsers();
    };
  });

  document.getElementById('btn-refresh-leads').onclick = () => fetchLeads();
  document.getElementById('filter-handle').oninput        = debounce(fetchLeads, 400);
  document.getElementById('filter-status').onchange       = fetchLeads;
  document.getElementById('filter-automation').onchange   = fetchLeads;
  document.getElementById('filter-qualification').onchange = fetchLeads;

  document.getElementById('btn-close-modal').onclick = closeLeadModal;
  document.getElementById('btn-bypass-lead').onclick  = bypassCurrentLead;
  document.getElementById('btn-convert-lead').onclick = convertCurrentLead;
  document.getElementById('btn-send-manual').onclick  = sendManualMessage;

  document.getElementById('btn-add-bypass').onclick = addBypass;

  await fetchLeads();

  // Auto-refresh every 5s
  leadsRefreshInterval = setInterval(() => {
    fetchLeads(true);
    if (currentLeadId) refreshChat();
  }, 5000);
}

async function fetchLeads(silent = false) {
  if (!silent) document.getElementById('refresh-indicator').textContent = 'Actualizando...';
  const search        = document.getElementById('filter-handle').value;
  const status        = document.getElementById('filter-status').value;
  const automation    = document.getElementById('filter-automation').value;
  const qualification = document.getElementById('filter-qualification').value;

  const data = await apiFetch(`/api/leads?accountId=${ACCOUNT_ID}&search=${search}&status=${status}&automation=${automation}&qualification=${qualification}&limit=20`);
  document.getElementById('refresh-indicator').textContent = `Actualizado ${new Date().toLocaleTimeString()}`;

  // Update badge
  const badge = document.getElementById('leads-badge');
  if (data?.total) { badge.textContent = data.total; badge.classList.add('show'); }

  const tbody = document.getElementById('leads-list');
  if (!data?.leads?.length) {
    tbody.innerHTML = `<div style="padding:40px;text-align:center;color:var(--text-3)">No hay leads todavía</div>`;
    return;
  }

  tbody.innerHTML = `
    <table class="leads-table">
      <thead>
        <tr>
          <th>Usuario</th>
          <th>Agente</th>
          <th>Calificación</th>
          <th>Automatización</th>
          <th>Estado</th>
          <th>Último mensaje</th>
        </tr>
      </thead>
      <tbody>
        ${data.leads.map(l => `
          <tr data-id="${l.id}">
            <td>
              <div class="lead-handle">@${escHtml(l.ig_username)}</div>
            </td>
            <td>${l.agent_name ? `🤖 ${escHtml(l.agent_name)}` : '<span style="color:var(--text-3)">Sin agente</span>'}</td>
            <td>${qualificationBadge(l.qualification)}</td>
            <td>
              <span class="status-dot ${l.automation}"></span>
              ${l.automation === 'automated' ? 'Automatizado' : l.automation === 'manual' ? 'Manual' : 'Pausado'}
            </td>
            <td>
              ${l.is_converted ? '<span class="badge badge-green">✅ Exitoso</span>' :
                l.is_bypassed  ? '<span class="badge badge-gray">🚫 Bypasseado</span>' :
                '<span class="badge badge-orange">Activo</span>'}
            </td>
            <td class="lead-time">${l.last_message_at ? timeAgo(l.last_message_at) : '—'}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;

  tbody.querySelectorAll('tr[data-id]').forEach(row => {
    row.addEventListener('click', () => openLeadModal(row.dataset.id));
  });
}

async function openLeadModal(leadId) {
  currentLeadId = leadId;
  const data = await apiFetch(`/api/leads/${leadId}`);
  if (!data) return;

  document.getElementById('modal-username').textContent = `@${data.ig_username}`;
  document.getElementById('modal-agent-tag').textContent = data.agent_name ? `🤖 ${data.agent_name}` : '';
  document.getElementById('modal-automation').value = data.automation;

  // Show qualification box
  const qBox = document.getElementById('modal-qualification-box');
  if (data.qualification) {
    qBox.innerHTML = `
      <div class="qualification-card">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
          <span style="font-size:11px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:.5px">Calificación IA</span>
          ${qualificationBadge(data.qualification)}
        </div>
        ${data.qualification_reason ? `<div style="font-size:12px;color:var(--text-2);line-height:1.4">${escHtml(data.qualification_reason)}</div>` : ''}
      </div>
    `;
  } else {
    qBox.innerHTML = `<div style="font-size:12px;color:var(--text-3);font-style:italic">Sin calificación aún (se genera automáticamente)</div>`;
  }

  // Load agents for select
  const agents = await apiFetch(`/api/agents?accountId=${ACCOUNT_ID}`);
  const agentSel = document.getElementById('modal-agent');
  agentSel.innerHTML = '<option value="">Sin agente</option>' +
    (agents || []).map(a => `<option value="${a.id}" ${a.id === data.agent_id ? 'selected' : ''}>${a.name}</option>`).join('');

  document.getElementById('modal-automation').onchange = async e => {
    await apiFetch(`/api/leads/${leadId}`, 'PATCH', { automation: e.target.value });
  };
  agentSel.onchange = async e => {
    await apiFetch(`/api/leads/${leadId}`, 'PATCH', { agent_id: e.target.value || null });
  };

  renderChat(data.messages || []);
  document.getElementById('lead-modal').style.display = 'flex';

  if (chatRefreshInterval) clearInterval(chatRefreshInterval);
  chatRefreshInterval = setInterval(refreshChat, 5000);
}

function renderChat(messages) {
  const container = document.getElementById('modal-messages');
  if (!messages.length) {
    container.innerHTML = '<div style="color:var(--text-3);text-align:center;margin:auto">Sin mensajes aún</div>';
    return;
  }
  container.innerHTML = messages.map(m => `
    <div class="chat-msg ${m.role}">
      ${escHtml(m.content)}
      <div class="chat-msg-time">${new Date(m.created_at).toLocaleTimeString()}</div>
    </div>
  `).join('');
  container.scrollTop = container.scrollHeight;
}

async function refreshChat() {
  if (!currentLeadId) return;
  document.getElementById('chat-refresh').textContent = 'Actualizando...';
  const data = await apiFetch(`/api/leads/${currentLeadId}`);
  if (data) renderChat(data.messages || []);
  document.getElementById('chat-refresh').textContent = '';
}

function closeLeadModal() {
  document.getElementById('lead-modal').style.display = 'none';
  if (chatRefreshInterval) clearInterval(chatRefreshInterval);
  currentLeadId = null;
}

async function bypassCurrentLead() {
  if (!currentLeadId) return;
  await apiFetch(`/api/leads/${currentLeadId}`, 'PATCH', { is_bypassed: true, automation: 'paused' });
  showToast('🚫 Usuario bypasseado');
  closeLeadModal();
  fetchLeads();
}

async function convertCurrentLead() {
  if (!currentLeadId) return;
  await apiFetch(`/api/leads/${currentLeadId}`, 'PATCH', { is_converted: true });
  showToast('✅ Marcado como exitoso');
  closeLeadModal();
  fetchLeads();
}

async function sendManualMessage() {
  const input = document.getElementById('modal-msg-input');
  const text = input.value.trim();
  if (!text || !currentLeadId) return;
  input.value = '';
  await apiFetch(`/api/leads/${currentLeadId}/message`, 'POST', { text, accountId: ACCOUNT_ID });
  refreshChat();
}

async function loadBypassedUsers() {
  const list = await apiFetch(`/api/leads/bypassed/list?accountId=${ACCOUNT_ID}`);
  const container = document.getElementById('bypassed-list');
  if (!list?.length) {
    container.innerHTML = '<div style="color:var(--text-3);padding:20px">No hay usuarios bypasseados</div>';
    return;
  }
  container.innerHTML = `<div class="bypassed-list-table">
    ${list.map(u => `
      <div class="bypassed-row">
        <div>
          <div class="bypassed-handle">@${escHtml(u.ig_username)}</div>
          <div class="bypassed-date">${new Date(u.created_at).toLocaleDateString()}</div>
        </div>
        <button class="btn-icon" onclick="removeBypass('${u.id}')">🗑️</button>
      </div>
    `).join('')}
  </div>`;
}

async function addBypass() {
  const input = document.getElementById('bypass-username');
  const username = input.value.trim();
  if (!username) return;
  await apiFetch('/api/leads/bypassed/add', 'POST', { accountId: ACCOUNT_ID, igUsername: username });
  input.value = '';
  loadBypassedUsers();
}

async function removeBypass(id) {
  await apiFetch(`/api/leads/bypassed/${id}`, 'DELETE');
  loadBypassedUsers();
}

// ── LINKS ─────────────────────────────────────────────────────────────────────
async function loadLinks() {
  const links = await apiFetch(`/api/links?accountId=${ACCOUNT_ID}`);
  const list  = document.getElementById('links-list');
  list.innerHTML = '';

  (links || []).forEach(l => {
    const card = document.createElement('div');
    card.className = 'link-card';
    card.innerHTML = `
      <div class="link-card-name">🔗 ${escHtml(l.name)}</div>
      <div class="link-card-url">${escHtml(l.url)}</div>
      ${l.description ? `<div class="link-card-desc">${escHtml(l.description)}</div>` : ''}
      <div class="link-card-actions">
        <button class="btn-ghost" onclick="openLinkForm('${l.id}')">✏️ Editar</button>
        <button class="btn-ghost" onclick="deleteLink('${l.id}')">🗑 Eliminar</button>
      </div>
    `;
    list.appendChild(card);
  });

  document.getElementById('btn-add-link').onclick = () => openLinkForm(null);
  document.getElementById('btn-save-link').onclick    = saveLink;
  document.getElementById('btn-cancel-link').onclick  = () => document.getElementById('link-form').style.display = 'none';
}

function openLinkForm(id) {
  const form = document.getElementById('link-form');
  form.style.display = 'block';
  document.getElementById('link-id').value = id || '';
  document.getElementById('link-form-title').textContent = id ? 'Editar link' : 'Nuevo link';

  if (id) {
    // Pre-fill (fetch from existing list)
    const card = document.querySelector(`.link-card button[onclick="openLinkForm('${id}')"]`)?.closest('.link-card');
    if (card) {
      document.getElementById('link-name').value = card.querySelector('.link-card-name').textContent.replace('🔗 ', '');
      document.getElementById('link-url').value  = card.querySelector('.link-card-url').textContent;
      document.getElementById('link-desc').value = card.querySelector('.link-card-desc')?.textContent || '';
    }
  } else {
    document.getElementById('link-name').value = '';
    document.getElementById('link-url').value  = '';
    document.getElementById('link-desc').value = '';
  }
  form.scrollIntoView({ behavior: 'smooth' });
}

async function saveLink() {
  const id   = document.getElementById('link-id').value;
  const name = document.getElementById('link-name').value.trim();
  const url  = document.getElementById('link-url').value.trim();
  const desc = document.getElementById('link-desc').value.trim();
  if (!name || !url) { showToast('⚠️ Nombre y URL son requeridos'); return; }

  if (id) {
    await apiFetch(`/api/links/${id}`, 'PUT', { name, url, description: desc });
  } else {
    await apiFetch('/api/links', 'POST', { accountId: ACCOUNT_ID, name, url, description: desc });
  }
  document.getElementById('link-form').style.display = 'none';
  loadLinks();
}

async function deleteLink(id) {
  if (!confirm('¿Eliminar este link? El bot dejará de poder compartirlo.')) return;
  const r = await apiFetch(`/api/links/${id}`, 'DELETE');
  if (!r) {
    showToast('❌ No se pudo eliminar — recargá la página y probá de nuevo');
    return;
  }
  if (r.removed > 0) showToast('✅ Link eliminado');
  loadLinks();
}

// Delete link from within the agent builder panel
async function deleteLinkInBuilder(id) {
  if (!confirm('¿Eliminar este link permanentemente?')) return;
  await apiFetch(`/api/links/${id}`, 'DELETE');
  showToast('🗑 Link eliminado');
  if (currentAgent) renderAgentBuilder(currentAgent._id || currentAgent.id);
}

// ── SETTINGS ─────────────────────────────────────────────────────────────────
async function loadSettings() {
  if (!ACCOUNT_ID) return;
  const data = await apiFetch(`/api/settings?accountId=${ACCOUNT_ID}`);
  if (!data) return;

  document.getElementById('openai-key').value = data.settings?.openai_key || '';

  // Instagram connected state
  const isConnected = data.account?.ig_user_id && data.account.ig_user_id !== 'demo_ig_id';
  document.getElementById('ig-connected').style.display     = isConnected ? '' : 'none';
  document.getElementById('ig-not-connected').style.display = isConnected ? 'none' : '';

  if (isConnected) {
    document.getElementById('ig-connected-name').textContent = '@' + data.account.ig_username;
  }

  // Pre-fill manual fields if they exist in DOM
  const usernameEl = document.getElementById('ig-username');
  const userIdEl   = document.getElementById('ig-user-id');
  if (usernameEl) usernameEl.value = data.account?.ig_username || '';
  if (userIdEl)   userIdEl.value   = data.account?.ig_user_id  || '';

  // OAuth connect button
  document.getElementById('btn-connect-ig')?.addEventListener('click', () => {
    const token = localStorage.getItem('autosetter_token') || '';
    window.location.href = `/auth/instagram?accountId=${ACCOUNT_ID}&token=${encodeURIComponent(token)}`;
  });

  // Disconnect
  document.getElementById('btn-disconnect-ig')?.addEventListener('click', async () => {
    if (!confirm('¿Desconectar la cuenta de Instagram?')) return;
    await apiFetch('/api/settings/account', 'PUT', {
      accountId: ACCOUNT_ID, ig_username: 'sin.conectar', ig_user_id: 'demo_ig_id', access_token: 'demo_token'
    });
    document.getElementById('sidebar-username').textContent = '@sin.conectar';
    loadSettings();
    showToast('Cuenta desconectada');
  });

  // Save OpenAI
  document.getElementById('btn-save-openai').onclick = async () => {
    const key = document.getElementById('openai-key').value.trim();
    await apiFetch('/api/settings', 'PUT', { accountId: ACCOUNT_ID, openai_key: key });
    showToast('✅ OpenAI Key guardada');
  };

  // Save manual IG
  document.getElementById('btn-save-ig')?.addEventListener('click', async () => {
    const ig_username  = document.getElementById('ig-username')?.value.trim();
    const ig_user_id   = document.getElementById('ig-user-id')?.value.trim();
    const access_token = document.getElementById('ig-token')?.value.trim();
    await apiFetch('/api/settings/account', 'PUT', { accountId: ACCOUNT_ID, ig_username, ig_user_id, access_token });
    document.getElementById('sidebar-username').textContent = '@' + ig_username;
    loadSettings();
    showToast('✅ Cuenta actualizada manualmente');
  });

  // ── Notificaciones ────────────────────────────────────────────────────────
  await loadNotifications();
}

// ── NOTIFICACIONES DE LEADS HOT ──────────────────────────────────────────────
async function loadNotifications() {
  const data = await apiFetch('/api/notifications');
  if (!data) return;
  const c = data.config || {};

  const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v ?? ''; };
  const setChk = (id, v) => { const el = document.getElementById(id); if (el) el.checked = !!v; };

  setChk('notif-tg-enabled',      c.telegram_enabled);
  setVal('notif-tg-token',        c.telegram_bot_token);
  setVal('notif-tg-chatid',       c.telegram_chat_id);
  setChk('notif-email-enabled',   c.email_enabled);
  setVal('notif-email-address',   c.email_address);
  setChk('notif-wa-enabled',      c.whatsapp_enabled);
  setVal('notif-wa-number',       c.whatsapp_number);
  setVal('notif-wa-apikey',       c.whatsapp_apikey);
  setChk('notif-wh-enabled',      c.webhook_enabled);
  setVal('notif-wh-url',          c.webhook_url);

  // Si hay token + username guardado, mostrar botón "Abrir bot"
  updateTelegramOpenBotLink(c.telegram_bot_username);

  // Evitar duplicar listeners en re-render
  const save = document.getElementById('btn-save-notifications');
  if (save && !save.dataset.wired) {
    save.dataset.wired = '1';
    save.onclick = async () => {
      const body = {
        telegram_enabled:    document.getElementById('notif-tg-enabled').checked,
        telegram_bot_token:  document.getElementById('notif-tg-token').value.trim(),
        telegram_chat_id:    document.getElementById('notif-tg-chatid').value.trim(),
        email_enabled:    document.getElementById('notif-email-enabled').checked,
        email_address:    document.getElementById('notif-email-address').value.trim(),
        whatsapp_enabled: document.getElementById('notif-wa-enabled').checked,
        whatsapp_number:  document.getElementById('notif-wa-number').value.trim(),
        whatsapp_apikey:  document.getElementById('notif-wa-apikey').value.trim(),
        webhook_enabled:  document.getElementById('notif-wh-enabled').checked,
        webhook_url:      document.getElementById('notif-wh-url').value.trim(),
      };
      const r = await apiFetch('/api/notifications', 'PUT', body);
      const out = document.getElementById('notif-save-result');
      if (r?.ok) {
        out.style.color = 'var(--green)';
        out.textContent = '✅ Guardado';
        showToast('✅ Notificaciones guardadas');
      } else {
        out.style.color = 'var(--red, #ef4444)';
        out.textContent = '❌ Error';
      }
      setTimeout(() => { out.textContent = ''; }, 3500);
    };
  }

  wireTestButton('btn-test-tg',    'telegram', 'notif-tg-result');
  wireTestButton('btn-test-email', 'email',    'notif-email-result');
  wireTestButton('btn-test-wa',    'whatsapp', 'notif-wa-result');
  wireTestButton('btn-test-wh',    'webhook',  'notif-wh-result');

  // Botón "Detectar chat" — llama getUpdates y auto-llena chat_id
  const detectBtn = document.getElementById('btn-tg-detect');
  if (detectBtn && !detectBtn.dataset.wired) {
    detectBtn.dataset.wired = '1';
    detectBtn.onclick = async () => {
      const tokenEl = document.getElementById('notif-tg-token');
      const chatEl  = document.getElementById('notif-tg-chatid');
      const out     = document.getElementById('notif-tg-result');
      const token = tokenEl.value.trim();
      if (!token) {
        out.style.color = 'var(--red, #ef4444)';
        out.textContent = '❌ Pegá el bot token primero';
        return;
      }
      detectBtn.disabled = true;
      out.style.color = 'var(--text-2)';
      out.textContent = '⏳ Buscando...';

      // 1) getMe para validar token + obtener username
      const info = await apiFetch('/api/notifications/telegram/bot-info', 'POST', { bot_token: token });
      if (!info?.ok) {
        out.style.color = 'var(--red, #ef4444)';
        out.textContent = '❌ Token inválido: ' + (info?.reason || 'error');
        detectBtn.disabled = false;
        return;
      }
      updateTelegramOpenBotLink(info.username);

      // 2) getUpdates para extraer chat_id
      const r = await apiFetch('/api/notifications/telegram/detect-chat', 'POST', { bot_token: token });
      if (r?.ok) {
        chatEl.value = r.chat_id;
        out.style.color = 'var(--green)';
        out.textContent = `✅ Chat detectado (${r.name})`;
        // Persistir inmediatamente
        const saveBtn = document.getElementById('btn-save-notifications');
        if (saveBtn?.onclick) {
          // Marcar telegram como habilitado
          document.getElementById('notif-tg-enabled').checked = true;
          await saveBtn.onclick();
        }
      } else {
        out.style.color = 'var(--red, #ef4444)';
        const hint = r?.reason === 'no_messages'
          ? 'Abrí el bot y enviale /start, después reintentá'
          : (r?.reason || 'error');
        out.textContent = '❌ ' + hint;
      }
      detectBtn.disabled = false;
      setTimeout(() => { out.textContent = ''; }, 8000);
    };
  }
}

function updateTelegramOpenBotLink(username) {
  const link = document.getElementById('btn-tg-openbot');
  if (!link) return;
  if (username) {
    link.href = `https://t.me/${username}`;
    link.style.display = '';
    link.textContent = `📲 Abrir @${username}`;
  } else {
    link.style.display = 'none';
  }
}

function wireTestButton(btnId, channel, resultId) {
  const btn = document.getElementById(btnId);
  if (!btn || btn.dataset.wired) return;
  btn.dataset.wired = '1';
  btn.onclick = async () => {
    const out = document.getElementById(resultId);
    btn.disabled = true;
    out.textContent = '⏳ Enviando...';
    out.style.color = 'var(--text-2)';

    // Guardar primero por si el user no clickeó Guardar
    const saveBtn = document.getElementById('btn-save-notifications');
    if (saveBtn?.onclick) await saveBtn.onclick();

    const r = await apiFetch('/api/notifications/test', 'POST', { channel });
    if (r?.ok) {
      out.style.color = 'var(--green)';
      out.textContent = '✅ Enviado';
    } else {
      out.style.color = 'var(--red, #ef4444)';
      out.textContent = '❌ ' + (r?.reason || r?.error || 'error');
    }
    btn.disabled = false;
    setTimeout(() => { out.textContent = ''; }, 6000);
  };
}

// ── UTILS ─────────────────────────────────────────────────────────────────────
async function apiFetch(path, method = 'GET', body) {
  try {
    const opts = {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(AUTH_TOKEN ? { 'Authorization': `Bearer ${AUTH_TOKEN}` } : {})
      }
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(API + path, opts);
    if (res.status === 401) {
      // Token expirado → volver al login
      logout();
      return null;
    }
    if (res.status === 402) {
      // Suscripción expirada → mostrar modal de upgrade
      showUpgradeModal(true);
      return null;
    }
    if (res.status === 403) {
      // Límite de plan alcanzado → leer body y mostrar modal de upgrade contextual
      const err = await res.json().catch(() => ({}));
      if (err.upgrade) {
        showFeatureLockedToast(err);
        return null;
      }
      return null;
    }
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

function escHtml(str) {
  return String(str || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function timeAgo(dateStr) {
  const diff = (Date.now() - new Date(dateStr + ' UTC').getTime()) / 1000;
  if (diff < 60)   return 'hace ' + Math.floor(diff) + 's';
  if (diff < 3600) return 'hace ' + Math.floor(diff/60) + 'min';
  if (diff < 86400)return 'hace ' + Math.floor(diff/3600) + 'h';
  return 'hace ' + Math.floor(diff/86400) + 'd';
}

function debounce(fn, ms) {
  let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function qualificationBadge(q) {
  if (!q) return '<span style="color:var(--text-3);font-size:12px">—</span>';
  const map = {
    hot:  { emoji: '🔥', label: 'Caliente', cls: 'badge-hot' },
    warm: { emoji: '🌡️', label: 'Tibio',    cls: 'badge-warm' },
    cold: { emoji: '❄️', label: 'Frío',     cls: 'badge-cold' }
  };
  const b = map[q] || { emoji: '?', label: q, cls: 'badge-gray' };
  return `<span class="badge ${b.cls}">${b.emoji} ${b.label}</span>`;
}

let toastTimeout;
function showToast(msg) {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    toast.style.cssText = 'position:fixed;bottom:24px;right:24px;background:#111;color:white;padding:12px 20px;border-radius:8px;font-size:14px;z-index:9999;transition:opacity .3s;max-width:420px';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.opacity = '1';
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.style.opacity = '0', 3000);
}

/**
 * Toast con CTA para upgradear cuando una feature está bloqueada por plan.
 * Body recibido del backend: { error, upgrade: true, limit, plan, max?, required? }
 */
function showFeatureLockedToast(err) {
  // Quitar toast anterior si existe
  const old = document.getElementById('feature-locked-toast');
  if (old) old.remove();

  const required = err.required || 'Pro';
  const isPro    = required === 'Pro';
  const ctaColor = isPro ? '#10b981' : '#16a34a';
  const ctaLabel = isPro ? '⭐ Upgradear a Pro' : '🚀 Upgradear a Agency';

  const t = document.createElement('div');
  t.id = 'feature-locked-toast';
  t.style.cssText = `
    position:fixed;bottom:24px;right:24px;z-index:10000;
    background:linear-gradient(135deg,#1a1a2e,#0f0f1a);
    color:#fff;padding:18px 22px;border-radius:14px;
    box-shadow:0 20px 60px rgba(0,0,0,.4),0 0 0 1px rgba(16,185,129,.3);
    font-size:14px;line-height:1.5;max-width:420px;
    animation:slide-in .25s ease-out;
  `;
  t.innerHTML = `
    <div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:12px">
      <div style="font-size:22px;flex-shrink:0">🔒</div>
      <div style="flex:1">
        <div style="font-weight:700;font-size:15px;color:#fff;margin-bottom:4px">Feature bloqueada</div>
        <div style="color:#cbd5e1;font-size:13px">${escHtml(err.error || 'Esta función no está disponible en tu plan actual.')}</div>
      </div>
      <button onclick="this.closest('#feature-locked-toast').remove()" style="background:none;border:none;color:#94a3b8;font-size:18px;cursor:pointer;padding:0;line-height:1">×</button>
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button onclick="this.closest('#feature-locked-toast').remove()" style="background:transparent;color:#cbd5e1;border:1px solid rgba(255,255,255,.15);padding:8px 14px;border-radius:8px;font-size:13px;cursor:pointer">Más tarde</button>
      <button onclick="this.closest('#feature-locked-toast').remove();showUpgradeModal(false)" style="background:${ctaColor};color:#fff;border:none;padding:8px 16px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer">${ctaLabel}</button>
    </div>
  `;
  document.body.appendChild(t);
  // Auto-dismiss en 12s si no hace click
  setTimeout(() => t.remove(), 12000);
}
window.showFeatureLockedToast = showFeatureLockedToast;

// ── BILLING ───────────────────────────────────────────────────────────────────
let billingStatus = null;

async function loadBillingStatus() {
  const data = await apiFetch('/api/billing/status');
  if (!data) return;
  billingStatus = data;

  if (data.isAdmin) return; // Admins never see billing UI

  if (data.isExpired) {
    showUpgradeModal(true);
    return;
  }

  // Show trial banner if in trial and 3 days or fewer remain
  const banner = document.getElementById('trial-banner');
  const daysEl = document.getElementById('trial-days-left');
  if (banner && daysEl && data.plan === 'trial' && data.daysLeft <= 3) {
    daysEl.textContent = data.daysLeft === 1 ? '1 día' : `${data.daysLeft} días`;
    banner.style.display = 'flex';
  }

  // Update sidebar — show plan badge
  const planBadge = document.getElementById('sidebar-plan-badge');
  if (planBadge) {
    planBadge.textContent = data.plan === 'trial' ? `Prueba · ${data.daysLeft}d` : data.plan;
    planBadge.style.display = '';
  }
}

function showUpgradeModal(isExpired = false) {
  const modal  = document.getElementById('upgrade-modal');
  const expMsg = document.getElementById('upgrade-expired-msg');
  if (!modal) return;
  if (expMsg) expMsg.style.display = isExpired ? 'block' : 'none';
  modal.style.display = 'flex';
}

function switchProvider(provider) {
  // Toggle tab active state
  document.querySelectorAll('.provider-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.provider === provider);
  });
  // Toggle panel visibility
  const lsPanel = document.getElementById('provider-panel-ls');
  const mpPanel = document.getElementById('provider-panel-mp');
  if (lsPanel) lsPanel.style.display = provider === 'ls' ? '' : 'none';
  if (mpPanel) mpPanel.style.display = provider === 'mp' ? '' : 'none';
}

async function upgradePlan(plan, provider = 'ls') {
  const btn = document.getElementById(`btn-plan-${provider}-${plan}`) || document.getElementById(`btn-plan-${plan}`);
  const originalText = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Redirigiendo...'; }

  const data = await apiFetch('/api/billing/checkout', 'POST', { plan, provider });
  if (data?.url) {
    window.location.href = data.url;
  } else {
    const providerLabel = provider === 'ls' ? 'Lemon Squeezy' : 'Mercado Pago';
    showToast(`❌ Error al crear sesión de pago. Verifica que ${providerLabel} esté configurado.`);
    if (btn) { btn.disabled = false; btn.textContent = originalText; }
  }
}

async function manageSubscription() {
  const data = await apiFetch('/api/billing/portal');
  if (data?.url) {
    window.location.href = data.url;
  } else {
    showToast('❌ No hay suscripción activa para gestionar.');
  }
}

// ── GROWTH ───────────────────────────────────────────────────────────────────
async function loadGrowth() {
  if (!ACCOUNT_ID) return;

  // Stats
  try {
    const stats = await apiFetch(`/api/growth/followup-stats?accountId=${ACCOUNT_ID}`);
    if (stats) {
      document.getElementById('fu-sent').textContent      = stats.sent || 0;
      document.getElementById('fu-pending').textContent   = stats.pending || 0;
      document.getElementById('fu-cancelled').textContent = stats.cancelled || 0;
    }
  } catch {}

  // Magnet links
  await loadMagnetLinks();

  // Follow-up config por agente
  await loadFollowupAgents();

  // Wire buttons (solo una vez)
  const exportBtn = document.getElementById('btn-export-csv');
  if (exportBtn && !exportBtn.dataset.wired) {
    exportBtn.dataset.wired = '1';
    exportBtn.addEventListener('click', exportLeadsCSV);
  }
  const magnetBtn = document.getElementById('btn-create-magnet');
  if (magnetBtn && !magnetBtn.dataset.wired) {
    magnetBtn.dataset.wired = '1';
    magnetBtn.addEventListener('click', createMagnetLink);
  }
}

async function loadFollowupAgents() {
  const container = document.getElementById('followup-agents-list');
  if (!container) return;
  const agents = await apiFetch(`/api/agents?accountId=${ACCOUNT_ID}`);
  if (!agents || !agents.length) {
    container.innerHTML = '<div style="color:var(--text-3);font-size:13px;padding:8px 0">No hay agentes creados todavía</div>';
    return;
  }
  container.innerHTML = agents.map(a => {
    const enabled = a.followup_enabled === true;
    const hours   = a.followup_delay_hours || 3;
    return `
      <div class="fu-agent-row" data-agent-id="${a._id}" style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px;border:1px solid var(--border);border-radius:8px;margin-bottom:8px;background:var(--bg-2)">
        <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:0">
          <span style="font-size:20px">${a.avatar || '🤖'}</span>
          <div style="min-width:0">
            <div style="font-weight:600;font-size:14px">${escHtmlSafe(a.name)}</div>
            <div style="font-size:12px;color:var(--text-3)">
              ${enabled ? `Enviará follow-up si no responden en <strong>${hours}h</strong>` : 'Follow-up desactivado'}
            </div>
          </div>
        </div>
        <input type="number" min="1" max="23" value="${hours}" class="form-input fu-delay" style="width:70px;text-align:center" data-agent-id="${a._id}" ${enabled ? '' : 'disabled'}>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none">
          <input type="checkbox" class="fu-toggle" data-agent-id="${a._id}" ${enabled ? 'checked' : ''}>
          <span style="font-size:12px;color:var(--text-2)">${enabled ? 'ON' : 'OFF'}</span>
        </label>
      </div>`;
  }).join('');

  // Wire toggles
  container.querySelectorAll('.fu-toggle').forEach(cb => {
    cb.addEventListener('change', async (e) => {
      const id = e.target.dataset.agentId;
      const row = e.target.closest('.fu-agent-row');
      const delayInput = row.querySelector('.fu-delay');
      const hours = parseInt(delayInput.value) || 3;
      await apiFetch(`/api/agents/${id}/followup`, 'PATCH', {
        enabled: e.target.checked, delay_hours: hours,
      });
      showToast(e.target.checked ? '✅ Follow-up activado' : '🔕 Follow-up desactivado');
      loadFollowupAgents();
    });
  });
  container.querySelectorAll('.fu-delay').forEach(inp => {
    inp.addEventListener('change', async (e) => {
      const id = e.target.dataset.agentId;
      const hours = Math.max(1, Math.min(23, parseInt(e.target.value) || 3));
      e.target.value = hours;
      await apiFetch(`/api/agents/${id}/followup`, 'PATCH', { delay_hours: hours });
      showToast(`⏱ Delay actualizado a ${hours}h`);
    });
  });
}

async function loadMagnetLinks() {
  const container = document.getElementById('magnet-links-list');
  if (!container) return;
  const links = await apiFetch(`/api/growth/magnet-links?accountId=${ACCOUNT_ID}`);
  const totalClicks = (links || []).reduce((s, l) => s + (l.clicks || 0), 0);
  const mlClicksEl = document.getElementById('ml-clicks');
  if (mlClicksEl) mlClicksEl.textContent = totalClicks;

  if (!links || !links.length) {
    container.innerHTML = '<div style="color:var(--text-3);font-size:13px;padding:8px 0">Aún no has creado ningún magnet link</div>';
    return;
  }
  container.innerHTML = links.map(l => `
    <div style="display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--border);border-radius:8px;margin-bottom:6px;background:var(--bg-2)">
      <div style="flex:1;min-width:0">
        <div style="font-weight:600;font-size:13px">${escHtmlSafe(l.label)} <span style="font-weight:400;font-size:11px;color:var(--text-3);margin-left:6px">[${escHtmlSafe(l.source)}]</span></div>
        <div style="display:flex;align-items:center;gap:8px;margin-top:4px">
          <code style="font-size:11px;color:var(--accent);background:var(--bg-1);padding:2px 6px;border-radius:4px;word-break:break-all">${escHtmlSafe(l.redirect_url)}</code>
          <button class="btn-ghost" style="padding:2px 8px;font-size:11px" onclick="navigator.clipboard.writeText('${l.redirect_url}').then(()=>showToast('📋 Copiado'))">📋</button>
        </div>
        ${l.preset_text ? `<div style="font-size:11px;color:var(--text-3);margin-top:4px;font-style:italic">"${escHtmlSafe(l.preset_text)}"</div>` : ''}
      </div>
      <div style="text-align:right;font-size:12px;color:var(--text-2)">
        <div style="font-weight:700;font-size:18px;color:var(--accent)">${l.clicks}</div>
        <div style="font-size:10px;color:var(--text-3)">clicks</div>
      </div>
      <button class="btn-ghost" style="padding:4px 8px;font-size:12px" onclick="deleteMagnetLink('${l.id}')">🗑</button>
    </div>`).join('');
}

async function createMagnetLink() {
  const label  = document.getElementById('ml-label').value.trim();
  const source = document.getElementById('ml-source').value.trim() || 'bio';
  const preset = document.getElementById('ml-preset').value.trim();
  if (!label) { showToast('❌ Ingresa una etiqueta'); return; }
  const res = await apiFetch('/api/growth/magnet-links', 'POST', {
    accountId: ACCOUNT_ID, label, source, preset_text: preset || null,
  });
  if (res?.id) {
    document.getElementById('ml-label').value  = '';
    document.getElementById('ml-source').value = '';
    document.getElementById('ml-preset').value = '';
    showToast('✅ Magnet link creado');
    loadMagnetLinks();
  }
}

async function deleteMagnetLink(id) {
  if (!confirm('¿Eliminar este magnet link? Los clicks acumulados se perderán.')) return;
  await apiFetch(`/api/growth/magnet-links/${id}`, 'DELETE');
  loadMagnetLinks();
}

function exportLeadsCSV() {
  // Usamos un link con Authorization injectado via fetch + blob (ya que CSV download)
  fetch(`/api/growth/export-leads?accountId=${ACCOUNT_ID}`, {
    headers: { 'Authorization': `Bearer ${AUTH_TOKEN}` },
  })
  .then(r => { if (!r.ok) throw new Error('Error exportando'); return r.blob(); })
  .then(blob => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dmcloser-leads-${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast('📥 CSV descargado');
  })
  .catch(e => showToast('❌ ' + e.message));
}

// Exporta TODAS las conversaciones (1 fila por mensaje) en CSV.
// Útil para casos de éxito, auditoría conversacional, fine-tuning de prompts.
function exportConversationsCSV() {
  fetch(`/api/growth/export-conversations?accountId=${ACCOUNT_ID}&format=csv`, {
    headers: { 'Authorization': `Bearer ${AUTH_TOKEN}` },
  })
  .then(async r => {
    if (!r.ok) {
      const text = await r.text();
      throw new Error(text.includes('No hay') ? 'Sin conversaciones para exportar' : 'Error exportando conversaciones');
    }
    return r.blob();
  })
  .then(blob => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dmcloser-conversations-${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast('💬 Conversaciones descargadas');
  })
  .catch(e => showToast('❌ ' + e.message));
}

function escHtmlSafe(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Exponer delete para onclick inline
window.deleteMagnetLink = deleteMagnetLink;
window.exportLeadsCSV = exportLeadsCSV;
window.exportConversationsCSV = exportConversationsCSV;

// ── LEAD MAGNETS ────────────────────────────────────────────────────────────
const TRIGGER_LABEL = {
  pricing_objection: '💸 Objeción de precio',
  not_ready:         '🤔 No está listo',
  cold_lead:         '❄️ Lead frío',
  diagnostic:        '🔍 Diagnóstico',
  info_request:      '📖 Pide más info',
  generic:           '✨ Genérico',
};

const DELIVERY_LABEL = {
  email: '📧 Email',
  dm:    '💬 DM',
  link:  '🔗 Link',
};

async function loadMagnets() {
  if (!ACCOUNT_ID) return;
  const list = document.getElementById('magnets-list');
  list.innerHTML = '<div style="text-align:center;padding:30px;color:var(--text-3)">⏳ Cargando…</div>';

  try {
    const rows = await apiFetch(`/api/lead-magnets?accountId=${ACCOUNT_ID}`);
    if (!rows || !rows.length) {
      list.innerHTML = `
        <div style="background:#fff7ed;border:1px dashed #fed7aa;border-radius:10px;padding:30px;text-align:center">
          <div style="font-size:32px;margin-bottom:8px">🧲</div>
          <h4 style="margin:0 0 6px;color:#9a3412">Aún no tenés lead magnets</h4>
          <p style="color:var(--text-2);font-size:14px;margin:0">Creá el primero y el bot empezará a ofrecerlo automáticamente a los leads que no están listos para comprar.</p>
        </div>`;
      return;
    }

    list.innerHTML = rows.map(m => `
      <div style="background:#fff;border:1px solid var(--border);border-radius:10px;padding:16px">
        <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap">
          <div style="flex:1;min-width:240px">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px">
              <strong style="font-size:15px">${escHtmlSafe(m.title)}</strong>
              ${m.enabled ? '' : '<span style="background:#fef2f2;color:#991b1b;font-size:11px;padding:2px 8px;border-radius:10px">Pausado</span>'}
            </div>
            ${m.description ? `<div style="color:var(--text-2);font-size:13px;margin-bottom:6px">${escHtmlSafe(m.description)}</div>` : ''}
            ${m.pitch ? `<div style="background:#f9fafb;border-left:3px solid var(--orange);padding:8px 10px;font-size:13px;color:var(--text-2);font-style:italic;margin-bottom:8px">💬 "${escHtmlSafe(m.pitch)}"</div>` : ''}
            <div style="display:flex;gap:10px;font-size:12px;color:var(--text-3);flex-wrap:wrap">
              <span>${TRIGGER_LABEL[m.trigger_intent] || m.trigger_intent}</span>
              <span>•</span>
              <span>${DELIVERY_LABEL[m.delivery] || m.delivery}</span>
              <span>•</span>
              <span>📦 ${m.deliveries} entregados</span>
              ${m.delivery_url ? `<span>•</span><a href="${escHtmlSafe(m.delivery_url)}" target="_blank" style="color:var(--orange);text-decoration:none">Abrir recurso →</a>` : ''}
            </div>
          </div>
          <div style="display:flex;gap:6px;align-items:flex-start">
            <button class="btn-ghost" onclick='editMagnet(${JSON.stringify(m).replace(/'/g, "&apos;")})' style="padding:6px 12px;font-size:13px">Editar</button>
            <button class="btn-ghost" onclick="toggleMagnet('${m.id}', ${!m.enabled})" style="padding:6px 12px;font-size:13px">${m.enabled ? 'Pausar' : 'Activar'}</button>
            <button class="btn-ghost" onclick="deleteMagnet('${m.id}')" style="padding:6px 12px;font-size:13px;color:#dc2626">🗑️</button>
          </div>
        </div>
      </div>
    `).join('');
  } catch (e) {
    list.innerHTML = `<div style="color:#ef4444;padding:20px;text-align:center">Error: ${escHtmlSafe(e.message)}</div>`;
  }
}

function openMagnetForm() {
  document.getElementById('magnet-form-title').textContent = 'Nuevo lead magnet';
  document.getElementById('magnet-id').value = '';
  document.getElementById('magnet-title').value = '';
  document.getElementById('magnet-description').value = '';
  document.getElementById('magnet-pitch').value = '';
  document.getElementById('magnet-trigger').value = 'generic';
  document.getElementById('magnet-delivery').value = 'email';
  document.getElementById('magnet-url').value = '';
  document.getElementById('magnet-modal').style.display = 'flex';
}

function closeMagnetForm() {
  document.getElementById('magnet-modal').style.display = 'none';
}

function editMagnet(m) {
  document.getElementById('magnet-form-title').textContent = 'Editar lead magnet';
  document.getElementById('magnet-id').value = m.id;
  document.getElementById('magnet-title').value = m.title || '';
  document.getElementById('magnet-description').value = m.description || '';
  document.getElementById('magnet-pitch').value = m.pitch || '';
  document.getElementById('magnet-trigger').value = m.trigger_intent || 'generic';
  document.getElementById('magnet-delivery').value = m.delivery || 'email';
  document.getElementById('magnet-url').value = m.delivery_url || '';
  document.getElementById('magnet-modal').style.display = 'flex';
}

async function saveMagnet() {
  const id = document.getElementById('magnet-id').value;
  const body = {
    accountId:      ACCOUNT_ID,
    title:          document.getElementById('magnet-title').value.trim(),
    description:    document.getElementById('magnet-description').value.trim(),
    pitch:          document.getElementById('magnet-pitch').value.trim(),
    trigger_intent: document.getElementById('magnet-trigger').value,
    delivery:       document.getElementById('magnet-delivery').value,
    delivery_url:   document.getElementById('magnet-url').value.trim(),
  };
  if (!body.title) { showToast('Agregá un título'); return; }

  try {
    if (id) {
      await apiFetch(`/api/lead-magnets/${id}`, 'PATCH', body);
      showToast('✅ Magnet actualizado');
    } else {
      await apiFetch(`/api/lead-magnets`, 'POST', body);
      showToast('✅ Magnet creado');
    }
    closeMagnetForm();
    loadMagnets();
  } catch (e) { showToast('❌ ' + e.message); }
}

async function toggleMagnet(id, enabled) {
  try {
    await apiFetch(`/api/lead-magnets/${id}`, 'PATCH', { enabled });
    loadMagnets();
  } catch (e) { showToast('❌ ' + e.message); }
}

async function deleteMagnet(id) {
  if (!confirm('¿Eliminar este lead magnet? El bot dejará de ofrecerlo.')) return;
  try {
    await apiFetch(`/api/lead-magnets/${id}`, 'DELETE');
    showToast('🗑️ Magnet eliminado');
    loadMagnets();
  } catch (e) { showToast('❌ ' + e.message); }
}

// Exponer para onclick inline
window.openMagnetForm = openMagnetForm;
window.closeMagnetForm = closeMagnetForm;
window.editMagnet = editMagnet;
window.saveMagnet = saveMagnet;
window.toggleMagnet = toggleMagnet;
window.deleteMagnet = deleteMagnet;

// ── ANALYTICS DASHBOARD ─────────────────────────────────────────────────────
async function loadAnalytics() {
  if (!ACCOUNT_ID) return;
  const winSel = document.getElementById('analytics-window');
  const days = winSel ? parseInt(winSel.value) || 30 : 30;

  // Bind window selector + export button (una sola vez)
  if (!window.__analyticsBound) {
    window.__analyticsBound = true;
    if (winSel) winSel.addEventListener('change', loadAnalytics);
    const btnExport = document.getElementById('btn-export-csv');
    if (btnExport) {
      btnExport.addEventListener('click', async (ev) => {
        ev.preventDefault();
        try {
          // Como el endpoint requiere Authorization header, hacemos fetch + descargamos blob
          const r = await fetch(`/api/growth/export-leads?accountId=${ACCOUNT_ID}`, {
            headers: { 'Authorization': 'Bearer ' + AUTH_TOKEN },
          });
          if (!r.ok) { showToast('❌ Error al exportar'); return; }
          const blob = await r.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url; a.download = `dmcloser-leads-${new Date().toISOString().slice(0, 10)}.csv`;
          a.click();
          URL.revokeObjectURL(url);
          showToast('✅ CSV descargado');
        } catch (e) { showToast('❌ ' + e.message); }
      });
    }
    // Botón nuevo: descargar conversaciones completas (1 fila por mensaje)
    const btnExportConv = document.getElementById('btn-export-conversations');
    if (btnExportConv) {
      btnExportConv.addEventListener('click', async (ev) => {
        ev.preventDefault();
        try {
          const r = await fetch(`/api/growth/export-conversations?accountId=${ACCOUNT_ID}&format=csv`, {
            headers: { 'Authorization': 'Bearer ' + AUTH_TOKEN },
          });
          if (!r.ok) {
            const text = await r.text();
            const msg = text.includes('No hay') ? 'Sin conversaciones para exportar todavía' : 'Error al exportar';
            showToast('❌ ' + msg);
            return;
          }
          const blob = await r.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url; a.download = `dmcloser-conversations-${new Date().toISOString().slice(0, 10)}.csv`;
          a.click();
          URL.revokeObjectURL(url);
          showToast('💬 Conversaciones descargadas');
        } catch (e) { showToast('❌ ' + e.message); }
      });
    }
  }

  try {
    const data = await apiFetch(`/api/growth/analytics?accountId=${ACCOUNT_ID}&days=${days}`);
    if (!data) return;
    renderAnalyticsKPIs(data);
    renderLeadsChart(data.leadsByDay);
    renderQualBars(data.qualificationBreakdown);
    renderHeatmap(data.dmsByHour);
    renderAnalyticsFunnel(data.funnel);
    renderCompareCard(data.compare);
    renderTopKeywords(data.topKeywords);
    ANALYTICS_LEADS_CACHE = data.recentLeads || [];
    renderAnalyticsLeadsTable('all');

    // Bind filtros la primera vez
    if (!window.__analyticsLeadFiltersBound) {
      window.__analyticsLeadFiltersBound = true;
      document.querySelectorAll('.lead-filter').forEach(btn => {
        btn.addEventListener('click', () => {
          document.querySelectorAll('.lead-filter').forEach(b => {
            b.classList.remove('active');
            b.style.background = '#fff';
            b.style.color = 'var(--text-2)';
          });
          btn.classList.add('active');
          btn.style.background = 'var(--orange)';
          btn.style.color = '#fff';
          renderAnalyticsLeadsTable(btn.dataset.filter);
        });
      });
    }
  } catch (e) {
    showToast('❌ Error cargando analytics');
  }
}

let ANALYTICS_LEADS_CACHE = [];

function renderCompareCard(c) {
  if (!c) return;
  const arrow = (pct) => {
    if (pct > 0) return `<span style="color:#16a34a;font-weight:700">↑ ${pct}%</span>`;
    if (pct < 0) return `<span style="color:#dc2626;font-weight:700">↓ ${Math.abs(pct)}%</span>`;
    return `<span style="color:var(--text-3)">— sin cambio</span>`;
  };
  const row = (label, item, color) => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border)">
      <div>
        <div style="font-size:13px;color:var(--text-2)">${label}</div>
        <div style="font-size:1.4rem;font-weight:800;color:${color || 'var(--text-1)'};margin-top:2px">${item.current}</div>
        <div style="font-size:11px;color:var(--text-3);margin-top:2px">vs ${item.prev} en período anterior</div>
      </div>
      <div style="font-size:14px">${arrow(item.pct)}</div>
    </div>`;
  document.getElementById('analytics-compare').innerHTML =
    row('Leads totales', c.total, 'var(--text-1)') +
    row('Leads HOT',     c.hot,   '#dc2626') +
    row('Convertidos',   c.converted, '#16a34a');
}

function renderTopKeywords(words) {
  const cont = document.getElementById('analytics-keywords');
  if (!words || !words.length) {
    cont.innerHTML = '<div style="color:var(--text-3);font-size:13px;text-align:center;padding:20px;width:100%">Sin mensajes suficientes para analizar</div>';
    return;
  }
  // Tamaño según frecuencia
  const max = words[0].count;
  cont.innerHTML = words.map(w => {
    const intensity = w.count / max;
    const fontSize = 12 + intensity * 6;
    const opacity = 0.5 + intensity * 0.5;
    return `<span style="background:rgba(16,185,129,${opacity * 0.15});color:rgba(16,185,129,${0.6 + intensity * 0.4});border:1px solid rgba(16,185,129,${0.2 + intensity * 0.3});padding:5px 11px;border-radius:14px;font-size:${fontSize}px;font-weight:${500 + Math.round(intensity * 300)}" title="${w.count} usos">${escHtmlSafe(w.word)} <small style="opacity:.6">${w.count}</small></span>`;
  }).join('');
}

function renderAnalyticsLeadsTable(filter) {
  let leads = ANALYTICS_LEADS_CACHE.slice();
  if (filter === 'hot')        leads = leads.filter(l => l.qualification === 'hot');
  else if (filter === 'warm')  leads = leads.filter(l => l.qualification === 'warm');
  else if (filter === 'cold')  leads = leads.filter(l => l.qualification === 'cold');
  else if (filter === 'converted') leads = leads.filter(l => l.is_converted);

  const cont = document.getElementById('analytics-leads-table');
  if (!leads.length) {
    cont.innerHTML = '<div style="color:var(--text-3);text-align:center;padding:30px;font-size:13px">Sin leads que coincidan</div>';
    return;
  }

  const qBadge = (q) => {
    if (q === 'hot')  return '<span style="background:#fef2f2;color:#dc2626;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600">🔥 HOT</span>';
    if (q === 'warm') return '<span style="background:#fef3c7;color:#d97706;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600">🟡 WARM</span>';
    if (q === 'cold') return '<span style="background:#dbeafe;color:#2563eb;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600">❄️ COLD</span>';
    return '<span style="color:var(--text-3);font-size:11px">—</span>';
  };

  cont.innerHTML = `
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead>
        <tr style="text-align:left;color:var(--text-3);font-size:11px;text-transform:uppercase;letter-spacing:.06em">
          <th style="padding:10px 8px;border-bottom:1px solid var(--border)">@usuario</th>
          <th style="padding:10px 8px;border-bottom:1px solid var(--border)">Calificación</th>
          <th style="padding:10px 8px;border-bottom:1px solid var(--border)">Razón</th>
          <th style="padding:10px 8px;border-bottom:1px solid var(--border);text-align:center">Msgs</th>
          <th style="padding:10px 8px;border-bottom:1px solid var(--border)">Email</th>
          <th style="padding:10px 8px;border-bottom:1px solid var(--border)">Estado</th>
          <th style="padding:10px 8px;border-bottom:1px solid var(--border)">Última actividad</th>
        </tr>
      </thead>
      <tbody>
        ${leads.map(l => `
          <tr style="border-bottom:1px solid var(--border)">
            <td style="padding:10px 8px"><a href="https://instagram.com/${escHtmlSafe(l.ig_username || '')}" target="_blank" style="color:var(--orange);text-decoration:none;font-weight:600">@${escHtmlSafe(l.ig_username || '—')}</a></td>
            <td style="padding:10px 8px">${qBadge(l.qualification)}</td>
            <td style="padding:10px 8px;color:var(--text-2);font-size:12px;max-width:280px"><div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtmlSafe(l.qualification_reason || '')}">${escHtmlSafe(l.qualification_reason || '—')}</div></td>
            <td style="padding:10px 8px;text-align:center;color:var(--text-2)">${l.message_count}</td>
            <td style="padding:10px 8px;font-size:12px;color:var(--text-2)">${escHtmlSafe(l.email || '—')}</td>
            <td style="padding:10px 8px">
              ${l.is_converted ? '<span style="color:#16a34a;font-size:12px;font-weight:600">✓ Convertido</span>' : ''}
              ${l.is_bypassed ? '<span style="color:#6b7280;font-size:12px">⏸ Pausado</span>' : ''}
              ${!l.is_converted && !l.is_bypassed ? '<span style="color:var(--text-3);font-size:12px">activo</span>' : ''}
            </td>
            <td style="padding:10px 8px;color:var(--text-3);font-size:12px">${l.last_message_at ? relTime(l.last_message_at) : '—'}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function renderAnalyticsKPIs(d) {
  const k = d.kpis;
  const fmtSec = (s) => {
    if (s === null || s === undefined) return '—';
    if (s < 60) return s + 's';
    if (s < 3600) return Math.round(s / 60) + 'm';
    return (s / 3600).toFixed(1) + 'h';
  };
  document.getElementById('kpi-total').textContent       = k.total;
  document.getElementById('kpi-hot').textContent         = k.hot;
  document.getElementById('kpi-converted').textContent   = k.converted;
  document.getElementById('kpi-resp').textContent        = fmtSec(k.avgResponseSec);
  document.getElementById('kpi-qualified').textContent   = k.qualifiedRate + '%';
  document.getElementById('kpi-conv').textContent        = k.conversionRate + '%';
  document.getElementById('kpi-hotrate').textContent     = k.hotRate + '%';
  document.getElementById('kpi-respondidos').textContent = k.respondidos;
}

function renderLeadsChart(byDay) {
  const entries = Object.entries(byDay || {});
  const max = Math.max(1, ...entries.map(([, v]) => v));
  const chart = document.getElementById('analytics-leads-chart');
  if (!entries.length) {
    chart.innerHTML = '<div style="margin:auto;color:var(--text-3);font-size:13px">Sin datos en este período</div>';
    return;
  }
  chart.innerHTML = entries.map(([date, count]) => {
    const pct = (count / max) * 100;
    const day = date.slice(8); // DD
    const month = date.slice(5, 7);
    return `
      <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;min-width:0" title="${date}: ${count} leads">
        <div style="background:linear-gradient(180deg,#10b981,#06b6d4);width:100%;height:${pct}%;min-height:${count > 0 ? '4px' : '0'};border-radius:4px 4px 0 0;transition:.3s"></div>
        ${count > 0 ? `<div style="font-size:9px;color:var(--text-3);font-weight:600">${count}</div>` : ''}
      </div>`;
  }).join('');
}

function renderQualBars(q) {
  const total = (q.hot || 0) + (q.warm || 0) + (q.cold || 0) + (q.sin_calificar || 0);
  if (total === 0) {
    document.getElementById('analytics-qual-bars').innerHTML = '<div style="color:var(--text-3);text-align:center;padding:20px;font-size:13px">Sin leads aún</div>';
    return;
  }
  const items = [
    { label: '🔥 HOT',  count: q.hot || 0,            color: '#ef4444' },
    { label: '🟡 WARM', count: q.warm || 0,           color: '#f59e0b' },
    { label: '❄️ COLD', count: q.cold || 0,           color: '#3b82f6' },
    { label: '⚪ Sin calificar', count: q.sin_calificar || 0, color: '#94a3b8' },
  ];
  document.getElementById('analytics-qual-bars').innerHTML = items.map(it => {
    const pct = total > 0 ? Math.round((it.count / total) * 100) : 0;
    return `
      <div>
        <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px">
          <span>${it.label}</span>
          <span style="color:var(--text-2)"><strong>${it.count}</strong> · ${pct}%</span>
        </div>
        <div style="background:#f3f4f6;height:8px;border-radius:4px;overflow:hidden">
          <div style="width:${pct}%;height:100%;background:${it.color};transition:.3s"></div>
        </div>
      </div>`;
  }).join('');
}

function renderHeatmap(byHour) {
  const max = Math.max(1, ...byHour);
  document.getElementById('analytics-heatmap').innerHTML = byHour.map((count, h) => {
    const intensity = count / max;
    const opacity = 0.15 + intensity * 0.85;
    return `<div title="${h}h: ${count} DMs" style="background:rgba(16,185,129,${opacity});aspect-ratio:1;border-radius:3px;display:flex;align-items:center;justify-content:center;font-size:9px;color:${intensity>0.5?'#fff':'var(--text-3)'}">${count > 0 ? count : ''}</div>`;
  }).join('');
}

function renderAnalyticsFunnel(stages) {
  if (!stages || !stages.length) {
    document.getElementById('analytics-funnel').innerHTML = '<div style="color:var(--text-3);text-align:center;padding:20px">Sin datos</div>';
    return;
  }
  const max = Math.max(...stages.map(s => s.count), 1);
  document.getElementById('analytics-funnel').innerHTML = stages.map((s, i) => {
    const width = Math.max(8, (s.count / max) * 100);
    const prev = i > 0 ? stages[i-1].count : null;
    const dropPct = prev && prev > 0 ? Math.round((1 - s.count / prev) * 100) : 0;
    const colors = ['#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#16a34a'];
    return `
      <div>
        ${i > 0 && dropPct > 0 ? `<div style="font-size:11px;color:#94a3b8;margin-left:14px;margin-bottom:2px">↓ ${dropPct}% drop (${prev - s.count} se cayeron)</div>` : ''}
        <div style="display:flex;align-items:center;gap:12px">
          <div style="min-width:180px;font-size:13.5px"><strong>${escHtmlSafe(s.label)}</strong></div>
          <div style="flex:1;background:#f3f4f6;border-radius:6px;height:32px;position:relative;overflow:hidden">
            <div style="height:100%;width:${width}%;background:linear-gradient(90deg,${colors[i] || '#10b981'},${colors[i] || '#10b981'}cc);transition:.4s;border-radius:6px"></div>
            <div style="position:absolute;inset:0;display:flex;align-items:center;padding-left:12px;font-size:13px;font-weight:700;color:#fff">${s.count}</div>
          </div>
        </div>
      </div>`;
  }).join('');
}

window.loadAnalytics = loadAnalytics;

// ── INBOX UNIFICADO ────────────────────────────────────────────────────────
let INBOX_FILTER = 'all';
let INBOX_SELECTED_ID = null;
let INBOX_REFRESH_TIMER = null;
let INBOX_SEARCH = '';

async function loadInbox() {
  if (!ACCOUNT_ID) return;

  // Bind filtros + buscador la primera vez
  if (!window.__inboxBound) {
    window.__inboxBound = true;
    document.querySelectorAll('.inbox-filter').forEach(btn => {
      btn.addEventListener('click', () => {
        INBOX_FILTER = btn.dataset.filter;
        document.querySelectorAll('.inbox-filter').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        renderInboxList();
      });
    });
    const searchInput = document.getElementById('inbox-search');
    if (searchInput) {
      let t;
      searchInput.addEventListener('input', () => {
        clearTimeout(t);
        t = setTimeout(() => {
          INBOX_SEARCH = searchInput.value.trim();
          renderInboxList();
        }, 250);
      });
    }

    // Event delegation: click en cualquier .inbox-item dispara selectInboxItem
    // (más robusto que onclick inline; no depende del global scope)
    const listEl = document.getElementById('inbox-list');
    if (listEl) {
      listEl.addEventListener('click', (ev) => {
        const item = ev.target.closest('.inbox-item');
        if (!item) return;
        const leadId = item.getAttribute('data-lead-id');
        if (leadId) selectInboxItem(leadId);
      });
    }

    // Event delegation para los botones del thread (header + input bar)
    const threadEl = document.getElementById('inbox-thread');
    if (threadEl) {
      threadEl.addEventListener('click', (ev) => {
        const btn = ev.target.closest('[data-action]');
        if (!btn) return;
        const action = btn.getAttribute('data-action');
        if (action === 'take-control')   takeControl();
        if (action === 'return-to-bot')  returnToBot();
        if (action === 'open-templates') openQuickReplies();
        if (action === 'send-message')   sendInboxMessage();
        if (action === 'clear-chat')     clearChatMessages();
        if (action === 'delete-lead')    deleteLead();
      });
    }
  }

  await Promise.all([renderInboxList(), updateInboxBadge()]);

  // Auto-refresh cada 20s mientras estás en el inbox
  if (INBOX_REFRESH_TIMER) clearInterval(INBOX_REFRESH_TIMER);
  INBOX_REFRESH_TIMER = setInterval(() => {
    const visible = document.getElementById('section-inbox')?.classList.contains('active');
    if (!visible) { clearInterval(INBOX_REFRESH_TIMER); INBOX_REFRESH_TIMER = null; return; }
    renderInboxList();
    updateInboxBadge();
    if (INBOX_SELECTED_ID) renderInboxThread(INBOX_SELECTED_ID, true);
  }, 20000);
}

async function renderInboxList() {
  const params = new URLSearchParams({ accountId: ACCOUNT_ID, filter: INBOX_FILTER });
  if (INBOX_SEARCH) params.set('search', INBOX_SEARCH);
  try {
    const r = await apiFetch(`/api/inbox?${params}`);
    if (!r) return;
    updateFilterCounts();

    const list = document.getElementById('inbox-list');
    if (!r.items.length) {
      list.innerHTML = `
        <div style="padding:50px 20px;text-align:center;color:var(--text-3)">
          <div style="font-size:32px;margin-bottom:8px">📭</div>
          <div style="font-size:13px">Sin conversaciones${INBOX_FILTER !== 'all' ? ' con este filtro' : ' aún'}</div>
        </div>`;
      return;
    }

    list.innerHTML = r.items.map(item => {
      const initial = (item.ig_username || '?').slice(0, 2).toUpperCase();
      const when = item.last_message?.when ? relTime(item.last_message.when) : '';
      const preview = item.last_message
        ? `${item.last_message.role !== 'user' ? '↪ ' : ''}${escHtmlSafe(item.last_message.preview)}`
        : '(sin mensajes)';
      const badges = [];
      if (item.qualification === 'hot')  badges.push('<span class="badge-q hot">🔥 HOT</span>');
      if (item.qualification === 'warm') badges.push('<span class="badge-q warm">🟡 WARM</span>');
      if (item.qualification === 'cold') badges.push('<span class="badge-q cold">❄️ COLD</span>');
      if (item.is_bypassed)              badges.push('<span class="badge-q bypassed">🚫 Pausada</span>');
      if (item.is_converted)             badges.push('<span class="badge-q converted">✓ Convertido</span>');

      return `
        <div class="inbox-item ${item.unread ? 'unread' : ''} ${INBOX_SELECTED_ID === item.id ? 'selected' : ''}" data-lead-id="${escHtmlSafe(item.id)}">
          <div class="avatar">${escHtmlSafe(initial)}</div>
          <div class="meta">
            <div class="top-row">
              <span class="ig-name">@${escHtmlSafe(item.ig_username || '—')}</span>
              <span class="when">${when}</span>
            </div>
            <div class="preview">${preview}</div>
            ${badges.length ? `<div class="badges">${badges.join('')}</div>` : ''}
          </div>
          ${item.unread ? '<div class="unread-dot"></div>' : ''}
        </div>`;
    }).join('');
  } catch (e) {
    document.getElementById('inbox-list').innerHTML = `<div style="padding:20px;text-align:center;color:#ef4444">${escHtmlSafe(e.message)}</div>`;
  }
}

async function updateFilterCounts() {
  try {
    const c = await apiFetch(`/api/inbox/counters?accountId=${ACCOUNT_ID}`);
    if (!c) return;
    const setCnt = (filter, val) => {
      const btn = document.querySelector(`.inbox-filter[data-filter="${filter}"] .cnt`);
      if (btn) btn.textContent = val > 0 ? val : '';
    };
    setCnt('all', c.all);
    setCnt('unread', c.unread);
    setCnt('hot', c.hot);
    setCnt('warm', c.warm);
    setCnt('cold', c.cold);
    setCnt('bypassed', c.bypassed);
  } catch (e) { /* silent */ }
}

async function updateInboxBadge() {
  try {
    const c = await apiFetch(`/api/inbox/counters?accountId=${ACCOUNT_ID}`);
    const badge = document.getElementById('inbox-badge');
    if (!badge || !c) return;
    if (c.unread > 0) {
      badge.style.display = '';
      badge.textContent = c.unread > 99 ? '99+' : c.unread;
    } else {
      badge.style.display = 'none';
    }
  } catch (e) { /* silent */ }
}

async function selectInboxItem(leadId) {
  INBOX_SELECTED_ID = leadId;
  // Update selected en la lista por data-lead-id
  document.querySelectorAll('.inbox-item').forEach(el => {
    el.classList.toggle('selected', el.getAttribute('data-lead-id') === leadId);
  });
  await renderInboxThread(leadId);
  // Marcar leído (best-effort, no bloquea)
  apiFetch(`/api/inbox/${leadId}/read`, 'POST').catch(() => null);
  setTimeout(() => { renderInboxList(); updateInboxBadge(); }, 400);
}

async function renderInboxThread(leadId, isRefresh = false) {
  const container = document.getElementById('inbox-thread');
  if (!container) return;

  // Preservar la posición de scroll del thread y el contenido del input antes
  // de re-renderizar (refresh cada 20s no debería arrastrar al user al fondo
  // mientras está leyendo arriba, ni borrar lo que está escribiendo).
  const prevBody = document.getElementById('thread-body');
  const prevInput = document.getElementById('thread-input-text');
  const prevScrollTop = prevBody?.scrollTop ?? 0;
  const prevScrollHeight = prevBody?.scrollHeight ?? 0;
  const prevClientHeight = prevBody?.clientHeight ?? 0;
  const wasAtBottom = prevBody ? (prevScrollHeight - prevScrollTop - prevClientHeight < 60) : true;
  const draftText = prevInput?.value ?? '';

  if (!isRefresh) {
    container.innerHTML = '<div style="margin:auto;color:var(--text-3);padding:30px">⏳ Cargando…</div>';
  }

  try {
    const lead = await apiFetch(`/api/leads/${leadId}`);
    if (!lead) return;

    const initial = (lead.ig_username || '?').slice(0, 2).toUpperCase();
    const dmUrl = `https://www.instagram.com/direct/t/${lead.ig_user_id}/`;

    const messages = (lead.messages || []).map(m => {
      const cls = m.role === 'user' ? 'user' : (m.role === 'manual' ? 'manual' : 'agent');
      const tag = m.role === 'user' ? `<span class="role-tag">@${escHtmlSafe(lead.ig_username)}</span>` : '';
      const tagAuthor = m.role === 'manual' ? '✋ Vos' : (m.role === 'agent' ? '🤖 Bot' : '');
      const when = m.createdAt ? new Date(m.createdAt).toLocaleString('es-ES', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' }) : '';
      return `
        <div class="bubble ${cls}">
          ${tag}
          ${escHtmlSafe(m.content || '')}
          <span class="when">${tagAuthor ? tagAuthor + ' · ' : ''}${when}</span>
        </div>`;
    }).join('');

    const qualBadge = lead.qualification === 'hot' ? '<span class="badge-q hot">🔥 HOT</span>'
      : lead.qualification === 'warm' ? '<span class="badge-q warm">🟡 WARM</span>'
      : lead.qualification === 'cold' ? '<span class="badge-q cold">❄️ COLD</span>' : '';

    // Banner que muestra inequivocamente si el bot esta activo o pausado en esta conversacion
    const stateBanner = lead.is_bypassed
      ? `<div style="background:#fef2f2;border-bottom:2px solid #fca5a5;color:#991b1b;padding:8px 16px;font-size:12.5px;font-weight:600;display:flex;align-items:center;gap:8px">
           <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#dc2626;box-shadow:0 0 0 3px rgba(220,38,38,.18)"></span>
           ✋ Vos tenés el control · el bot está pausado en esta conversación
         </div>`
      : `<div style="background:#f0fdf4;border-bottom:1px solid #bbf7d0;color:#166534;padding:8px 16px;font-size:12.5px;font-weight:500;display:flex;align-items:center;gap:8px">
           <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#22c55e;box-shadow:0 0 0 3px rgba(34,197,94,.18)"></span>
           🤖 El bot está respondiendo automáticamente esta conversación
         </div>`;

    const ctlBtn = lead.is_bypassed
      ? '<button id="thread-ctl-btn" class="btn-primary" data-action="return-to-bot" style="padding:7px 12px;font-size:12.5px;background:#16a34a">🤖 Devolver al bot</button>'
      : '<button id="thread-ctl-btn" class="btn-ghost" data-action="take-control" style="padding:7px 12px;font-size:12.5px;border:2px solid var(--orange);color:var(--orange);font-weight:600">✋ Tomar control</button>';

    container.innerHTML = `
      <div class="thread-header">
        <div class="avatar">${escHtmlSafe(initial)}</div>
        <div class="info">
          <h3>@${escHtmlSafe(lead.ig_username || '—')} ${qualBadge}</h3>
          <p>${lead.qualification_reason ? escHtmlSafe(lead.qualification_reason) : 'sin calificar aún'}</p>
        </div>
        <div class="actions">
          <a href="${dmUrl}" target="_blank" class="btn-ghost" style="padding:7px 12px;font-size:12.5px;text-decoration:none;display:inline-flex;align-items:center;gap:5px">📲 Abrir IG</a>
          ${ctlBtn}
          <button class="btn-ghost" data-action="clear-chat" title="Borrar mensajes pero mantener el lead (útil para resetear conversación de prueba)" style="padding:7px 10px;font-size:12.5px">🧹</button>
          <button class="btn-ghost" data-action="delete-lead" title="Borrar este lead y toda su conversación" style="padding:7px 10px;font-size:12.5px;color:#dc2626">🗑️</button>
        </div>
      </div>
      ${stateBanner}
      <div class="thread-body" id="thread-body">
        ${messages || '<div style="margin:auto;color:var(--text-3);padding:30px;text-align:center">Sin mensajes aún</div>'}
      </div>
      <div class="thread-input">
        <div class="row">
          <textarea id="thread-input-text" placeholder="Escribí tu respuesta..." rows="1" onkeydown="handleThreadKey(event)"></textarea>
          <button class="btn-ghost" data-action="open-templates" title="Insertar plantilla" style="padding:10px 12px;font-size:13px">📋</button>
          <button class="btn-primary" data-action="send-message" style="padding:10px 18px;font-size:13px">Enviar</button>
        </div>
        <div class="hint">${lead.is_bypassed ? '🚫 El bot está pausado · lo que escribas se manda como vos.' : '⚠️ Si respondés vos, el bot se pausa automáticamente para esta conversación.'} <kbd style="font-size:10px;background:#f3f4f6;padding:2px 5px;border-radius:3px">Enter</kbd> envía · <kbd style="font-size:10px;background:#f3f4f6;padding:2px 5px;border-radius:3px">Shift+Enter</kbd> nueva línea</div>
      </div>
    `;

    // Restaurar draft + scroll position correcto:
    // - En primera carga (no refresh): scroll al fondo
    // - En refresh: solo scrollear al fondo si el user YA estaba en el fondo
    //   (esto permite leer mensajes viejos sin que el auto-refresh te tire abajo)
    const body = document.getElementById('thread-body');
    const input = document.getElementById('thread-input-text');
    if (input && draftText) input.value = draftText;
    if (body) {
      if (!isRefresh || wasAtBottom) {
        body.scrollTop = body.scrollHeight;
      } else {
        body.scrollTop = prevScrollTop;
      }
    }

  } catch (e) {
    container.innerHTML = `<div style="margin:auto;color:#ef4444;padding:30px">${escHtmlSafe(e.message)}</div>`;
  }
}

function handleThreadKey(ev) {
  if (ev.key === 'Enter' && !ev.shiftKey) {
    ev.preventDefault();
    sendInboxMessage();
  }
}

async function sendInboxMessage() {
  if (!INBOX_SELECTED_ID) return;
  const input = document.getElementById('thread-input-text');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;

  input.disabled = true;
  try {
    await apiFetch(`/api/leads/${INBOX_SELECTED_ID}/message`, 'POST', {
      text, accountId: ACCOUNT_ID, takeControl: true,
    });
    input.value = '';
    await renderInboxThread(INBOX_SELECTED_ID, true);
    renderInboxList();
  } catch (e) {
    showToast('❌ ' + e.message);
  } finally {
    input.disabled = false;
    input.focus();
  }
}

async function takeControl() {
  if (!INBOX_SELECTED_ID) return;
  try {
    await apiFetch(`/api/leads/${INBOX_SELECTED_ID}`, 'PATCH', {
      is_bypassed: true, automation: 'paused',
    });
    showToast('✋ Tomaste el control. El bot dejó de responder esta conversación.');
    renderInboxThread(INBOX_SELECTED_ID, true);
    renderInboxList();
  } catch (e) { showToast('❌ ' + e.message); }
}

async function returnToBot() {
  if (!INBOX_SELECTED_ID) return;
  if (!confirm('¿Devolver esta conversación al bot? Va a seguir respondiendo automáticamente.')) return;
  try {
    await apiFetch(`/api/leads/${INBOX_SELECTED_ID}`, 'PATCH', {
      is_bypassed: false, automation: 'automated',
    });
    showToast('🤖 Devuelto al bot.');
    renderInboxThread(INBOX_SELECTED_ID, true);
    renderInboxList();
  } catch (e) { showToast('❌ ' + e.message); }
}

// ── Limpiar mensajes pero mantener el lead ─────────────────────────────────
// Útil para resetear conversaciones de prueba antes de un demo en vivo.
// El bot va a tratar el próximo DM como primer mensaje (vuelve a calificar).
async function clearChatMessages() {
  if (!INBOX_SELECTED_ID) return;
  if (!confirm('¿Borrar todos los mensajes de esta conversación?\n\nEl lead se mantiene en la lista pero la próxima vez que escriba el bot lo trata como primer contacto. NO afecta el chat real en Instagram, solo los mensajes guardados acá.')) return;
  try {
    await apiFetch(`/api/leads/${INBOX_SELECTED_ID}/clear-messages`, 'POST');
    showToast('🧹 Conversación limpiada.');
    renderInboxThread(INBOX_SELECTED_ID, true);
    renderInboxList();
  } catch (e) { showToast('❌ ' + e.message); }
}

// ── Borrar lead completo (lead + mensajes + queue) ─────────────────────────
async function deleteLead() {
  if (!INBOX_SELECTED_ID) return;
  if (!confirm('¿Borrar este lead completamente?\n\nVa a desaparecer de tu inbox junto con toda la conversación. Esta acción no se puede deshacer (pero si el lead te vuelve a escribir por IG, va a aparecer como nuevo).')) return;
  try {
    await apiFetch(`/api/leads/${INBOX_SELECTED_ID}`, 'DELETE');
    showToast('🗑️ Lead borrado.');
    INBOX_SELECTED_ID = null;
    const container = document.getElementById('inbox-thread');
    if (container) container.innerHTML = '<div style="margin:auto;color:var(--text-3);padding:30px;text-align:center">Seleccioná una conversación</div>';
    renderInboxList();
    updateInboxBadge();
  } catch (e) { showToast('❌ ' + e.message); }
}

function relTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1)    return 'ahora';
  if (mins < 60)   return mins + 'm';
  const h = Math.floor(mins / 60);
  if (h < 24)      return h + 'h';
  const days = Math.floor(h / 24);
  if (days < 7)    return days + 'd';
  return d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short' });
}

window.selectInboxItem = selectInboxItem;
window.handleThreadKey = handleThreadKey;
window.sendInboxMessage = sendInboxMessage;
window.takeControl = takeControl;
window.returnToBot = returnToBot;
window.clearChatMessages = clearChatMessages;
window.deleteLead = deleteLead;
window.loadInbox = loadInbox;

// Refrescar el badge del nav cada 30s mientras la app esté abierta
setInterval(() => { if (ACCOUNT_ID) updateInboxBadge(); }, 30000);

// ── PÁGINA DE FACTURACIÓN ──────────────────────────────────────────────────
const PLAN_LABEL = {
  trial:   { name: 'Prueba gratuita', usd: 0,   clp: 0,       desc: 'Probando DMCloser' },
  starter: { name: 'Starter',         usd: 197, clp: 180000,  desc: '500 conv/mes · 3 agentes' },
  pro:     { name: 'Pro',             usd: 297, clp: 270000,  desc: 'Ilimitado · 3 cuentas IG' },
  agency:  { name: 'Agency',          usd: 497, clp: 450000,  desc: '10 cuentas · white-label' },
  admin:   { name: 'Admin',           usd: 0,   clp: 0,       desc: 'Acceso total' },
};

const STATUS_LABEL = {
  active:    { text: 'Activa',    color: '#16a34a', bg: '#dcfce7' },
  trial:     { text: 'En prueba', color: '#d97706', bg: '#fef3c7' },
  cancelled: { text: 'Cancelada — accedés hasta el vencimiento', color: '#dc2626', bg: '#fee2e2' },
  past_due:  { text: 'Pago pendiente', color: '#dc2626', bg: '#fee2e2' },
  paused:    { text: 'Pausada', color: '#6b7280', bg: '#f3f4f6' },
  expired:   { text: 'Expirada', color: '#dc2626', bg: '#fee2e2' },
};

async function loadBillingPage() {
  const card = document.getElementById('billing-current');
  const actions = document.getElementById('billing-actions');
  if (!card) return;

  try {
    const data = await apiFetch('/api/billing/status');
    if (!data) return;

    const planInfo = PLAN_LABEL[data.plan] || PLAN_LABEL.trial;
    const statusKey = data.subscriptionStatus || (data.plan === 'trial' ? 'trial' : (data.isExpired ? 'expired' : 'active'));
    const statusInfo = STATUS_LABEL[statusKey] || STATUS_LABEL.active;

    const isPaid = ['starter', 'pro', 'agency'].includes(data.plan) && data.subscriptionStatus === 'active';
    const isTrial = data.plan === 'trial';
    const providerLabel = data.provider === 'ls' ? 'Lemon Squeezy (USD)' : data.provider === 'mp' ? 'Mercado Pago (CLP)' : '—';

    const renewDate = data.expiresAt ? new Date(data.expiresAt).toLocaleDateString('es-ES', { day: '2-digit', month: 'long', year: 'numeric' }) : '—';
    const monthlyAmount = data.provider === 'mp'
      ? `$${planInfo.clp.toLocaleString('es-CL')} CLP/mes`
      : `$${planInfo.usd} USD/mes`;

    card.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:14px;margin-bottom:18px">
        <div>
          <div style="font-size:12px;color:var(--text-3);text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px">Plan actual</div>
          <h2 style="margin:0;font-size:26px;letter-spacing:-.01em">${escHtmlSafe(planInfo.name)}</h2>
          <div style="color:var(--text-2);font-size:13.5px;margin-top:4px">${escHtmlSafe(planInfo.desc)}</div>
        </div>
        <div style="text-align:right">
          <span style="display:inline-block;background:${statusInfo.bg};color:${statusInfo.color};padding:5px 12px;border-radius:20px;font-size:12.5px;font-weight:600">${escHtmlSafe(statusInfo.text)}</span>
          ${isPaid ? `<div style="margin-top:8px;font-size:18px;font-weight:700;color:var(--text-1)">${monthlyAmount}</div>` : ''}
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;border-top:1px solid var(--border);padding-top:18px">
        <div>
          <div style="font-size:11.5px;color:var(--text-3);text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">${isTrial || data.subscriptionStatus === 'cancelled' ? 'Vence' : 'Próximo cobro'}</div>
          <div style="font-size:14px;color:var(--text-1);font-weight:600">${renewDate}</div>
          ${data.daysLeft ? `<div style="font-size:12px;color:var(--text-3);margin-top:2px">${data.daysLeft} ${data.daysLeft === 1 ? 'día' : 'días'} restantes</div>` : ''}
        </div>
        <div>
          <div style="font-size:11.5px;color:var(--text-3);text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">Procesador</div>
          <div style="font-size:14px;color:var(--text-1);font-weight:600">${escHtmlSafe(providerLabel)}</div>
        </div>
        ${isPaid ? `
        <div>
          <div style="font-size:11.5px;color:var(--text-3);text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">Garantía</div>
          <div style="font-size:14px;color:#16a34a;font-weight:600">7 días reembolso</div>
          <div style="font-size:12px;color:var(--text-3);margin-top:2px">Sin preguntas</div>
        </div>` : ''}
      </div>

      ${isTrial && data.daysLeft <= 1 ? `
        <div style="margin-top:16px;padding:14px 16px;background:linear-gradient(135deg,#fff7ed,#fef3c7);border:1px solid #fbbf24;border-radius:8px">
          <strong style="color:#92400e">⚡ Tu trial vence ${data.daysLeft === 0 ? 'hoy' : 'mañana'}.</strong>
          <span style="color:var(--text-2);font-size:13.5px"> Activá un plan para no perder acceso a tus leads y conversaciones.</span>
        </div>` : ''}

      ${data.subscriptionStatus === 'past_due' ? `
        <div style="margin-top:16px;padding:14px 16px;background:#fef2f2;border:1px solid #fecaca;border-radius:8px">
          <strong style="color:#991b1b">⚠️ El último pago no se procesó.</strong>
          <span style="color:var(--text-2);font-size:13.5px"> Actualizá tu método de pago en el botón de gestionar abajo.</span>
        </div>` : ''}

      ${data.subscriptionStatus === 'cancelled' ? `
        <div style="margin-top:16px;padding:14px 16px;background:#f9fafb;border:1px solid var(--border);border-radius:8px">
          <strong>Tu suscripción está cancelada.</strong>
          <span style="color:var(--text-2);font-size:13.5px"> Mantenés acceso hasta el ${renewDate}. Después de eso, tus datos quedan guardados 30 días por si querés reactivar.</span>
        </div>` : ''}
    `;

    actions.style.display = 'flex';

    // Mostrar botón gestionar solo si tiene proveedor configurado
    const portalBtn = document.getElementById('btn-billing-portal');
    if (portalBtn) {
      portalBtn.style.display = (data.provider === 'ls' || data.provider === 'mp') ? '' : 'none';
    }

    // Provider name en la card de info
    const providerNameEl = document.getElementById('billing-provider-name');
    if (providerNameEl) {
      providerNameEl.textContent = data.provider === 'ls' ? 'Lemon Squeezy' : data.provider === 'mp' ? 'Mercado Pago' : 'tu proveedor';
    }
  } catch (e) {
    card.innerHTML = `<div style="color:#ef4444;text-align:center;padding:30px">${escHtmlSafe(e.message)}</div>`;
  }
}

async function openBillingPortal() {
  try {
    const r = await apiFetch('/api/billing/portal');
    if (!r || !r.url) {
      showToast('No hay portal disponible. Contactanos en soporte@dmcloser.app');
      return;
    }
    window.open(r.url, '_blank');
  } catch (e) {
    showToast('❌ ' + e.message);
  }
}

window.loadBillingPage = loadBillingPage;
window.openBillingPortal = openBillingPortal;

// ── REFERIDOS ──────────────────────────────────────────────────────────────
let REFERRAL_DATA = null;

async function loadReferralsPage() {
  try {
    const me = await apiFetch('/api/referrals/me');
    if (!me) return;
    REFERRAL_DATA = me;

    document.getElementById('ref-link-text').textContent = me.inviteUrl;
    document.getElementById('ref-clicks').textContent       = me.stats.clicks || 0;
    document.getElementById('ref-registered').textContent   = me.stats.registered || 0;
    document.getElementById('ref-paid').textContent         = me.stats.paid || 0;
    document.getElementById('ref-credit-days').textContent  = (me.stats.creditDays || 0) + 'd';

    const shareText = encodeURIComponent(
      `Estoy usando DMCloser para que la IA me responda los DMs de Instagram y filtre los leads. Te dejo mi link con descuento: ${me.inviteUrl}`
    );
    const shareUrl = encodeURIComponent(me.inviteUrl);
    document.getElementById('ref-share-wa').href = `https://wa.me/?text=${shareText}`;
    document.getElementById('ref-share-tw').href = `https://twitter.com/intent/tweet?text=${shareText}`;
    document.getElementById('ref-share-tg').href = `https://t.me/share/url?url=${shareUrl}&text=${shareText}`;

    // Lista
    const list = await apiFetch('/api/referrals/list');
    const tbody = document.getElementById('ref-list-table');
    if (!list || !list.length) {
      tbody.innerHTML = `
        <div style="text-align:center;padding:30px;color:var(--text-3)">
          <div style="font-size:32px;margin-bottom:8px">🌱</div>
          <div style="font-size:13.5px">Aún no invitaste a nadie. Empezá compartiendo tu link arriba.</div>
        </div>`;
      return;
    }

    const stateBadge = (kind) => {
      if (kind === 'paid')       return '<span style="background:#dcfce7;color:#16a34a;padding:3px 10px;border-radius:14px;font-size:11.5px;font-weight:600">💰 Pagó</span>';
      if (kind === 'registered') return '<span style="background:#fef3c7;color:#d97706;padding:3px 10px;border-radius:14px;font-size:11.5px;font-weight:600">📝 Registrado</span>';
      return '<span style="background:#f3f4f6;color:#6b7280;padding:3px 10px;border-radius:14px;font-size:11.5px;font-weight:600">' + escHtmlSafe(kind) + '</span>';
    };

    tbody.innerHTML = `
      <table style="width:100%;border-collapse:collapse">
        <thead>
          <tr style="text-align:left;font-size:12px;color:var(--text-3);text-transform:uppercase;letter-spacing:.05em">
            <th style="padding:8px 10px;border-bottom:1px solid var(--border)">Quien</th>
            <th style="padding:8px 10px;border-bottom:1px solid var(--border)">Estado</th>
            <th style="padding:8px 10px;border-bottom:1px solid var(--border)">Plan</th>
            <th style="padding:8px 10px;border-bottom:1px solid var(--border)">Crédito</th>
            <th style="padding:8px 10px;border-bottom:1px solid var(--border)">Cuándo</th>
          </tr>
        </thead>
        <tbody>
          ${list.filter(r => r.kind !== 'click').map(r => `
            <tr>
              <td style="padding:10px;border-bottom:1px solid var(--border);font-size:13.5px">${escHtmlSafe(r.referred?.name || '—')}<div style="font-size:11px;color:var(--text-3)">${escHtmlSafe(r.referred?.email || '')}</div></td>
              <td style="padding:10px;border-bottom:1px solid var(--border)">${stateBadge(r.kind)}</td>
              <td style="padding:10px;border-bottom:1px solid var(--border);font-size:13px">${escHtmlSafe(r.referred?.plan || '—')}</td>
              <td style="padding:10px;border-bottom:1px solid var(--border);font-size:13px;color:${r.creditDays>0?'#16a34a':'var(--text-3)'};font-weight:${r.creditDays>0?'600':'400'}">${r.creditDays > 0 ? '+' + r.creditDays + ' días' : '—'}</td>
              <td style="padding:10px;border-bottom:1px solid var(--border);font-size:12px;color:var(--text-3)">${relTime(r.createdAt)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  } catch (e) {
    document.getElementById('ref-list-table').innerHTML = `<div style="color:#ef4444;padding:20px;text-align:center">${escHtmlSafe(e.message)}</div>`;
  }
}

function copyReferralLink() {
  if (!REFERRAL_DATA) return;
  navigator.clipboard.writeText(REFERRAL_DATA.inviteUrl).then(() => {
    showToast('✅ Link copiado al portapapeles');
  }).catch(() => {
    // Fallback: select text
    const text = document.getElementById('ref-link-text');
    if (text) {
      const r = document.createRange();
      r.selectNodeContents(text);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
      document.execCommand('copy');
      s.removeAllRanges();
      showToast('✅ Link copiado');
    }
  });
}

window.loadReferralsPage = loadReferralsPage;
window.copyReferralLink = copyReferralLink;

// ── QUICK REPLIES (plantillas) ─────────────────────────────────────────────
let QUICK_REPLIES = [];
let CURRENT_LEAD_FOR_TEMPLATES = null;

async function openQuickReplies() {
  CURRENT_LEAD_FOR_TEMPLATES = INBOX_SELECTED_ID;
  document.getElementById('qr-modal').style.display = 'flex';
  resetQuickReplyForm();
  await loadQuickReplies();
}

function closeQuickReplies() {
  document.getElementById('qr-modal').style.display = 'none';
}

async function loadQuickReplies() {
  try {
    const items = await apiFetch(`/api/quick-replies?accountId=${ACCOUNT_ID}`);
    QUICK_REPLIES = items || [];
    const list = document.getElementById('qr-list');
    if (!QUICK_REPLIES.length) {
      list.innerHTML = `
        <div style="text-align:center;padding:30px;color:var(--text-3);background:#f9fafb;border-radius:8px;border:1px dashed var(--border)">
          <div style="font-size:24px;margin-bottom:6px">📋</div>
          <div style="font-size:13px">Aún no creaste plantillas</div>
          <div style="font-size:12px;margin-top:4px">Empezá creando una abajo (ej: "info de envíos", "horario de atención", "link de pago")</div>
        </div>`;
      return;
    }
    list.innerHTML = QUICK_REPLIES.map(q => `
      <div style="display:flex;align-items:flex-start;gap:10px;padding:10px 12px;background:#f9fafb;border:1px solid var(--border);border-radius:8px;cursor:pointer;transition:background .12s" onmouseover="this.style.background='#fff7ed';this.style.borderColor='#fed7aa'" onmouseout="this.style.background='#f9fafb';this.style.borderColor='var(--border)'" onclick="insertQuickReply('${q.id}')">
        <div style="flex:1;min-width:0">
          <div style="font-size:13.5px;font-weight:600;color:var(--text-1);margin-bottom:2px">${escHtmlSafe(q.title)} ${q.uses ? `<small style="color:var(--text-3);font-weight:400">· ${q.uses} usos</small>` : ''}</div>
          <div style="font-size:12.5px;color:var(--text-2);line-height:1.4;white-space:pre-wrap;max-height:60px;overflow:hidden">${escHtmlSafe(q.content.slice(0, 200))}${q.content.length > 200 ? '…' : ''}</div>
        </div>
        <div style="display:flex;gap:4px;flex-shrink:0" onclick="event.stopPropagation()">
          <button onclick="editQuickReply('${q.id}')" style="background:transparent;border:1px solid var(--border);color:var(--text-2);padding:4px 8px;border-radius:5px;font-size:11px;cursor:pointer">✏️</button>
          <button onclick="deleteQuickReply('${q.id}')" style="background:transparent;border:1px solid var(--border);color:#dc2626;padding:4px 8px;border-radius:5px;font-size:11px;cursor:pointer">🗑️</button>
        </div>
      </div>
    `).join('');
  } catch (e) {
    document.getElementById('qr-list').innerHTML = `<div style="color:#ef4444;text-align:center;padding:20px">${escHtmlSafe(e.message)}</div>`;
  }
}

function applyTemplateVariables(text, lead) {
  if (!text) return '';
  const ig = lead?.ig_username || '';
  const firstName = ig.split(/[._-]/)[0] || ig;
  const agentName = lead?.agent_name || 'Mi Agente';
  return text
    .replace(/\{nombre\}/g, ig ? '@' + ig : '')
    .replace(/\{primernombre\}/g, firstName)
    .replace(/\{agente\}/g, agentName);
}

async function insertQuickReply(id) {
  const q = QUICK_REPLIES.find(x => x.id === id);
  if (!q) return;
  const input = document.getElementById('thread-input-text');
  if (!input) {
    showToast('Abrí una conversación primero');
    return;
  }
  // Buscar lead actual para reemplazar variables
  let lead = null;
  if (CURRENT_LEAD_FOR_TEMPLATES) {
    try {
      lead = await apiFetch(`/api/leads/${CURRENT_LEAD_FOR_TEMPLATES}`);
    } catch {}
  }
  const text = applyTemplateVariables(q.content, lead);
  // Insertar al final del textarea, sumando espacio si ya tiene texto
  input.value = input.value ? input.value.trimEnd() + ' ' + text : text;
  input.focus();
  // Setear cursor al final
  input.setSelectionRange(input.value.length, input.value.length);
  closeQuickReplies();
  // Incrementar contador (best-effort)
  apiFetch(`/api/quick-replies/${id}/used`, 'POST').catch(() => null);
}

function resetQuickReplyForm() {
  document.getElementById('qr-form-title').textContent = 'Nueva plantilla';
  document.getElementById('qr-id').value = '';
  document.getElementById('qr-title').value = '';
  document.getElementById('qr-content').value = '';
}

function editQuickReply(id) {
  const q = QUICK_REPLIES.find(x => x.id === id);
  if (!q) return;
  document.getElementById('qr-form-title').textContent = 'Editar plantilla';
  document.getElementById('qr-id').value = id;
  document.getElementById('qr-title').value = q.title;
  document.getElementById('qr-content').value = q.content;
  document.getElementById('qr-title').focus();
}

async function saveQuickReply() {
  const id = document.getElementById('qr-id').value;
  const title = document.getElementById('qr-title').value.trim();
  const content = document.getElementById('qr-content').value.trim();
  if (!title || !content) {
    showToast('Completá título y contenido');
    return;
  }
  try {
    if (id) {
      await apiFetch(`/api/quick-replies/${id}`, 'PATCH', { title, content });
    } else {
      await apiFetch('/api/quick-replies', 'POST', { accountId: ACCOUNT_ID, title, content });
    }
    resetQuickReplyForm();
    showToast('✅ Plantilla guardada');
    loadQuickReplies();
  } catch (e) { showToast('❌ ' + e.message); }
}

async function deleteQuickReply(id) {
  if (!confirm('¿Eliminar esta plantilla?')) return;
  try {
    await apiFetch(`/api/quick-replies/${id}`, 'DELETE');
    loadQuickReplies();
  } catch (e) { showToast('❌ ' + e.message); }
}

window.openQuickReplies = openQuickReplies;
window.closeQuickReplies = closeQuickReplies;
window.insertQuickReply = insertQuickReply;
window.resetQuickReplyForm = resetQuickReplyForm;
window.editQuickReply = editQuickReply;
window.saveQuickReply = saveQuickReply;
window.deleteQuickReply = deleteQuickReply;

// ── EXPORT EXPLÍCITO A window (defensa total) ──────────────────────────────
// Hay onclick="funcName(...)" inline en muchos lugares del HTML. Si por
// cualquier razón la función no quedó en el global scope (CSP, error de
// parsing previo, etc), el botón no responde. Este bloque las expone
// explícitamente y silencia cualquier ReferenceError de funciones que
// pudieron haber sido renombradas.
function _safeExpose(name, fn) {
  try { if (typeof fn === 'function') window[name] = fn; } catch {}
}
try { _safeExpose('logout', logout); } catch {}
try { _safeExpose('openLinkForm', openLinkForm); } catch {}
try { _safeExpose('saveLink', saveLink); } catch {}
try { _safeExpose('deleteLink', deleteLink); } catch {}
try { _safeExpose('deleteLinkInBuilder', deleteLinkInBuilder); } catch {}
try { _safeExpose('openKnowledgeModal', openKnowledgeModal); } catch {}
try { _safeExpose('saveKnowledge', saveKnowledge); } catch {}
try { _safeExpose('deleteKnowledge', deleteKnowledge); } catch {}
try { _safeExpose('toggleKcContent', toggleKcContent); } catch {}
try { _safeExpose('selectAgent', selectAgent); } catch {}
try { _safeExpose('createAgent', createAgent); } catch {}
try { _safeExpose('deleteAgent', deleteAgent); } catch {}
try { _safeExpose('switchAgentTab', switchAgentTab); } catch {}
try { _safeExpose('changeLeadAutomation', changeLeadAutomation); } catch {}
try { _safeExpose('changeLeadAgent', changeLeadAgent); } catch {}
try { _safeExpose('closeLeadDetail', closeLeadDetail); } catch {}
try { _safeExpose('bypassLead', bypassLead); } catch {}
try { _safeExpose('markConverted', markConverted); } catch {}
try { _safeExpose('sendManualMessage', sendManualMessage); } catch {}
try { _safeExpose('addBypassedUser', addBypassedUser); } catch {}
try { _safeExpose('removeBypassedUser', removeBypassedUser); } catch {}
try { _safeExpose('showUpgradeModal', showUpgradeModal); } catch {}
try { _safeExpose('switchProvider', switchProvider); } catch {}
try { _safeExpose('upgradePlan', upgradePlan); } catch {}
try { _safeExpose('switchTab', switchTab); } catch {}
try { _safeExpose('createMagnetLink', createMagnetLink); } catch {}
try { _safeExpose('showLeadDetail', showLeadDetail); } catch {}

// ── START ─────────────────────────────────────────────────────────────────────
init();
