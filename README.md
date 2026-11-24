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

On Windows, run `.\Start-TraderAssist.ps1` to start both local services and open the web app. Run `.\Install-TraderAssist-Autostart.ps1` once to add it to the current Windows user's Startup folder; it starts after sign-in and keeps the services bound to loopback.

The client runs at `http://localhost:5173`; the server listens on port `3001` by default. Run backend tests with `npm --prefix server test`.

The local Vite app uses the server through its `/api` and `/socket.io` proxies. To use a separately hosted API in a production build, set the client's `VITE_API_URL` to that API's origin. The local development servers bind to `127.0.0.1`; production hosting can bind to `0.0.0.0`.

The journal starts fresh when the server first creates its journal state. Older journal entries remain stored but are excluded; only setups confirmed from that point onward appear. Setups and journal entries are scoped to the signed-in account.

The CHOCH monitor replays the exchange's available closed candles on refresh, carries a valid prior CHOCH into confirmations completed after monitoring starts, and tracks fresh breaks after invalidation. Market or network outages can still delay signals; missed moves beyond the exchange history window cannot be recovered.

For 15M CHOCH setups, email notifications are sent for the CHOCH, the first valid confirmation candle, and full setup confirmation when the account's email notifications are enabled. An opposite-direction 15M CHOCH is recorded in its own informational feed section; it does not count as a setup confirmation and does not send an email, sound, or pop-up notification.