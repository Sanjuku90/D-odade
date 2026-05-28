let currentUser = null;
let depositPollingInterval = null;
const lastDepositStatuses = new Map();

document.addEventListener('DOMContentLoaded', () => {
  checkAuth();
  setupEventListeners();
  setupLandingListeners();
});

function startDepositPolling() {
  stopDepositPolling();
  refreshLiveDeposits();
  depositPollingInterval = setInterval(refreshLiveDeposits, 10000);
}

function stopDepositPolling() {
  if (depositPollingInterval) {
    clearInterval(depositPollingInterval);
    depositPollingInterval = null;
  }
}

async function refreshLiveDeposits() {
  try {
    const res = await fetch('/api/deposits');
    if (!res.ok) return;
    const data = await res.json();
    const deposits = data.deposits || [];

    deposits.forEach(d => {
      const prev = lastDepositStatuses.get(d.tx_hash || d.created_at);
      if (prev && prev !== d.status) {
        if (d.status === 'confirmed') {
          showToast(`✅ Dépôt de $${parseFloat(d.amount).toFixed(2)} confirmé !`, 'success');
          loadUserData();
          loadQuests();
        } else if (d.status === 'rejected') {
          showToast(`❌ Dépôt de $${parseFloat(d.amount).toFixed(2)} rejeté.`, 'error');
        }
      }
      lastDepositStatuses.set(d.tx_hash || d.created_at, d.status);
    });

    renderLiveDeposits(deposits);
  } catch (err) {}
}

function renderLiveDeposits(deposits) {
  const container = document.getElementById('live-deposits-list');
  if (!container) return;

  if (!deposits || deposits.length === 0) {
    container.innerHTML = '<p class="empty-state">Aucun dépôt pour le moment</p>';
    return;
  }

  const statusConfig = {
    pending:   { label: 'En attente',  cls: 'status-pending'   },
    confirmed: { label: 'Confirmé',    cls: 'status-confirmed' },
    rejected:  { label: 'Rejeté',      cls: 'status-rejected'  }
  };

  container.innerHTML = deposits.slice(0, 10).map(d => {
    const cfg = statusConfig[d.status] || { label: d.status, cls: '' };
    const date = new Date(d.created_at).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const short = d.tx_hash ? d.tx_hash.substring(0, 16) + '…' : '—';
    return `
      <div class="live-deposit-item">
        <div class="ldi-left">
          <div class="ldi-amount">+$${parseFloat(d.amount).toFixed(2)}</div>
          <div class="ldi-hash" title="${d.tx_hash || ''}">${short}</div>
        </div>
        <div class="ldi-right">
          <span class="ldi-status ${cfg.cls}">${cfg.label}${d.status === 'pending' ? '<span class="spin-dot"></span>' : ''}</span>
          <div class="ldi-date">${date}</div>
        </div>
      </div>
    `;
  }).join('');
}

function setupLandingListeners() {
  const getStartedBtn = document.getElementById('get-started-btn');
  const learnMoreBtn = document.getElementById('learn-more-btn');
  const joinNowBtn = document.getElementById('join-now-btn');
  const signupCtaBtn = document.getElementById('signup-cta-btn');
  const backToLanding = document.getElementById('back-to-landing');

  if (getStartedBtn) {
    getStartedBtn.addEventListener('click', () => showAuth());
  }
  if (learnMoreBtn) {
    learnMoreBtn.addEventListener('click', () => {
      document.getElementById('features').scrollIntoView({ behavior: 'smooth' });
    });
  }
  if (joinNowBtn) {
    joinNowBtn.addEventListener('click', () => showAuth('register'));
  }
  if (signupCtaBtn) {
    signupCtaBtn.addEventListener('click', () => showAuth('register'));
  }
  if (backToLanding) {
    backToLanding.addEventListener('click', () => showLanding());
  }
}

function showLanding() {
  document.getElementById('landing-section').classList.remove('hidden');
  document.getElementById('auth-section').classList.add('hidden');
  document.getElementById('dashboard-section').classList.add('hidden');
  document.getElementById('nav-links').innerHTML = '<button onclick="showAuth()">Connexion</button>';
}

