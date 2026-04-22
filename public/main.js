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
    window.history.replaceState({}, '', '/');
    loadSection('settings');
  } else if (params.get('auth') === 'error') {
    showToast('❌ ' + decodeURIComponent(params.get('msg') || 'Error desconocido'));
    window.history.replaceState({}, '', '/');
  } else if (params.get('billing') === 'success') {
    const plan = params.get('plan') || 'plan';
    const provider = params.get('provider') || '';
    const planName = plan.charAt(0).toUpperCase() + plan.slice(1);
    const providerLabel = provider === 'ls' ? ' (Lemon Squeezy)' : provider === 'mp' ? ' (Mercado Pago)' : '';
    showToast(`🎉 ¡Suscripción activada! Bienvenido al plan ${planName}${providerLabel}`);
    window.history.replaceState({}, '', '/');
    loadBillingStatus();
  } else if (params.get('billing') === 'cancelled') {
    showToast('Pago cancelado. Tu prueba gratuita sigue activa.');
    window.history.replaceState({}, '', '/');
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
      <div id="auth-error" class="auth-error" style="display:none"></div>
      <button class="btn-primary auth-btn" id="auth-submit">Crear cuenta y comenzar →</button>
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
  const body = isRegisterMode ? { email, password, name } : { email, password };

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
    case 'leads':     loadLeads(); break;
    case 'links':     loadLinks(); break;
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
                ${[30,40,50,60,70,80].map(s => `<option value="${s}" ${(agentData.delay_min??30)===s?'selected':''}>${s}s</option>`).join('')}
              </select>
            </div>
            <div style="flex:1">
              <label style="font-size:0.72rem;color:#666;display:block;margin-bottom:4px">Máximo</label>
              <select id="agent-delay-max" style="width:100%;background:#1a1a2e;border:1px solid #3a3a5a;color:#e0e0e0;padding:7px 10px;border-radius:6px;font-size:0.85rem">
                ${[40,50,60,70,80,90].map(s => `<option value="${s}" ${(agentData.delay_max??90)===s?'selected':''}>${s}s</option>`).join('')}
              </select>
            </div>
          </div>
          <small style="color:#666;font-size:0.72rem;display:block;margin-top:6px">
            El bot espera un tiempo aleatorio entre estos valores antes de responder. Recomendado: 30-90s para evitar detección.
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
        <div class="kc-content" id="kc-${e.id}">${escHtml(e.content)}</div>
        <span class="kc-show-more" onclick="toggleKcContent('${e.id}')">▼ Ver más</span>
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
  el.classList.toggle('expanded');
}

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
  if (!confirm('¿Eliminar esta entrada de conocimiento?')) return;
  await apiFetch(`/api/knowledge/${id}`, 'DELETE');
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
  if (!confirm('¿Eliminar este link?')) return;
  await apiFetch(`/api/links/${id}`, 'DELETE');
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
    window.location.href = `/auth/instagram?accountId=${ACCOUNT_ID}`;
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
    toast.style.cssText = 'position:fixed;bottom:24px;right:24px;background:#111;color:white;padding:12px 20px;border-radius:8px;font-size:14px;z-index:9999;transition:opacity .3s';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.opacity = '1';
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.style.opacity = '0', 3000);
}

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

function escHtmlSafe(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Exponer delete para onclick inline
window.deleteMagnetLink = deleteMagnetLink;

// ── START ─────────────────────────────────────────────────────────────────────
init();
