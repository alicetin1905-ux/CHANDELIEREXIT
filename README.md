# SENTRY worker — Mac mini edition

24/7 server-side version of the SENTRY dashboard engine. Runs the 5-condition
stack on a timer, sends Telegram alerts on ENTER and on paper TP/SL closes, and
keeps per-timeframe paper accounts (with fees). Paper state is saved to a local
`state.json` so it survives restarts.

**This is a signal + paper-trading bot. It does NOT place real orders.**

---

## 1. Install Node (once)

Open **Terminal** and check:

```
node --version
```

If you see `v18` or higher, you're set. If not, install the **LTS** build from
https://nodejs.org (open the `.pkg`, click through), then reopen Terminal.

## 2. Put the files in a folder

Create a folder, e.g. `~/Documents/sentry-worker`, and place both files inside:

- `index.js`
- `package.json`

## 3. Make a Telegram bot (for alerts)

1. In Telegram, message **@BotFather** → send `/newbot` → follow prompts → copy the **bot token**.
2. Message **@userinfobot** → it replies with your numeric **chat id**.

(Without these the bot still runs and paper-trades; you just won't get messages.)

## 4. First run (foreground test)

In Terminal, go to the folder (type `cd `, then drag the folder in, Enter):

```
cd ~/Documents/sentry-worker
```

Then start it with your values:

```
export TELEGRAM_BOT_TOKEN="your_token_here"
export TELEGRAM_CHAT_ID="your_chat_id_here"
export TIMEFRAMES="30m"
node index.js
```

You should see `SENTRY (Mac) starting…` in Terminal and get a
**🛰️ SENTRY worker online** message in Telegram within a few seconds.
Press `Ctrl+C` to stop.

## 5. Run it 24/7 with pm2

`node index.js` stops when you close Terminal. To keep it running in the
background and auto-restart on reboot/crash, use **pm2**:

```
npm install -g pm2
```

Create a file `start.sh` next to index.js (so your env vars are remembered):

```sh
#!/bin/sh
export TELEGRAM_BOT_TOKEN="your_token_here"
export TELEGRAM_CHAT_ID="your_chat_id_here"
export TIMEFRAMES="30m"
exec node index.js
```

Make it executable and start under pm2:

```
chmod +x start.sh
pm2 start ./start.sh --name sentry
pm2 save
pm2 startup
```

`pm2 startup` prints one command (starts with `sudo`) — copy/paste and run it.
That registers auto-start at boot.

Useful pm2 commands:

```
pm2 logs sentry      # live logs
pm2 status           # is it running
pm2 restart sentry   # restart
pm2 stop sentry      # stop
```

## 6. Keep the Mac mini awake

System Settings → **Lock Screen / Energy**: prevent the Mac from sleeping
(display can sleep; the machine must stay awake). Otherwise the bot pauses.

---

## Configuration (environment variables)

| Variable | Default | Notes |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | – | required for alerts |
| `TELEGRAM_CHAT_ID` | – | required for alerts |
| `TIMEFRAMES` | `30m` | comma list: `5m,15m,30m,1h` |
| `BALANCE` | `1000` | starting paper balance per timeframe |
| `LEVERAGE` | `10` | |
| `PAPER` | `on` | `off` to only alert, no paper trades |
| `POLL_SECONDS` | `60` | how often it checks the market |
| `STATE_FILE` | `./state.json` | where paper state is saved |

Running multiple timeframes (`TIMEFRAMES="15m,30m,1h"`) keeps a separate paper
account per timeframe, just like the dashboard tabs.

## Notes & honest caveats

- **Targets per timeframe** are baked in (5m 18/12, 15m 40/27, 30m 74/50, 1H 111/75)
  with the same scaling as the dashboard.
- **Fees**: all paper PnL is net of 0.05% taker fee per side.
- **Correlation filter** (condition 5) is applied here, unlike the in-browser backtest.
- **Fills** are modeled at the TP/SL level on the live price each poll — no slippage,
  and intrabar TP-before-SL ordering isn't resolved (it checks current price each cycle).
- This mirrors the dashboard's logic but is **not** connected to your exchange account.
  It is for alerts and forward-testing only.