function setupEventListeners() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      
      if (tab === 'login') {
        document.getElementById('login-form').classList.remove('hidden');
        document.getElementById('register-form').classList.add('hidden');
      } else {
        document.getElementById('login-form').classList.add('hidden');
        document.getElementById('register-form').classList.remove('hidden');
      }
    });
  });

  document.querySelectorAll('.dash-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      document.querySelectorAll('.dash-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      
      document.querySelectorAll('.dashboard-view').forEach(v => v.classList.add('hidden'));
      const viewEl = document.getElementById(view + '-view');
      if (viewEl) viewEl.classList.remove('hidden');

      const overlay = document.getElementById('kyc-freeze-overlay');
      if (overlay) {
        if (view === 'kyc') {
          overlay.style.display = 'none';
        } else if (currentUser && currentUser.kyc_status !== 'confirmed') {
          overlay.style.display = 'flex';
        }
      }

      if (view === 'support') loadTickets();
      if (view === 'referral') loadReferrals();
    });
  });

  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const data = {
      email: formData.get('email'),
      password: formData.get('password')
    };

    const submitBtn = e.target.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Envoi du code…';
    document.getElementById('login-error').textContent = '';

    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });

      const result = await res.json();
      if (res.ok && result.requires2fa) {
        showTwoFA(result.maskedEmail);
      } else if (res.ok) {
        showDashboard();
      } else {
        document.getElementById('login-error').textContent = result.error;
      }
    } catch (err) {
      document.getElementById('login-error').textContent = 'Erreur de connexion';
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Se connecter';
    }
  });

  document.getElementById('twofa-submit-btn').addEventListener('click', async () => {
    const code = document.getElementById('twofa-code-input').value.trim();
    const errEl = document.getElementById('twofa-error');
    const btn = document.getElementById('twofa-submit-btn');

    errEl.textContent = '';
    if (!code || code.length !== 6) {
      errEl.textContent = 'Entrez le code à 6 chiffres reçu par email.';
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Vérification…';

    try {
      const res = await fetch('/api/verify-2fa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code })
      });
      const result = await res.json();
      if (res.ok) {
        showDashboard();
      } else {
        errEl.textContent = result.error;
      }
    } catch (err) {
      errEl.textContent = 'Erreur de vérification. Réessayez.';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Vérifier le code';
    }
  });

  document.getElementById('twofa-code-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('twofa-submit-btn').click();
  });

  document.getElementById('register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const data = {
      first_name: formData.get('first_name'),
      last_name: formData.get('last_name'),
      email: formData.get('email'),
      password: formData.get('password'),
      referral_code: formData.get('referral_code')
    };

    try {
      const res = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });

      const result = await res.json();
      if (res.ok) {
        showDashboard();
      } else {
        document.getElementById('register-error').textContent = result.error;
      }
    } catch (err) {
      document.getElementById('register-error').textContent = 'Erreur d\'inscription';
    }
  });

  document.getElementById('deposit-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const amount = formData.get('amount');
    const tx_hash = formData.get('tx_hash');

    document.getElementById('deposit-error').textContent = '';
    document.getElementById('deposit-success').textContent = '';

    try {
      const res = await fetch('/api/deposit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount, tx_hash })
      });

      const result = await res.json();
      if (res.ok) {
        document.getElementById('deposit-success').textContent = 'Transaction soumise! En attente de validation.';
        e.target.reset();
        loadHistory();
        showToast('Transaction soumise avec succes!', 'success');
        refreshLiveDeposits();
      } else {
        document.getElementById('deposit-error').textContent = result.error;
      }
    } catch (err) {
      document.getElementById('deposit-error').textContent = 'Erreur de soumission';
    }
  });

  document.getElementById('withdraw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const amount = formData.get('amount');
    const address = formData.get('address');

    document.getElementById('withdraw-error').textContent = '';
    document.getElementById('withdraw-success').textContent = '';

    try {
      const res = await fetch('/api/withdraw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount, address })
      });

      const result = await res.json();
      if (res.ok) {
        document.getElementById('withdraw-success').textContent = 'Retrait soumis! En attente de traitement.';
        e.target.reset();
        loadUserData();
        loadHistory();
        showToast('Demande de retrait soumise!', 'success');
      } else {
        document.getElementById('withdraw-error').textContent = result.error;
      }
    } catch (err) {
      document.getElementById('withdraw-error').textContent = 'Erreur de soumission';
    }
  });

  document.getElementById('change-email-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    
    document.getElementById('email-error').textContent = '';
    document.getElementById('email-success').textContent = '';

    try {
      const res = await fetch('/api/user/email', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          new_email: formData.get('new_email'),
          current_password: formData.get('current_password')
        })
      });

      const result = await res.json();
      if (res.ok) {
        document.getElementById('email-success').textContent = 'Email mis a jour!';
        e.target.reset();
        loadUserData();
        showToast('Email mis a jour!', 'success');
      } else {
        document.getElementById('email-error').textContent = result.error;
      }
    } catch (err) {
      document.getElementById('email-error').textContent = 'Erreur de mise a jour';
    }
  });

  document.getElementById('change-password-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    
    document.getElementById('password-error').textContent = '';
    document.getElementById('password-success').textContent = '';

    const newPassword = formData.get('new_password');
    const confirmPassword = formData.get('confirm_password');

    if (newPassword !== confirmPassword) {
      document.getElementById('password-error').textContent = 'Les mots de passe ne correspondent pas';
      return;
    }

    try {
      const res = await fetch('/api/user/password', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          current_password: formData.get('current_password'),
          new_password: newPassword
        })
      });

      const result = await res.json();
      if (res.ok) {
        document.getElementById('password-success').textContent = 'Mot de passe change!';
        e.target.reset();
        showToast('Mot de passe change!', 'success');
      } else {
        document.getElementById('password-error').textContent = result.error;
      }
    } catch (err) {
      document.getElementById('password-error').textContent = 'Erreur de mise a jour';
    }
  });
}

async function checkAuth() {
  const inMaintenance = await checkMaintenance();
  if (inMaintenance) return;
  try {
    const res = await fetch('/api/user');
    if (res.ok) {
      showDashboard();
    } else {
      showLanding();
    }
  } catch (err) {
    showLanding();
  }
}

function showAuth(tab = 'login') {
  document.getElementById('landing-section').classList.add('hidden');
  document.getElementById('auth-section').classList.remove('hidden');
  document.getElementById('dashboard-section').classList.add('hidden');
  document.getElementById('nav-links').innerHTML = '';
  
  if (tab === 'register') {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelector('.tab-btn[data-tab="register"]').classList.add('active');
    document.getElementById('login-form').classList.add('hidden');
    document.getElementById('register-form').classList.remove('hidden');
  }
}

function showTwoFA(maskedEmail) {
  document.querySelectorAll('.auth-tabs').forEach(el => el.classList.add('hidden'));
  document.getElementById('login-form').classList.add('hidden');
  document.getElementById('register-form').classList.add('hidden');
  document.getElementById('recovery-form-wrap').classList.add('hidden');
  document.getElementById('twofa-masked-email').textContent = maskedEmail || '';
  document.getElementById('twofa-code-input').value = '';
  document.getElementById('twofa-error').textContent = '';
  document.getElementById('twofa-form-wrap').classList.remove('hidden');
  setTimeout(() => document.getElementById('twofa-code-input').focus(), 100);
}

function cancelTwoFA() {
  document.getElementById('twofa-form-wrap').classList.add('hidden');
  document.querySelectorAll('.auth-tabs').forEach(el => el.classList.remove('hidden'));
  document.getElementById('login-form').classList.remove('hidden');
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('.tab-btn[data-tab="login"]').classList.add('active');
}

function applyKycFreeze(kycStatus) {
  const overlay = document.getElementById('kyc-freeze-overlay');
  const statusEl = document.getElementById('kyc-freeze-status');
  if (!overlay) return;
  if (kycStatus === 'confirmed') {
    overlay.classList.add('hidden');
    overlay.style.display = 'none';
  } else {
    overlay.classList.remove('hidden');
    overlay.style.display = 'flex';
    if (kycStatus === 'pending') {
      statusEl.textContent = '⏳ Votre KYC est en cours de vérification par notre équipe.';
      statusEl.style.color = '#fbbf24';
    } else if (kycStatus === 'rejected') {
      statusEl.textContent = '❌ Votre KYC a été refusé. Soumettez à nouveau vos documents.';
      statusEl.style.color = '#f87171';
    } else {
      statusEl.textContent = 'Aucun KYC soumis — cliquez ci-dessus pour commencer.';
      statusEl.style.color = '#64748b';
    }
  }
}

function showDashboard() {
  document.getElementById('landing-section').classList.add('hidden');
  document.getElementById('auth-section').classList.add('hidden');
  document.getElementById('dashboard-section').classList.remove('hidden');
  document.getElementById('nav-links').innerHTML = '<button onclick="logout()">Deconnexion</button>';
  
  loadUserData();
  loadQuests();
  loadHistory();
  loadKyc();
  loadNewsFeed();
  loadPublicTestimonials();
  initStarRating();
  startDepositPolling();
  loadTickets();
  loadReferrals();

  // Afficher le widget chat pour les utilisateurs connectés
  const widget = document.getElementById('chat-widget');
  if (widget) widget.style.display = 'block';

  // Listener ticket form
  const tf = document.getElementById('ticket-form');
  if (tf && !tf.dataset.bound) { tf.dataset.bound = '1'; tf.addEventListener('submit', submitTicket); }
}

