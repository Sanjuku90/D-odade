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
        showToast('Transaction soumise avec succès!', 'success');
      } else {
        document.getElementById('deposit-error').textContent = result.error;
      }
    } catch (err) {
      document.getElementById('deposit-error').textContent = 'Erreur de soumission';
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
  document.getElementById('nav-links').innerHTML = '<button onclick="logout()">Déconnexion</button>';
  
  loadUserData();
  loadQuests();
  loadHistory();
}

async function loadUserData() {
  try {
    const res = await fetch('/api/user');
    if (res.ok) {
      const user = await res.json();
      document.getElementById('user-balance').textContent = parseFloat(user.balance).toFixed(2);
      document.getElementById('user-deposit').textContent = parseFloat(user.deposit_amount).toFixed(2);
      document.getElementById('deposit-address').textContent = user.deposit_address;
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
      
      const questsList = document.getElementById('quests-list');
      questsList.innerHTML = data.quests.map(quest => `
        <div class="quest-item ${quest.completed ? 'completed' : ''}">
          <div class="quest-info">
            <h4>${quest.title}</h4>
            <p>${quest.description}</p>
          </div>
          <div>
            <span class="quest-reward">+${quest.reward_percentage}%</span>
            <button class="btn btn-quest" 
              onclick="completeQuest(${quest.id})" 
              ${quest.completed ? 'disabled' : ''}>
              ${quest.completed ? 'Terminée' : 'Compléter'}
            </button>
          </div>
        </div>
      `).join('');
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
      showToast(`Quête complétée! +$${parseFloat(result.reward).toFixed(2)}`, 'success');
      loadUserData();
      loadQuests();
      loadHistory();
    } else {
      showToast(result.error, 'error');
    }
  } catch (err) {
    showToast('Erreur lors de la complétion de la quête', 'error');
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
        'confirmed': 'Confirmé',
        'rejected': 'Rejeté'
      };
      
      const allHistory = [
        ...data.deposits.map(d => ({
          type: 'Dépôt - ' + (statusLabels[d.status] || d.status),
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
        historyList.innerHTML = '<p style="color: var(--text-muted); text-align: center;">Aucun historique</p>';
      } else {
        historyList.innerHTML = allHistory.map(item => `
          <div class="history-item">
            <div>
              <span class="type">${item.type}</span>
              <span style="color: var(--text-muted); font-size: 0.8rem;"> - ${item.date}</span>
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
    showToast('Adresse copiée!', 'success');
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
