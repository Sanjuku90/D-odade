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
│   ├── index.html     # Page principale
│   ├── styles.css     # Styles CSS
│   └── app.js         # JavaScript client
├── package.json       # Dépendances Node.js
└── replit.md          # Ce fichier
```

## Base de Données (PostgreSQL)
- **users**: Utilisateurs avec email, mot de passe hashé, solde, dépôt, adresse
- **deposits**: Historique des dépôts
- **quests**: 3 quêtes disponibles (15% chacune)
- **user_quests**: Suivi des quêtes complétées par jour

## Fonctionnalités
1. **Inscription/Connexion** - Authentification sécurisée
2. **Tableau de bord** - Affiche le solde et dépôt total
3. **Adresse de dépôt** - Adresse unique générée pour chaque utilisateur
4. **Quêtes quotidiennes** - 3 quêtes par jour, 15% de récompense chacune
5. **Historique** - Suivi des dépôts et récompenses

## API Endpoints
- `POST /api/register` - Inscription
- `POST /api/login` - Connexion
- `POST /api/logout` - Déconnexion
- `GET /api/user` - Infos utilisateur
- `POST /api/deposit` - Effectuer un dépôt
- `GET /api/quests` - Liste des quêtes
- `POST /api/quests/:id/complete` - Compléter une quête
- `GET /api/history` - Historique

## Changements Récents
- 14 Déc 2024: Création initiale du projet
- Correction des transactions PostgreSQL (client dédié)
- Amélioration de la sécurité des sessions