async function loadUserData() {
  try {
    const res = await fetch('/api/user');
    if (res.ok) {
      const user = await res.json();
      currentUser = user;
      document.getElementById('user-balance').textContent = parseFloat(user.balance).toFixed(2);
      const withdrawnEl = document.getElementById('user-withdrawn');
      if (withdrawnEl) withdrawnEl.textContent = parseFloat(user.total_withdrawn || 0).toFixed(2);

      document.getElementById('deposit-address').textContent = user.deposit_address;
      
      document.getElementById('profile-email').textContent = user.email;
      document.getElementById('profile-initial').textContent = user.email.charAt(0).toUpperCase();
      
      if (user.created_at) {
        document.getElementById('profile-date').textContent = new Date(user.created_at).toLocaleDateString('fr-FR');
      }

      const activeTab = document.querySelector('.dash-tab.active');
      const isOnKycTab = activeTab && activeTab.dataset.view === 'kyc';
      if (!isOnKycTab) applyKycFreeze(user.kyc_status);
    }
  } catch (err) {
    console.error('Error loading user data');
  }
}

async function loadQuests() {
  try {
    const res = await fetch('/api/quests');
    if (res.ok) {
      const data = await res.json();
      const completedCount = data.completedThisPeriod ?? data.completedToday;
      const totalQuests = data.totalQuests || data.quests.length || 3;

      const completedEl = document.getElementById('quests-completed');
      if (completedEl) {
        completedEl.textContent = completedCount;
        const heroTotal = completedEl.parentElement && completedEl.parentElement.querySelector('.muted-num');
        if (heroTotal) heroTotal.textContent = '/' + totalQuests;
      }

      const questsCompleted2 = document.getElementById('quests-completed-2');
      if (questsCompleted2) {
        questsCompleted2.textContent = completedCount;
        const total2 = questsCompleted2.parentElement && questsCompleted2.parentElement.querySelector('.muted-num');
        if (total2) total2.textContent = '/' + totalQuests;
      }

      const resetDate = document.getElementById('quests-reset-date');
      if (resetDate && data.resetPeriodEnd) {
        resetDate.textContent = new Date(data.resetPeriodEnd).toLocaleDateString('fr-FR');
      }

      const newcomerBanner = document.getElementById('newcomer-banner');
      if (newcomerBanner) {
        if (data.isNewUser) {
          const endDate = data.newUserPeriodEnd ? new Date(data.newUserPeriodEnd).toLocaleDateString('fr-FR') : '';
          newcomerBanner.innerHTML = `
            <div class="newcomer-banner-inner">
              <span class="newcomer-badge">Bienvenue</span>
              <p>Pendant vos 2 premières semaines, profitez de <strong>4 quêtes spéciales à 20%</strong> chacune (total <strong>+80%</strong>). Période valable jusqu'au <strong>${endDate}</strong>.</p>
            </div>
          `;
          newcomerBanner.style.display = 'block';
        } else {
          newcomerBanner.style.display = 'none';
        }
      }

      const progressFill = document.getElementById('quests-progress-fill');
      if (progressFill) {
        const pct = totalQuests > 0 ? (completedCount / totalQuests) * 100 : 0;
        progressFill.style.width = pct + '%';
      }

      const questsListFull = document.getElementById('quests-list');
      questsListFull.innerHTML = data.quests.map(quest => `
        <div class="quest-card ${quest.completed ? 'completed' : ''}">
          <div class="quest-header">
            <span class="quest-badge">${quest.completed ? 'Terminee' : 'Disponible'}</span>
            <span class="quest-reward-badge">+${quest.reward_percentage}%</span>
          </div>
          <h4>${quest.title}</h4>
          <p>${quest.description}</p>
          <button class="btn btn-quest" 
            onclick="completeQuest(${quest.id})" 
            ${quest.completed ? 'disabled' : ''}>
            ${quest.completed ? 'Completee' : 'Completer la quete'}
          </button>
        </div>
      `).join('');
      
      const quickQuests = document.getElementById('quick-quests');
      if (quickQuests) {
        quickQuests.innerHTML = data.quests.slice(0, 2).map(quest => `
          <div class="quest-item ${quest.completed ? 'completed' : ''}">
            <div class="quest-info">
              <h4>${quest.title}</h4>
              <p>${quest.description}</p>
            </div>
            <button class="btn btn-quest" 
              onclick="completeQuest(${quest.id})" 
              ${quest.completed ? 'disabled' : ''}>
              ${quest.completed ? 'Fait' : '+${quest.reward_percentage}%'}
            </button>
          </div>
        `).join('');
      }
    }
  } catch (err) {
    console.error('Error loading quests');
  }
}

async function completeQuest(questId) {
  try {
    const res = await fetch(`/api/quests/${questId}/complete`, {
      method: 'POST'
    });

    const result = await res.json();
    if (res.ok) {
      showToast(`Quete completee! +$${parseFloat(result.reward).toFixed(2)}`, 'success');
      loadUserData();
      loadQuests();
      loadHistory();
    } else {
      showToast(result.error, 'error');
    }
  } catch (err) {
    showToast('Erreur lors de la completion de la quete', 'error');
  }
}

async function loadHistory() {
  try {
    const res = await fetch('/api/history');
    if (res.ok) {
      const data = await res.json();
      const historyList = document.getElementById('history-list');
      
      const statusLabels = {
        'pending': 'En attente',
        'confirmed': 'Confirme',
        'rejected': 'Rejete'
      };
      
      const allHistory = [
        ...data.deposits.map(d => ({
          type: 'Depot - ' + (statusLabels[d.status] || d.status),
          amount: '+$' + parseFloat(d.amount).toFixed(2),
          date: new Date(d.created_at).toLocaleDateString('fr-FR'),
          positive: d.status === 'confirmed',
          pending: d.status === 'pending'
        })),
        ...data.withdrawals.map(w => ({
          type: 'Retrait - ' + (statusLabels[w.status] || w.status),
          amount: '-$' + parseFloat(w.amount).toFixed(2),
          date: new Date(w.created_at).toLocaleDateString('fr-FR'),
          positive: false,
          pending: w.status === 'pending'
        })),
        ...data.questRewards.map(q => ({
          type: q.title,
          amount: '+$' + parseFloat(q.reward_earned).toFixed(2),
          date: new Date(q.completed_date).toLocaleDateString('fr-FR'),
          positive: true
        })),
        ...(data.referralBonuses || []).map(b => ({
          type: '🎁 Bonus parrainage',
          amount: '+$' + parseFloat(b.bonus_amount).toFixed(2),
          date: new Date(b.created_at).toLocaleDateString('fr-FR'),
          positive: true
        }))
      ];

      if (allHistory.length === 0) {
        historyList.innerHTML = '<p class="empty-state">Aucun historique pour le moment</p>';
      } else {
        historyList.innerHTML = allHistory.slice(0, 5).map(item => `
          <div class="history-item">
            <div>
              <span class="type">${item.type}</span>
              <span class="date">${item.date}</span>
            </div>
            <span class="amount ${item.positive ? 'positive' : ''} ${item.pending ? 'pending' : ''}">${item.amount}</span>
          </div>
        `).join('');
      }
    }
  } catch (err) {
    console.error('Error loading history');
  }
}

