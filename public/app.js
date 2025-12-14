let currentUser = null;

document.addEventListener('DOMContentLoaded', () => {
  checkAuth();
  setupEventListeners();
});

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
      document.getElementById(view + '-view').classList.remove('hidden');
    });
  });

  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const data = {
      email: formData.get('email'),
      password: formData.get('password')
    };

    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });

      const result = await res.json();
      if (res.ok) {
        showDashboard();
      } else {
        document.getElementById('login-error').textContent = result.error;
      }
    } catch (err) {
      document.getElementById('login-error').textContent = 'Erreur de connexion';
    }
  });

  document.getElementById('register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const data = {
      email: formData.get('email'),
      password: formData.get('password')
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
      } else {
        document.getElementById('deposit-error').textContent = result.error;
      }
    } catch (err) {
      document.getElementById('deposit-error').textContent = 'Erreur de soumission';
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
  try {
    const res = await fetch('/api/user');
    if (res.ok) {
      showDashboard();
    } else {
      showAuth();
    }
  } catch (err) {
    showAuth();
  }
}

function showAuth() {
  document.getElementById('auth-section').classList.remove('hidden');
  document.getElementById('dashboard-section').classList.add('hidden');
  document.getElementById('nav-links').innerHTML = '';
}

function showDashboard() {
  document.getElementById('auth-section').classList.add('hidden');
  document.getElementById('dashboard-section').classList.remove('hidden');
  document.getElementById('nav-links').innerHTML = '<button onclick="logout()">Deconnexion</button>';
  
  loadUserData();
  loadQuests();
  loadHistory();
}

async function loadUserData() {
  try {
    const res = await fetch('/api/user');
    if (res.ok) {
      const user = await res.json();
      currentUser = user;
      document.getElementById('user-balance').textContent = parseFloat(user.balance).toFixed(2);
      document.getElementById('user-deposit').textContent = parseFloat(user.deposit_amount).toFixed(2);
      document.getElementById('deposit-address').textContent = user.deposit_address;
      
      document.getElementById('profile-email').textContent = user.email;
      document.getElementById('profile-initial').textContent = user.email.charAt(0).toUpperCase();
      
      if (user.created_at) {
        document.getElementById('profile-date').textContent = new Date(user.created_at).toLocaleDateString('fr-FR');
      }
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
      document.getElementById('quests-completed').textContent = data.completedToday;
      
      const questsCompleted2 = document.getElementById('quests-completed-2');
      if (questsCompleted2) {
        questsCompleted2.textContent = data.completedToday;
      }
      
      const progressFill = document.getElementById('quests-progress-fill');
      if (progressFill) {
        progressFill.style.width = ((data.completedToday / 3) * 100) + '%';
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
        ...data.questRewards.map(q => ({
          type: q.title,
          amount: '+$' + parseFloat(q.reward_earned).toFixed(2),
          date: new Date(q.completed_date).toLocaleDateString('fr-FR'),
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
    await fetch('/api/logout', { method: 'POST' });
    showAuth();
  } catch (err) {
    console.error('Error logging out');
  }
}

function copyAddress() {
  const address = document.getElementById('deposit-address').textContent;
  navigator.clipboard.writeText(address).then(() => {
    showToast('Adresse copiee!', 'success');
  });
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
