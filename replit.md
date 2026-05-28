# QuestInvest - Plateforme d'Investissement avec Quêtes

## Vue d'ensemble
QuestInvest est une plateforme d'investissement où les utilisateurs peuvent déposer de l'argent (minimum 55$) et gagner des récompenses en complétant des quêtes sur un cycle de 2 semaines. Chaque quête rapporte 45% du dépôt, soit un total de 135% pour les 3 quêtes du cycle.

## Stack Technique
- **Backend**: Node.js + Express.js
- **Base de données**: SQLite avec better-sqlite3
- **Frontend**: HTML/CSS/JavaScript vanilla
- **Authentification**: Sessions avec express-session + bcryptjs + 2FA par email
- **Emails**: Nodemailer via Gmail (smartgainbot@gmail.com)

## Structure du Projet
```
├── server.js          # Serveur Express avec API REST
├── public/
│   ├── index.html     # Page principale utilisateurs
│   ├── admin.html     # Page admin pour valider les dépôts
│   ├── styles.css     # Styles CSS
│   └── app.js         # JavaScript client
├── package.json       # Dépendances Node.js
└── replit.md          # Ce fichier
```

## Base de Données (SQLite)
- **users**: Utilisateurs avec email, mot de passe hashé, solde, dépôt
- **deposits**: Historique des dépôts avec tx_hash et status (pending/confirmed/rejected)
- **quests**: 3 quêtes disponibles (45% chacune)
- **user_quests**: Suivi des quêtes complétées par cycle de 2 semaines
- **admins**: Administrateurs pour valider les paiements

## Fonctionnalités Utilisateur
1. **Inscription/Connexion** - Authentification sécurisée
2. **Tableau de bord** - Affiche le solde et dépôt total
3. **Adresse de dépôt fixe** - TAB1oeEKDS5NATwFAaUrTioDU9djX7anyS
4. **Soumission de transaction** - L'utilisateur entre le montant et hash de transaction
5. **Quêtes par cycle** - 3 quêtes toutes les 2 semaines, 45% de récompense chacune
6. **Retraits** - Un retrait disponible par utilisateur sur chaque cycle de 2 semaines
7. **Historique** - Suivi des dépôts (avec statut) et récompenses

## Fonctionnalités Admin
- **Page admin** - /admin.html
- **Connexion admin** - admin@questinvest.com / admin123
- **Valider/Rejeter les dépôts** - Après vérification du hash de transaction
- **Filtrer les dépôts** - Par statut (tous, en attente, confirmés, rejetés)

## API Endpoints
### Utilisateurs
- `POST /api/register` - Inscription
- `POST /api/login` - Connexion
- `POST /api/logout` - Déconnexion
- `GET /api/user` - Infos utilisateur
- `POST /api/deposit` - Soumettre un dépôt (montant + tx_hash)
- `GET /api/quests` - Liste des quêtes
- `POST /api/quests/:id/complete` - Compléter une quête
- `GET /api/history` - Historique

### Admin
- `POST /api/admin/login` - Connexion admin
- `POST /api/admin/logout` - Déconnexion admin
- `GET /api/admin/check` - Vérifier si admin connecté
- `GET /api/admin/deposits` - Liste tous les dépôts
- `POST /api/admin/deposits/:id/approve` - Approuver un dépôt
- `POST /api/admin/deposits/:id/reject` - Rejeter un dépôt

## Fonctionnalités KYC
- **Soumission utilisateur** : L'utilisateur peut soumettre recto/verso de sa pièce d'identité depuis l'onglet "Vérification KYC" du tableau de bord (fichier image JPG/PNG, max 6 Mo)
- **Statuts KYC** : `pending` (en attente), `confirmed` (validé), `rejected` (refusé avec motif)
- **Admin** : Page "KYC" dans le panel admin avec liste filtrée, visualisation des documents et boutons Valider/Refuser
- **Badge de notification** : Nombre de KYC en attente affiché dans le menu admin
- **Table** : `kyc_submissions` (id, user_id, document_front, document_back, status, reject_reason, submitted_at, reviewed_at)

## API Endpoints KYC
- `GET /api/kyc` — Statut KYC de l'utilisateur connecté
- `POST /api/kyc` — Soumettre des documents (base64)
- `GET /api/admin/kyc` — Liste toutes les soumissions
- `GET /api/admin/kyc/:id/document` — Récupérer les images d'une soumission
- `POST /api/admin/kyc/:id/approve` — Valider un KYC
- `POST /api/admin/kyc/:id/reject` — Refuser un KYC (avec motif optionnel)

## Changements Récents
- 29 Avr 2026: Programme de bienvenue — pendant les 14 premiers jours suivant l'inscription, les nouveaux utilisateurs voient 4 quêtes spéciales à 20% chacune (total +80%). Après ce délai, ils basculent automatiquement sur le cycle normal de 3 quêtes à 40%. Ajout de la colonne `quest_type` ('newcomer' ou 'regular') dans la table `quests` et nouvelle bannière "Bienvenue" sur la page Quêtes.
- 13 Avr 2026: Retraits limités à une demande par utilisateur sur chaque cycle de 2 semaines
- 13 Avr 2026: Récompense des quêtes mise à 45% par tâche, avec mise à jour automatique des quêtes existantes
- 13 Avr 2026: Correction du démarrage Render quand les variables `SESSION_SECRET`, `ADMIN_PASSWORD` ou `ADMIN_ACCESS_CODE` ne sont pas définies; le serveur génère désormais des valeurs persistantes sur le disque de production
- 13 Avr 2026: Migration vers l'environnement Replit, installation des dépendances Node.js, configuration du workflow sur le serveur Express, et renforcement de la configuration de session/variables sensibles
- 13 Avr 2026: Réinitialisation des quêtes changée de quotidienne à un cycle de 2 semaines
- 13 Avr 2026: Dépôt minimum changé à 55$
- 28 Mai 2026: Dépôt minimum changé à 150$, frais d'activation changés à 5$
- 23 Mai 2026: Dépôt minimum changé à 250$
- 11 Mai 2026: Dépôt minimum changé à 249$, frais d'activation de 1$ ajoutés
- 14 Déc 2024: Création initiale du projet
- Adresse de dépôt fixe: TAB1oeEKDS5NATwFAaUrTioDU9djX7anyS
- Système de soumission de transaction avec hash
- Page admin pour valider les paiements
- Transactions SQLite via better-sqlite3