async function logout() {
  try {
    stopDepositPolling();
    lastDepositStatuses.clear();
    await fetch('/api/logout', { method: 'POST' });
    showAuth();
  } catch (err) {
    console.error('Error logging out');
  }
}

let kycFrontBase64 = null;
let kycBackBase64 = null;

function handleKycFile(side, input) {
  const file = input.files[0];
  if (!file) return;

  const maxSize = 6 * 1024 * 1024;
  if (file.size > maxSize) {
    showToast('Fichier trop volumineux (max 6 Mo)', 'error');
    input.value = '';
    return;
  }

  const reader = new FileReader();
  reader.onload = (e) => {
    const base64 = e.target.result;
    const labelId = side === 'front' ? 'kyc-front-label' : 'kyc-back-label';
    const previewId = side === 'front' ? 'kyc-front-preview' : 'kyc-back-preview';
    const zoneId = side === 'front' ? 'kyc-front-zone' : 'kyc-back-zone';

    document.getElementById(labelId).textContent = file.name;
    document.getElementById(zoneId).style.borderColor = 'rgba(167,139,250,0.6)';

    if (file.type.startsWith('image/')) {
      const preview = document.getElementById(previewId);
      preview.src = base64;
      preview.style.display = 'block';
    }

    if (side === 'front') kycFrontBase64 = base64;
    else kycBackBase64 = base64;
  };
  reader.readAsDataURL(file);
}

async function loadKyc() {
  try {
    const res = await fetch('/api/kyc');
    if (!res.ok) return;
    const data = await res.json();
    renderKycStatus(data.kyc);
  } catch (err) {}
}

function renderKycStatus(kyc) {
  const banner = document.getElementById('kyc-status-banner');
  const formCard = document.getElementById('kyc-form-card');

  if (!kyc) {
    banner.className = 'hidden';
    formCard.style.display = '';
    return;
  }

  banner.classList.remove('hidden');

  if (kyc.status === 'confirmed') {
    banner.style.cssText = 'margin-bottom:20px;padding:16px 20px;border-radius:12px;border:1px solid rgba(34,211,168,.3);background:rgba(34,211,168,.08);color:#22d3a8;font-size:.875rem;line-height:1.5;';
    banner.innerHTML = '<strong>✅ KYC Vérifié</strong><br>Votre identité a été confirmée avec succès. Votre compte est pleinement vérifié.';
    formCard.style.display = 'none';
  } else if (kyc.status === 'pending') {
    banner.style.cssText = 'margin-bottom:20px;padding:16px 20px;border-radius:12px;border:1px solid rgba(251,191,36,.3);background:rgba(251,191,36,.08);color:#fbbf24;font-size:.875rem;line-height:1.5;';
    banner.innerHTML = '<strong>⏳ Vérification en cours</strong><br>Vos documents ont été soumis et sont en cours d\'examen. Vous serez notifié dès la validation.';
    formCard.style.display = 'none';
  } else if (kyc.status === 'rejected') {
    banner.style.cssText = 'margin-bottom:20px;padding:16px 20px;border-radius:12px;border:1px solid rgba(248,113,113,.3);background:rgba(248,113,113,.08);color:#f87171;font-size:.875rem;line-height:1.5;';
    const reason = kyc.reject_reason ? `<br><em>Motif : ${kyc.reject_reason}</em>` : '';
    banner.innerHTML = `<strong>❌ Documents refusés</strong>${reason}<br>Veuillez soumettre de nouveaux documents valides.`;
    formCard.style.display = '';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const kycForm = document.getElementById('kyc-form');
  if (kycForm) {
    kycForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = document.getElementById('kyc-error');
      const okEl = document.getElementById('kyc-success');
      const btn = document.getElementById('kyc-submit-btn');
      errEl.textContent = '';
      okEl.textContent = '';

      if (!kycFrontBase64) {
        errEl.textContent = 'Veuillez sélectionner le recto de votre pièce d\'identité.';
        return;
      }

      btn.disabled = true;
      btn.textContent = 'Envoi en cours…';

      try {
        const res = await fetch('/api/kyc', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ document_front: kycFrontBase64, document_back: kycBackBase64 })
        });
        const result = await res.json();
        if (res.ok) {
          okEl.textContent = 'Documents soumis avec succès ! En attente de vérification.';
          showToast('Documents KYC soumis !', 'success');
          kycFrontBase64 = null;
          kycBackBase64 = null;
          kycForm.reset();
          ['kyc-front-preview', 'kyc-back-preview'].forEach(id => { document.getElementById(id).style.display = 'none'; });
          loadKyc();
        } else {
          errEl.textContent = result.error;
        }
      } catch (err) {
        errEl.textContent = 'Erreur lors de l\'envoi';
      } finally {
        btn.disabled = false;
        btn.textContent = 'Envoyer pour vérification';
      }
    });
  }
});


function showRecovery() {
  document.getElementById('landing-section').classList.add('hidden');
  document.getElementById('auth-section').classList.remove('hidden');
  document.getElementById('dashboard-section').classList.add('hidden');
  document.getElementById('nav-links').innerHTML = '';
  document.getElementById('auth-tabs-wrap') && (document.getElementById('auth-tabs-wrap').classList.add('hidden'));
  document.querySelectorAll('.auth-tabs').forEach(el => el.classList.add('hidden'));
  document.getElementById('login-form').classList.add('hidden');
  document.getElementById('register-form').classList.add('hidden');
  document.getElementById('recovery-form-wrap').classList.remove('hidden');
}

function hideRecovery() {
  document.querySelectorAll('.auth-tabs').forEach(el => el.classList.remove('hidden'));
  document.getElementById('login-form').classList.remove('hidden');
  document.getElementById('register-form').classList.add('hidden');
  document.getElementById('recovery-form-wrap').classList.add('hidden');
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('.tab-btn[data-tab="login"]').classList.add('active');
}


