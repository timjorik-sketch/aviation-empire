# Apron Empire - Airline Simulation Game

Multiplayer Airline Simulator mit Echtzeit-Flugoperationen.

## 🚀 Quick Start

### Backend starten:

```bash
cd backend
npm install
npm start
```

Server läuft auf: http://localhost:3001

### Testen:

Öffne im Browser: http://localhost:3001

Du solltest sehen: `{"message":"✈️ Welcome to Apron Empire API!","version":"1.0.0"}`

## 📁 Projekt-Struktur

```
aviation-empire/
├── backend/
│   ├── src/
│   │   ├── database/
│   │   │   ├── db.js
│   │   │   └── schema.sql
│   │   └── server.js
│   ├── .env
│   └── package.json
└── README.md
```

## 🔧 Nächste Schritte

1. ✅ Backend läuft
2. ⏳ Auth Routes hinzufügen
3. ⏳ Frontend erstellen
4. ⏳ Deployment

## 📝 Environment Variables

Datei: `backend/.env`

```
PORT=3001
JWT_SECRET=dein-secret-hier-mindestens-32-zeichen
NODE_ENV=development
DATABASE_PATH=./data/aviation-empire.db
```

## 🛠️ Entwickelt mit

- Node.js + Express
- SQLite (better-sqlite3)
- JWT Authentication
- React + Vite (Frontend kommt noch)
