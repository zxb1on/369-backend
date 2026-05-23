/**
 * 369 — KAY AI Backend
 * Secure OANDA v20 API bridge
 * Your API key lives ONLY here, never in the app
 */

require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const app     = express();

app.use(cors());
app.use(express.json());

// ── OANDA CONFIG ─────────────────────────────────────────────
const OANDA_KEY  = process.env.OANDA_API_KEY;
const ACCOUNT_ID = process.env.OANDA_ACCOUNT_ID;
const PRACTICE   = process.env.OANDA_PRACTICE === "true"; // true = demo, false = live

const BASE_URL = PRACTICE
  ? "https://api-fxpractice.oanda.com"
  : "https://api-fxtrade.oanda.com";

const STREAM_URL = PRACTICE
  ? "https://stream-fxpractice.oanda.com"
  : "https://stream-fxtrade.oanda.com";

// OANDA uses underscore format: EUR/USD → EUR_USD
const toInstrument = (pair) => pair.replace("/", "_");
const fromInstrument = (inst) => inst.replace("_", "/");

// TF map: app TF → OANDA granularity
const TF_MAP = {
  M5: "M5", M15: "M15", M30: "M30",
  H1: "H1", H4: "H4", D1: "D",
};

// ── OANDA FETCH HELPER ───────────────────────────────────────
async function oanda(path, options = {}) {
  const fetch = (await import("node-fetch")).default;
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${OANDA_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OANDA ${res.status}: ${err}`);
  }
  return res.json();
}

// ── HEALTH CHECK ─────────────────────────────────────────────
app.get("/api/health", async (req, res) => {
  try {
    const data = await oanda(`/v3/accounts/${ACCOUNT_ID}/summary`);
    res.json({
      ok: true,
      practice: PRACTICE,
      account: data.account.id,
      balance: data.account.balance,
      currency: data.account.currency,
      openTrades: data.account.openTradeCount,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── ACCOUNT INFO ─────────────────────────────────────────────
app.get("/api/account", async (req, res) => {
  try {
    const data = await oanda(`/v3/accounts/${ACCOUNT_ID}/summary`);
    const a = data.account;
    res.json({
      id: a.id,
      balance: parseFloat(a.balance),
      equity: parseFloat(a.NAV),
      unrealizedPL: parseFloat(a.unrealizedPL),
      openTrades: a.openTradeCount,
      openPositions: a.openPositionCount,
      currency: a.currency,
      leverage: a.marginRate ? Math.round(1 / parseFloat(a.marginRate)) : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── LIVE PRICE ────────────────────────────────────────────────
app.get("/api/price/:pair", async (req, res) => {
  try {
    const inst = toInstrument(req.params.pair);
    const data = await oanda(
      `/v3/accounts/${ACCOUNT_ID}/pricing?instruments=${inst}`
    );
    const p = data.prices[0];
    res.json({
      pair: req.params.pair,
      bid: parseFloat(p.bids[0].price),
      ask: parseFloat(p.asks[0].price),
      mid: (parseFloat(p.bids[0].price) + parseFloat(p.asks[0].price)) / 2,
      spread: parseFloat(p.asks[0].price) - parseFloat(p.bids[0].price),
      time: p.time,
      tradeable: p.tradeable,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── CANDLES ───────────────────────────────────────────────────
app.get("/api/candles/:pair/:tf", async (req, res) => {
  try {
    const inst = toInstrument(req.params.pair);
    const gran = TF_MAP[req.params.tf] || "H1";
    const count = parseInt(req.query.count) || 63;
    const data = await oanda(
      `/v3/instruments/${inst}/candles?granularity=${gran}&count=${count}&price=M`
    );
    const candles = data.candles
      .filter((c) => c.complete)
      .map((c) => ({
        t: new Date(c.time).getTime(),
        o: parseFloat(c.mid.o),
        h: parseFloat(c.mid.h),
        l: parseFloat(c.mid.l),
        c: parseFloat(c.mid.c),
        v: c.volume,
      }));
    res.json(candles);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── OPEN POSITIONS ────────────────────────────────────────────
app.get("/api/positions", async (req, res) => {
  try {
    const data = await oanda(`/v3/accounts/${ACCOUNT_ID}/openPositions`);
    const positions = data.positions.map((p) => ({
      pair: fromInstrument(p.instrument),
      instrument: p.instrument,
      long: p.long.units !== "0" ? {
        units: parseInt(p.long.units),
        avgPrice: parseFloat(p.long.averagePrice),
        pl: parseFloat(p.long.unrealizedPL),
      } : null,
      short: p.short.units !== "0" ? {
        units: parseInt(p.short.units),
        avgPrice: parseFloat(p.short.averagePrice),
        pl: parseFloat(p.short.unrealizedPL),
      } : null,
      unrealizedPL: parseFloat(p.unrealizedPL),
    }));
    res.json(positions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── EXECUTE TRADE ─────────────────────────────────────────────
app.post("/api/trade", async (req, res) => {
  try {
    const { pair, direction, units, stopLoss, takeProfit, entry, confidence, reason } = req.body;

    if (!pair || !direction || !units) {
      return res.status(400).json({ error: "Missing pair, direction, or units" });
    }

    // Safety checks
    if (units > 1000000) {
      return res.status(400).json({ error: "Units too large — 369 safety cap exceeded" });
    }
    if (confidence < 5) {
      return res.status(400).json({ error: "KAY confidence too low (< 5/9) — trade blocked" });
    }

    const inst = toInstrument(pair);
    const signedUnits = direction === "BUY" ? Math.abs(units) : -Math.abs(units);
    const decimalPlaces = pair.includes("JPY") ? 3 : pair === "XAU/USD" ? 2 : 5;

    const order = {
      order: {
        type: "MARKET",
        instrument: inst,
        units: String(signedUnits),
        timeInForce: "FOK",
        ...(stopLoss && {
          stopLossOnFill: {
            price: stopLoss.toFixed(decimalPlaces),
            timeInForce: "GTC",
          },
        }),
        ...(takeProfit && {
          takeProfitOnFill: {
            price: takeProfit.toFixed(decimalPlaces),
            timeInForce: "GTC",
          },
        }),
        clientExtensions: {
          comment: `KAY 369 | conf:${confidence}/9 | ${reason?.slice(0, 120) || ""}`,
          tag: "369-kay",
        },
      },
    };

    const data = await oanda(`/v3/accounts/${ACCOUNT_ID}/orders`, {
      method: "POST",
      body: JSON.stringify(order),
    });

    if (data.orderFillTransaction) {
      const fill = data.orderFillTransaction;
      res.json({
        success: true,
        orderId: fill.id,
        tradeId: fill.tradeOpened?.tradeID,
        price: parseFloat(fill.price),
        units: parseInt(fill.units),
        pl: parseFloat(fill.pl),
        time: fill.time,
      });
    } else if (data.orderCancelTransaction) {
      res.status(400).json({
        success: false,
        error: `Order cancelled: ${data.orderCancelTransaction.reason}`,
      });
    } else {
      res.status(400).json({ success: false, error: "Unexpected OANDA response", data });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── KILL SWITCH — close ALL positions ─────────────────────────
app.post("/api/kill-switch", async (req, res) => {
  try {
    const posData = await oanda(`/v3/accounts/${ACCOUNT_ID}/openPositions`);
    const positions = posData.positions;

    if (positions.length === 0) {
      return res.json({ success: true, closedCount: 0, message: "No open positions" });
    }

    let closedCount = 0;
    const errors = [];

    for (const pos of positions) {
      try {
        const body = {};
        if (pos.long.units !== "0") body.longUnits = "ALL";
        if (pos.short.units !== "0") body.shortUnits = "ALL";

        await oanda(
          `/v3/accounts/${ACCOUNT_ID}/positions/${pos.instrument}/close`,
          { method: "PUT", body: JSON.stringify(body) }
        );
        closedCount++;
      } catch (e) {
        errors.push({ instrument: pos.instrument, error: e.message });
      }
    }

    res.json({
      success: true,
      closedCount,
      errors: errors.length ? errors : undefined,
      message: `${closedCount} position(s) closed`,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── CLOSE SINGLE POSITION ─────────────────────────────────────
app.post("/api/close/:pair", async (req, res) => {
  try {
    const inst = toInstrument(req.params.pair);
    const { side } = req.body; // "long" | "short" | "all"
    const body = {};
    if (side === "long" || side === "all") body.longUnits = "ALL";
    if (side === "short" || side === "all") body.shortUnits = "ALL";

    const data = await oanda(
      `/v3/accounts/${ACCOUNT_ID}/positions/${inst}/close`,
      { method: "PUT", body: JSON.stringify(body) }
    );
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── OPEN TRADES (individual trade details) ────────────────────
app.get("/api/trades", async (req, res) => {
  try {
    const data = await oanda(`/v3/accounts/${ACCOUNT_ID}/openTrades`);
    const trades = data.trades.map((t) => ({
      id: t.id,
      pair: fromInstrument(t.instrument),
      units: parseInt(t.currentUnits),
      direction: parseInt(t.currentUnits) > 0 ? "BUY" : "SELL",
      openPrice: parseFloat(t.price),
      unrealizedPL: parseFloat(t.unrealizedPL),
      openTime: t.openTime,
      sl: t.stopLossOrder ? parseFloat(t.stopLossOrder.price) : null,
      tp: t.takeProfitOrder ? parseFloat(t.takeProfitOrder.price) : null,
    }));
    res.json(trades);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── EXPORT PINESCRIPT (TradingView) ───────────────────────────
app.get("/api/export/tradingview/:pair", (req, res) => {
  const pair = req.params.pair.replace("_", "/");
  const pine = `//@version=5
indicator("369 KAY Signals — ${pair}", overlay=true)

// ─── 369 Protocol EMAs ───
ema9  = ta.ema(close, 9)
ema21 = ta.ema(close, 21)

plot(ema9,  "EMA 9",  color=color.new(color.orange, 0), linewidth=2)
plot(ema21, "EMA 21", color=color.new(color.blue, 0),   linewidth=2)

// ─── Signal Conditions ───
bullCross = ta.crossover(ema9, ema21)
bearCross = ta.crossunder(ema9, ema21)

plotshape(bullCross, "BUY",  shape.triangleup,   location.belowbar, color.green, size=size.normal)
plotshape(bearCross, "SELL", shape.triangledown,  location.abovebar, color.red,   size=size.normal)

// ─── Bollinger Bands ───
[bbMid, bbUpper, bbLower] = ta.bb(close, 20, 2)
plot(bbUpper, "BB Upper", color=color.new(color.orange, 70))
plot(bbLower, "BB Lower", color=color.new(color.orange, 70))

// ─── RSI Panel ───
rsiVal = ta.rsi(close, 14)
hline(70, "Overbought", color.red,   linestyle=hline.style_dashed)
hline(30, "Oversold",   color.green, linestyle=hline.style_dashed)

// ─── Alerts ───
alertcondition(bullCross, "KAY BUY",  "369 KAY: BUY signal on ${pair}")
alertcondition(bearCross, "KAY SELL", "369 KAY: SELL signal on ${pair}")
`;
  res.setHeader("Content-Type", "text/plain");
  res.setHeader("Content-Disposition", `attachment; filename="369-kay-${req.params.pair}.pine"`);
  res.send(pine);
});

// ── TRADE ANALYSIS (mistake review) ──────────────────────────
app.get("/api/trades/analyze/:id", async (req, res) => {
  try {
    const { accountSize = 10000, volatility = "MEDIUM", emotions = "" } = req.query;
    const emotionList = emotions ? emotions.split(",") : [];

    // Fetch transaction details
    const data = await oanda(
      `/v3/accounts/${ACCOUNT_ID}/transactions/${req.params.id}`
    ).catch(() => null);

    const mistakes = [];
    let performanceScore = 8;

    if (emotionList.includes("revenge")) {
      mistakes.push({
        type: "Revenge Trade",
        description: "This trade was opened within 5 minutes of a loss.",
        suggestion: "Wait at least 30 minutes after a loss before re-entering.",
        severity: 8,
      });
      performanceScore -= 2;
    }
    if (emotionList.includes("overlever")) {
      mistakes.push({
        type: "Overleverage",
        description: "Risk exceeds the 369 protocol maximum of 3%.",
        suggestion: "Scale back to 1-2% risk per trade.",
        severity: 9,
      });
      performanceScore -= 3;
    }
    if (emotionList.includes("fomo")) {
      mistakes.push({
        type: "FOMO Entry",
        description: "Entry appears to be chasing an extended move.",
        suggestion: "Wait for a pullback to EMA9 before entering.",
        severity: 7,
      });
      performanceScore -= 2;
    }
    if (emotionList.includes("panic")) {
      mistakes.push({
        type: "Panic Exit",
        description: "Position closed before SL or TP was hit.",
        suggestion: "Trust your setup. Set SL and walk away.",
        severity: 6,
      });
      performanceScore -= 1;
    }

    res.json({
      performanceScore: Math.max(1, performanceScore),
      mistakes,
      kayAdvice:
        mistakes.length === 0
          ? "Clean execution. This is what discipline looks like."
          : "The market rewards patience and process. Fix these patterns — one trade at a time.",
      transaction: data || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ECONOMIC CALENDAR (ForexFactory scrape fallback) ──────────
app.get("/api/economic-calendar", async (req, res) => {
  // Stub — wire to investing.com or ForexFactory API when ready
  const today = new Date();
  res.json([
    { time: "13:30 UTC", event: "US NFP", impact: "HIGH",   currency: "USD", forecast: "+185K" },
    { time: "12:00 UTC", event: "ECB Rate",impact: "HIGH",   currency: "EUR", forecast: "Hold 4.5%" },
    { time: "09:00 UTC", event: "UK CPI",  impact: "MEDIUM", currency: "GBP", forecast: "2.6%" },
    { time: "23:50 UTC", event: "JP Trade",impact: "LOW",    currency: "JPY", forecast: "-¥400B" },
  ]);
});

// ── SERVER START ──────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n  ╔═══════════════════════════════════╗`);
  console.log(`  ║   3·6·9 KAY Backend — Running     ║`);
  console.log(`  ╚═══════════════════════════════════╝`);
  console.log(`  Port:     ${PORT}`);
  console.log(`  Mode:     ${PRACTICE ? "PRACTICE (Demo)" : "⚠️  LIVE TRADING"}`);
  console.log(`  Account:  ${ACCOUNT_ID}`);
  console.log(`  OANDA:    ${BASE_URL}\n`);

  if (!OANDA_KEY || !ACCOUNT_ID) {
    console.error("  ❌ ERROR: OANDA_API_KEY or OANDA_ACCOUNT_ID missing in .env\n");
    process.exit(1);
  }
});