async function checkRecoveryStatus() {
  const email = document.getElementById('rec-status-email').value.trim();
  const resultEl = document.getElementById('rec-status-result');
  if (!email) { resultEl.style.color = '#f87171'; resultEl.textContent = 'Veuillez entrer votre email.'; return; }
  try {
    const res = await fetch('/api/recovery/status?email=' + encodeURIComponent(email));
    const data = await res.json();
    if (!data.request) {
      resultEl.style.color = '#64748b';
      resultEl.textContent = 'Aucune demande trouvée pour cet email.';
    } else {
      const s = data.request.status;
      const labels = { pending: '⏳ En cours de vérification', approved: '✅ Approuvée — vous pouvez vous connecter avec votre ancien mot de passe', rejected: '❌ Refusée' };
      resultEl.style.color = s === 'approved' ? '#34d399' : s === 'rejected' ? '#f87171' : '#fbbf24';
      resultEl.textContent = labels[s] || s;
      if (s === 'rejected' && data.request.reject_reason) {
        resultEl.textContent += ' — ' + data.request.reject_reason;
      }
    }
  } catch { resultEl.style.color = '#f87171'; resultEl.textContent = 'Erreur de connexion.'; }
}

document.addEventListener('DOMContentLoaded', () => {
  const recoveryForm = document.getElementById('recovery-form');
  if (recoveryForm) {
    recoveryForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = document.getElementById('recovery-error');
      const okEl = document.getElementById('recovery-success');
      const btn = document.getElementById('recovery-submit-btn');
      errEl.textContent = '';
      okEl.style.display = 'none';

      const formData = new FormData(recoveryForm);
      btn.disabled = true;
      btn.textContent = 'Envoi en cours…';

      try {
        const res = await fetch('/api/recovery', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            first_name: formData.get('first_name'),
            last_name: formData.get('last_name'),
            email: formData.get('email'),
            old_password: formData.get('old_password')
          })
        });
        const result = await res.json();
        if (res.ok) {
          okEl.textContent = result.message;
          okEl.style.display = 'block';
          recoveryForm.reset();
        } else {
          errEl.textContent = result.error;
        }
      } catch {
        errEl.textContent = 'Erreur lors de l\'envoi. Veuillez réessayer.';
      } finally {
        btn.disabled = false;
        btn.textContent = 'Envoyer ma demande de récupération';
      }
    });
  }
});

// ── MAINTENANCE CHECK ────────────────────────────────────────────────────────
async function checkMaintenance() {
  try {
    const r = await fetch('/api/maintenance');
    const j = await r.json();
    const overlay = document.getElementById('maintenance-overlay');
    if (overlay) overlay.style.display = j.maintenance ? 'flex' : 'none';
    return j.maintenance;
  } catch { return false; }
}

// ── NEWS FEED ────────────────────────────────────────────────────────────────
async function loadNewsFeed() {
  try {
    const r = await fetch('/api/news');
    if (!r.ok) return;
    const posts = await r.json();
    const card = document.getElementById('news-feed-card');
    const list = document.getElementById('news-feed-list');
    if (!card || !list) return;
    if (!posts.length) { card.style.display = 'none'; return; }
    card.style.display = '';
    list.innerHTML = posts.map(p => `
      <div style="border-bottom:1px solid rgba(255,255,255,.06);padding-bottom:14px;">
        <div style="font-size:.75rem;color:#6b7280;margin-bottom:4px;">${new Date(p.created_at).toLocaleDateString('fr-FR')}</div>
        <div style="font-weight:700;color:#f0f0fa;margin-bottom:6px;font-size:.95rem;">${p.title}</div>
        <div style="font-size:.85rem;color:#9898b8;line-height:1.6;">${p.content.replace(/\n/g,'<br>')}</div>
      </div>`).join('');
  } catch {}
}

// ── TÉMOIGNAGES ──────────────────────────────────────────────────────────────
let _testiRating = 5;

function initStarRating() {
  const stars = document.querySelectorAll('#star-rating span');
  if (!stars.length) return;
  function setRating(n) {
    _testiRating = n;
    document.getElementById('testi-rating').value = n;
    stars.forEach((s, i) => s.textContent = i < n ? '★' : '☆');
    stars.forEach(s => s.style.color = '#fbbf24');
  }
  setRating(5);
  stars.forEach(s => {
    s.addEventListener('click', () => setRating(parseInt(s.dataset.v)));
    s.addEventListener('mouseover', () => stars.forEach((x, i) => { x.textContent = i < parseInt(s.dataset.v) ? '★' : '☆'; }));
    s.addEventListener('mouseout', () => setRating(_testiRating));
  });
}

async function loadPublicTestimonials() {
  try {
    const r = await fetch('/api/testimonials');
    if (!r.ok) return;
    const list = await r.json();
    const el = document.getElementById('public-testi-list');
    if (!el) return;
    if (!list.length) { el.innerHTML = '<p class="empty-state">Aucun avis pour le moment. Soyez le premier !</p>'; return; }
    const stars = n => '★'.repeat(n) + '☆'.repeat(5 - n);
    el.innerHTML = list.map(t => `
      <div style="border-bottom:1px solid rgba(255,255,255,.06);padding-bottom:16px;">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
          <span style="font-size:1.1rem;color:#fbbf24;">${stars(t.rating)}</span>
          <span style="font-size:.75rem;color:#6b7280;">${t.email.replace(/(.{2}).+(@.+)/, '$1***$2')} · ${new Date(t.submitted_at).toLocaleDateString('fr-FR')}</span>
        </div>
        <p style="font-size:.88rem;color:#d1d5db;line-height:1.7;margin:0;">${t.content}</p>
      </div>`).join('');
  } catch {}
}

async function submitTestimonial() {
  const content = document.getElementById('testi-content').value.trim();
  const rating  = parseInt(document.getElementById('testi-rating').value) || 5;
  const errEl   = document.getElementById('testi-error');
  const okEl    = document.getElementById('testi-success');
  const btn     = document.getElementById('testi-submit-btn');
  errEl.textContent = ''; okEl.textContent = '';
  if (content.length < 10) { errEl.textContent = 'Votre avis doit faire au moins 10 caractères.'; return; }
  btn.disabled = true; btn.textContent = 'Envoi…';
  try {
    const r = await fetch('/api/testimonials', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, rating })
    });
    const j = await r.json();
    if (r.ok) {
      okEl.textContent = '✓ Merci ! Votre avis sera affiché après modération.';
      document.getElementById('testi-content').value = '';
      loadPublicTestimonials();
    } else { errEl.textContent = j.error || 'Erreur'; }
  } catch (e) { errEl.textContent = 'Erreur réseau'; }
  finally { btn.disabled = false; btn.textContent = 'Soumettre mon avis'; }
}

function copyToClipboard(text, successMsg) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      showToast(successMsg || 'Copié !', 'success');
    }).catch(() => {
      _clipboardFallback(text, successMsg);
    });
  } else {
    _clipboardFallback(text, successMsg);
  }
}

