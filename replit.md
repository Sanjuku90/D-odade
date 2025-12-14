# QuestInvest - Plateforme d'Investissement avec Quêtes

## Vue d'ensemble
QuestInvest est une plateforme d'investissement où les utilisateurs peuvent déposer de l'argent (minimum 30$) et gagner des récompenses en complétant des quêtes quotidiennes. Chaque quête rapporte 15% du dépôt, soit un total de 45% pour les 3 quêtes quotidiennes.

## Stack Technique
- **Backend**: Node.js + Express.js
- **Base de données**: PostgreSQL
- **Frontend**: HTML/CSS/JavaScript vanilla
- **Authentification**: Sessions avec express-session + bcryptjs

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

## Base de Données (PostgreSQL)
- **users**: Utilisateurs avec email, mot de passe hashé, solde, dépôt
- **deposits**: Historique des dépôts avec tx_hash et status (pending/confirmed/rejected)
- **quests**: 3 quêtes disponibles (15% chacune)
- **user_quests**: Suivi des quêtes complétées par jour
- **admins**: Administrateurs pour valider les paiements

## Fonctionnalités Utilisateur
1. **Inscription/Connexion** - Authentification sécurisée
2. **Tableau de bord** - Affiche le solde et dépôt total
3. **Adresse de dépôt fixe** - TAB1oeEKDS5NATwFAaUrTioDU9djX7anyS
4. **Soumission de transaction** - L'utilisateur entre le montant et hash de transaction
5. **Quêtes quotidiennes** - 3 quêtes par jour, 15% de récompense chacune
6. **Historique** - Suivi des dépôts (avec statut) et récompenses

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

## Changements Récents
- 14 Déc 2024: Création initiale du projet
- Adresse de dépôt fixe: TAB1oeEKDS5NATwFAaUrTioDU9djX7anyS
- Système de soumission de transaction avec hash
- Page admin pour valider les paiements
- Correction des transactions PostgreSQL (client dédié)
