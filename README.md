# Trader Assist

Trader Assist is split into a React/Vite client and a Node/Express server. Install and run each package separately from the project root:

```powershell
npm --prefix server install
npm --prefix client install
```

Configure the backend in `server/.env` using `server/.env.example` as a template. Start each process in its own terminal:

```powershell
npm --prefix server run dev
npm --prefix client run dev
```

The client runs at `http://localhost:5173`; the server listens on port `3001` by default. Run backend tests with `npm --prefix server test`.