function _clipboardFallback(text, successMsg) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showToast(successMsg || 'Copié !', 'success');
  } catch {
    showToast('Impossible de copier — copiez manuellement.', 'error');
  }
}

function copyAddress() {
  const address = document.getElementById('deposit-address').textContent;
  copyToClipboard(address, 'Adresse copiée !');
}

function showToast(message, type) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = 'toast ' + type;
  toast.classList.remove('hidden');
  
  setTimeout(() => {
    toast.classList.add('hidden');
  }, 3000);
}

// ── PARRAINAGE ────────────────────────────────────────────────────────────────

async function loadReferrals() {
  try {
    const r = await fetch('/api/referrals');
    if (!r.ok) return;
    const data = await r.json();
    const code = data.referral_code || '';
    const link = `${location.origin}/?ref=${code}`;
    const inp = document.getElementById('referral-link-input');
    const codeEl = document.getElementById('referral-code-display');
    const countEl = document.getElementById('referral-count');
    const listEl = document.getElementById('referral-list');
    if (inp) inp.value = link;
    if (codeEl) codeEl.textContent = code || '—';
    const referrals = data.referrals || [];
    const totalBonus = data.total_bonus || 0;
    if (countEl) countEl.textContent = `${referrals.length} filleul(s)`;

    // Afficher le total des bonus gagnés
    const bonusTotalEl = document.getElementById('referral-bonus-total');
    if (bonusTotalEl) {
      bonusTotalEl.textContent = totalBonus > 0 ? `+$${totalBonus.toFixed(2)} gagnés` : '—';
      bonusTotalEl.style.color = totalBonus > 0 ? '#a78bfa' : '#6b7280';
    }

    if (!listEl) return;
    if (!referrals.length) {
      listEl.innerHTML = '<p class="empty-state" style="padding:20px;">Aucun filleul pour le moment. Partagez votre lien !</p>';
      return;
    }
    listEl.innerHTML = `<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;">
      <thead><tr style="border-bottom:1px solid rgba(255,255,255,.06);">
        <th style="text-align:left;padding:10px 20px;font-size:.75rem;color:#6b7280;font-weight:600;">Email</th>
        <th style="text-align:left;padding:10px 20px;font-size:.75rem;color:#6b7280;font-weight:600;">1er dépôt</th>
        <th style="text-align:left;padding:10px 20px;font-size:.75rem;color:#6b7280;font-weight:600;">Bonus reçu</th>
        <th style="text-align:left;padding:10px 20px;font-size:.75rem;color:#6b7280;font-weight:600;">Date</th>
      </tr></thead>
      <tbody>${referrals.map(u => {
        const hasPaid = u.bonus_paid;
        const bonusAmt = hasPaid ? `<span style="color:#a78bfa;font-weight:600;">+$${parseFloat(u.bonus_amount).toFixed(2)}</span>` : `<span style="color:#6b7280;font-size:.75rem;">En attente</span>`;
        return `<tr style="border-bottom:1px solid rgba(255,255,255,.04);">
          <td style="padding:10px 20px;font-size:.83rem;color:#d1d5db;">${u.email.replace(/(.{2}).+(@.+)/, '$1***$2')}</td>
          <td style="padding:10px 20px;font-size:.83rem;color:${u.deposit_amount > 0 ? '#34d399' : '#6b7280'};">${u.deposit_amount > 0 ? '$' + parseFloat(u.deposit_amount).toFixed(2) : '—'}</td>
          <td style="padding:10px 20px;">${bonusAmt}</td>
          <td style="padding:10px 20px;font-size:.8rem;color:#6b7280;">${new Date(u.created_at).toLocaleDateString('fr-FR')}</td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>`;
  } catch {}
}

function copyReferralLink() {
  const inp = document.getElementById('referral-link-input');
  if (!inp) return;
  copyToClipboard(inp.value, 'Lien copié !');
}

// ── SUPPORT TICKETS ───────────────────────────────────────────────────────────

async function loadTickets() {
  try {
    const r = await fetch('/api/tickets');
    if (!r.ok) return;
    const tickets = await r.json();
    const listEl = document.getElementById('tickets-list');
    if (!listEl) return;

    // Badge notification — tickets avec réponse admin non lus
    const unanswered = tickets.filter(t => t.status === 'answered').length;
    const badge = document.getElementById('support-badge');
    if (badge) {
      badge.textContent = unanswered;
      badge.style.display = unanswered > 0 ? 'inline' : 'none';
    }

    if (!tickets.length) {
      listEl.innerHTML = '<p class="empty-state" style="padding:20px;">Aucun ticket pour le moment.</p>';
      return;
    }
    listEl.innerHTML = tickets.map(t => {
      const statusColor = t.status === 'answered' ? '#34d399' : t.status === 'closed' ? '#6b7280' : '#fbbf24';
      const statusLabel = { open: 'Ouvert', answered: 'Répondu', closed: 'Fermé' }[t.status] || t.status;
      const replies = (t.replies || []).map(rep => `
        <div style="display:flex;flex-direction:column;align-items:${rep.sender === 'admin' ? 'flex-start' : 'flex-end'};margin-top:8px;">
          <div style="max-width:80%;background:${rep.sender === 'admin' ? 'rgba(167,139,250,.1)' : 'rgba(52,211,153,.08)'};border:1px solid ${rep.sender === 'admin' ? 'rgba(167,139,250,.15)' : 'rgba(52,211,153,.15)'};border-radius:${rep.sender === 'admin' ? '10px 10px 10px 2px' : '10px 10px 2px 10px'};padding:8px 12px;font-size:.8rem;color:#d1d5db;line-height:1.5;">
            <span style="font-size:.7rem;font-weight:600;color:${rep.sender === 'admin' ? '#a78bfa' : '#34d399'};display:block;margin-bottom:3px;">${rep.sender === 'admin' ? '🎧 Support' : '👤 Vous'}</span>
            ${rep.message}
          </div>
          <span style="font-size:.67rem;color:#6b7280;margin-top:3px;">${new Date(rep.created_at).toLocaleString('fr-FR',{hour:'2-digit',minute:'2-digit',day:'2-digit',month:'2-digit'})}</span>
        </div>`).join('');

      return `<div style="padding:18px 20px;border-bottom:1px solid rgba(255,255,255,.05);">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:10px;">
          <div>
            <div style="font-size:.88rem;font-weight:600;color:#f0f0fa;margin-bottom:4px;">${t.subject}</div>
            <div style="font-size:.78rem;color:#6b7280;">${new Date(t.created_at).toLocaleDateString('fr-FR')}</div>
          </div>
          <span style="font-size:.7rem;font-weight:700;padding:3px 9px;border-radius:10px;background:rgba(255,255,255,.05);color:${statusColor};white-space:nowrap;">${statusLabel}</span>
        </div>
        <div style="font-size:.82rem;color:#9ca3af;line-height:1.6;margin-bottom:${t.replies && t.replies.length ? '10px' : '0'};">${t.message}</div>
        ${replies}
        ${t.status !== 'closed' ? `
        <div style="display:flex;gap:8px;margin-top:12px;">
          <textarea id="reply-${t.id}" placeholder="Votre réponse…" rows="2" style="flex:1;background:#16162a;border:1px solid rgba(255,255,255,.08);border-radius:8px;padding:8px 12px;color:#f0f0fa;font-family:inherit;font-size:.8rem;resize:vertical;outline:none;"></textarea>
          <button onclick="replyTicket(${t.id})" style="background:linear-gradient(135deg,#7c3aed,#a78bfa);border:none;border-radius:8px;color:#fff;padding:0 14px;cursor:pointer;font-size:.8rem;font-weight:600;white-space:nowrap;">Envoyer</button>
        </div>` : ''}
      </div>`;
    }).join('');
  } catch {}
}

async function submitTicket(e) {
  e.preventDefault();
  const subject = document.getElementById('ticket-subject').value.trim();
  const message = document.getElementById('ticket-message').value.trim();
  const btn = document.getElementById('ticket-submit-btn');
  const errEl = document.getElementById('ticket-error');
  const okEl = document.getElementById('ticket-success');
  errEl.textContent = ''; okEl.textContent = '';
  if (!subject || !message) { errEl.textContent = 'Veuillez remplir tous les champs.'; return; }
  btn.disabled = true; btn.textContent = 'Envoi…';
  try {
    const r = await fetch('/api/tickets', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject, message })
    });
    const j = await r.json();
    if (r.ok) {
      okEl.textContent = '✓ Ticket envoyé ! Notre équipe vous répondra sous 24h.';
      document.getElementById('ticket-subject').value = '';
      document.getElementById('ticket-message').value = '';
      await loadTickets();
    } else { errEl.textContent = j.error || 'Erreur'; }
  } catch { errEl.textContent = 'Erreur réseau'; }
  finally { btn.disabled = false; btn.textContent = 'Envoyer le ticket'; }
}

async function replyTicket(ticketId) {
  const ta = document.getElementById(`reply-${ticketId}`);
  if (!ta || !ta.value.trim()) return;
  try {
    const r = await fetch(`/api/tickets/${ticketId}/reply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: ta.value.trim() })
    });
    if (r.ok) { await loadTickets(); showToast('Réponse envoyée', 'success'); }
    else { showToast('Erreur lors de l\'envoi', 'error'); }
  } catch { showToast('Erreur réseau', 'error'); }
}

// ── CHAT WIDGET ───────────────────────────────────────────────────────────────

let chatOpen = false;
let chatSubject = 'Chat rapide';

function toggleChat() {
  chatOpen = !chatOpen;
  const panel = document.getElementById('chat-panel');
  const iconOpen = document.getElementById('chat-icon-open');
  const iconClose = document.getElementById('chat-icon-close');
  const dot = document.getElementById('chat-notif-dot');
  panel.style.display = chatOpen ? 'flex' : 'none';
  iconOpen.style.display = chatOpen ? 'none' : 'block';
  iconClose.style.display = chatOpen ? 'block' : 'none';
  if (chatOpen && dot) dot.style.display = 'none';
}

async function sendChatMessage() {
  const input = document.getElementById('chat-input');
  const msg = input ? input.value.trim() : '';
  if (!msg) return;

  const messagesEl = document.getElementById('chat-messages');
  messagesEl.innerHTML += `
    <div style="display:flex;justify-content:flex-end;">
      <div style="max-width:80%;background:rgba(124,58,237,.3);border:1px solid rgba(167,139,250,.2);border-radius:10px 10px 2px 10px;padding:8px 12px;font-size:.82rem;color:#e9d5ff;line-height:1.5;">${msg}</div>
    </div>`;
  input.value = '';
  messagesEl.scrollTop = messagesEl.scrollHeight;

  try {
    const r = await fetch('/api/tickets', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject: chatSubject, message: msg })
    });
    if (r.ok) {
      messagesEl.innerHTML += `
        <div style="background:rgba(167,139,250,.1);border:1px solid rgba(167,139,250,.15);border-radius:10px 10px 10px 2px;padding:10px 14px;font-size:.82rem;color:#d1d5db;line-height:1.5;">
          ✓ Message reçu ! Notre équipe vous répondra sous 24h. Consultez l'onglet <strong>Support</strong> pour suivre votre demande.
        </div>`;
      messagesEl.scrollTop = messagesEl.scrollHeight;
    } else {
      const j = await r.json();
      if (j.error && j.error.includes('connecté')) {
        document.getElementById('chat-login-prompt').style.display = 'block';
        document.getElementById('chat-input-area').style.display = 'none';
        messagesEl.innerHTML += `<div style="text-align:center;font-size:.8rem;color:#f87171;padding:8px;">Veuillez vous connecter pour envoyer un message.</div>`;
      }
    }
  } catch {
    messagesEl.innerHTML += `<div style="text-align:center;font-size:.8rem;color:#f87171;padding:8px;">Erreur réseau. Réessayez.</div>`;
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ── PUSH NOTIFICATIONS ────────────────────────────────────────────────────────

async function requestPushPermission() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    showToast('Notifications non supportées sur ce navigateur.', 'error');
    return;
  }
  try {
    let permission;
    if (typeof Notification.requestPermission === 'function') {
      const result = Notification.requestPermission();
      if (result && typeof result.then === 'function') {
        permission = await result;
      } else {
        permission = await new Promise(resolve => Notification.requestPermission(resolve));
      }
    }
    if (permission !== 'granted') {
      showToast('Permission refusée — activez les notifications dans vos réglages.', 'error');
      return;
    }
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array('BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjZAQ4cOHHsO0KbRoXBzElvXXXXXX')
    });
    const subJson = sub.toJSON ? sub.toJSON() : { endpoint: sub.endpoint, keys: {} };
    await fetch('/api/push/subscribe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: subJson.endpoint, p256dh: subJson.keys.p256dh, auth: subJson.keys.auth })
    });
    showToast('Notifications activées !', 'success');
    updatePushButton(true);
  } catch (e) {
    showToast('Impossible d\'activer les notifications.', 'error');
  }
}

function updatePushButton(active) {
  const btn = document.getElementById('push-toggle-btn');
  if (!btn) return;
  btn.textContent = active ? '🔔 Notifications activées' : '🔕 Activer les notifications';
  btn.style.opacity = active ? '0.6' : '1';
  btn.disabled = active;
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const output = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) output[i] = rawData.charCodeAt(i);
  return output;
}

// ── PAGES LÉGALES ─────────────────────────────────────────────────────────────

function showLegal(type) {
  const content = {
    cgu: `<h2 style="font-size:1.4rem;font-weight:700;margin-bottom:6px;">Conditions Générales d'Utilisation</h2>
<p style="font-size:.78rem;color:#6b7280;margin-bottom:24px;">Dernière mise à jour : 1er mai 2026</p>
<h3 style="font-size:1rem;font-weight:600;margin:20px 0 8px;">1. Objet</h3>
<p style="font-size:.88rem;color:#d1d5db;line-height:1.8;margin-bottom:16px;">QuestInvest est une plateforme de gains passifs permettant aux utilisateurs de déposer des fonds et de compléter des quêtes pour obtenir des récompenses. L'utilisation du service implique l'acceptation pleine et entière des présentes CGU.</p>
<h3 style="font-size:1rem;font-weight:600;margin:20px 0 8px;">2. Inscription et compte</h3>
<p style="font-size:.88rem;color:#d1d5db;line-height:1.8;margin-bottom:16px;">Toute inscription requiert une adresse email valide. L'utilisateur est seul responsable de la confidentialité de ses identifiants. Un seul compte par personne est autorisé.</p>
<h3 style="font-size:1rem;font-weight:600;margin:20px 0 8px;">3. Dépôts et récompenses</h3>
<p style="font-size:.88rem;color:#d1d5db;line-height:1.8;margin-bottom:16px;">Le dépôt minimum est de 150 USD en USDT (réseau TRC20). Les récompenses sont créditées après validation administrative. QuestInvest ne garantit pas de rendement fixe et les gains peuvent varier.</p>
<h3 style="font-size:1rem;font-weight:600;margin:20px 0 8px;">4. Quêtes</h3>
<p style="font-size:.88rem;color:#d1d5db;line-height:1.8;margin-bottom:16px;">Les quêtes s'effectuent sur des cycles de 14 jours. Une fois le cycle expiré, les quêtes non complétées sont perdues. Les récompenses sont calculées sur la base du dépôt actif.</p>
<h3 style="font-size:1rem;font-weight:600;margin:20px 0 8px;">5. Retraits</h3>
<p style="font-size:.88rem;color:#d1d5db;line-height:1.8;margin-bottom:16px;">Un seul retrait est autorisé par cycle de 14 jours par compte. Les retraits sont traités sous 48h ouvrées après validation KYC.</p>
<h3 style="font-size:1rem;font-weight:600;margin:20px 0 8px;">6. Responsabilités</h3>
<p style="font-size:.88rem;color:#d1d5db;line-height:1.8;margin-bottom:16px;">QuestInvest ne pourra être tenu responsable des pertes liées aux fluctuations des cryptomonnaies, à une interruption de service ou à une utilisation frauduleuse du compte.</p>
<h3 style="font-size:1rem;font-weight:600;margin:20px 0 8px;">7. Résiliation</h3>
<p style="font-size:.88rem;color:#d1d5db;line-height:1.8;margin-bottom:16px;">QuestInvest se réserve le droit de suspendre ou de clôturer tout compte en cas de violation des présentes CGU, de fraude avérée ou d'activité suspecte.</p>
<h3 style="font-size:1rem;font-weight:600;margin:20px 0 8px;">8. Contact</h3>
<p style="font-size:.88rem;color:#d1d5db;line-height:1.8;">Pour toute question juridique : support@questinvest.com</p>`,

    privacy: `<h2 style="font-size:1.4rem;font-weight:700;margin-bottom:6px;">Politique de Confidentialité</h2>
<p style="font-size:.78rem;color:#6b7280;margin-bottom:24px;">Dernière mise à jour : 1er mai 2026</p>
<h3 style="font-size:1rem;font-weight:600;margin:20px 0 8px;">1. Données collectées</h3>
<p style="font-size:.88rem;color:#d1d5db;line-height:1.8;margin-bottom:16px;">Nous collectons : adresse email, prénom, nom, données de transactions, documents KYC (pièce d'identité recto/verso), adresses IP de connexion et données de navigation anonymisées.</p>
<h3 style="font-size:1rem;font-weight:600;margin:20px 0 8px;">2. Utilisation des données</h3>
<p style="font-size:.88rem;color:#d1d5db;line-height:1.8;margin-bottom:16px;">Vos données sont utilisées pour : gérer votre compte, traiter vos transactions, vérifier votre identité (KYC), vous envoyer des communications liées au service et prévenir la fraude.</p>
<h3 style="font-size:1rem;font-weight:600;margin:20px 0 8px;">3. Conservation des données</h3>
<p style="font-size:.88rem;color:#d1d5db;line-height:1.8;margin-bottom:16px;">Les données sont conservées pendant la durée d'utilisation du compte, plus 5 ans pour des raisons légales et comptables. Les documents KYC sont conservés 3 ans après la clôture du compte.</p>
<h3 style="font-size:1rem;font-weight:600;margin:20px 0 8px;">4. Partage des données</h3>
<p style="font-size:.88rem;color:#d1d5db;line-height:1.8;margin-bottom:16px;">Vos données ne sont jamais vendues. Elles peuvent être partagées avec des prestataires techniques (hébergement sécurisé en Europe) et les autorités compétentes en cas d'obligation légale.</p>
<h3 style="font-size:1rem;font-weight:600;margin:20px 0 8px;">5. Vos droits</h3>
<p style="font-size:.88rem;color:#d1d5db;line-height:1.8;margin-bottom:16px;">Conformément au RGPD, vous disposez d'un droit d'accès, de rectification, de suppression, de portabilité et d'opposition. Exercez vos droits en contactant : privacy@questinvest.com</p>
<h3 style="font-size:1rem;font-weight:600;margin:20px 0 8px;">6. Cookies</h3>
<p style="font-size:.88rem;color:#d1d5db;line-height:1.8;margin-bottom:16px;">Nous utilisons des cookies de session essentiels au fonctionnement du service. Aucun cookie publicitaire n'est utilisé.</p>
<h3 style="font-size:1rem;font-weight:600;margin:20px 0 8px;">7. Sécurité</h3>
<p style="font-size:.88rem;color:#d1d5db;line-height:1.8;">Vos données sont chiffrées en transit (HTTPS/TLS) et au repos. Les mots de passe sont hashés (bcrypt). Un accès 2FA est disponible pour renforcer la sécurité de votre compte.</p>`
  };

  const modal = document.getElementById('legal-modal');
  const contentEl = document.getElementById('legal-content');
  if (!modal || !contentEl) return;
  contentEl.innerHTML = content[type] || '';
  modal.style.display = 'flex';
}

function closeLegal() {
  const modal = document.getElementById('legal-modal');
  if (modal) modal.style.display = 'none';
}
