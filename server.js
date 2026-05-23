/**
 * 369 — KAY Backend
 * MetaAPI bridge — works with ANY MT4/MT5 broker
 * Supports demo and live accounts
 */

require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const app     = express();

app.use(cors());
app.use(express.json());

// ── CONFIG ───────────────────────────────────────────────────
const META_API_TOKEN     = process.env.META_API_TOKEN;
const META_ACCOUNT_TOKEN = process.env.META_ACCOUNT_TOKEN;
const META_ACCOUNT_ID    = process.env.META_ACCOUNT_ID;
const ACCOUNT_MODE       = process.env.ACCOUNT_MODE || "demo";

const META_BASE = "https://mt-client-api-v1.london.agiliumtrade.ai";

const DEC = (pair) => ({"USD/JPY":3,"XAU/USD":2,"GBP/JPY":3})[pair] ?? 5;

const TF_MAP = {
  M5:"5m", M15:"15m", M30:"30m",
  H1:"1h", H4:"4h", D1:"1d",
};

function generateFallbackCandles(pair, n=63) {
  const BASE = {
    "EUR/USD":1.085,"GBP/USD":1.265,"USD/JPY":149.5,
    "XAU/USD":2350,"GBP/JPY":189.5,"AUD/USD":0.652,
    "USD/CAD":1.365,"USD/CHF":0.905,
  };
  const base=BASE[pair]||1.085, sp=pair==="XAU/USD"?0.9:pair.includes("JPY")?0.018:0.0028;
  let p=base; const now=Date.now(), out=[];
  for(let i=n;i>=0;i--){
    const o=p,mv=(Math.random()-0.487)*sp,c=o+mv;
    out.push({t:now-i*3600000,o,c,h:Math.max(o,c)+Math.random()*sp*0.4,l:Math.min(o,c)-Math.random()*sp*0.4,v:Math.floor(Math.random()*9000+3000)});
    p=c;
  }
  return out;
}

// ── METAAPI HELPER ───────────────────────────────────────────
async function metaFetch(path, options={}) {
  const fetch = (await import("node-fetch")).default;
  const url   = `${META_BASE}/users/current/accounts/${META_ACCOUNT_ID}${path}`;
  const res   = await fetch(url, {
    ...options,
    headers: {
      "auth-token":   META_ACCOUNT_TOKEN,
      "Content-Type": "application/json",
      Accept:         "application/json",
      ...(options.headers||{}),
    },
  });
  const text = await res.text();
  let data;
  try { data=JSON.parse(text); } catch { data={raw:text}; }
  if (!res.ok) throw new Error(`MetaAPI ${res.status}: ${data?.message||text}`);
  return data;
}

// ── HEALTH ───────────────────────────────────────────────────
app.get("/api/health", async (req,res) => {
  try {
    const d = await metaFetch("/account-information");
    res.json({ok:true,mode:ACCOUNT_MODE,broker:d.broker||"OANDA",balance:d.balance,equity:d.equity,currency:d.currency,server:d.server});
  } catch(err) { res.status(500).json({ok:false,error:err.message}); }
});

// ── ACCOUNT ──────────────────────────────────────────────────
app.get("/api/account", async (req,res) => {
  try {
    const d = await metaFetch("/account-information");
    res.json({balance:d.balance,equity:d.equity,margin:d.margin,freeMargin:d.freeMargin,leverage:d.leverage,currency:d.currency,broker:d.broker,server:d.server,mode:ACCOUNT_MODE});
  } catch(err) { res.status(500).json({error:err.message}); }
});

// ── LIVE PRICE ────────────────────────────────────────────────
app.get("/api/price/:pair", async (req,res) => {
  try {
    const symbol = req.params.pair.replace("/","");
    const d      = await metaFetch(`/symbols/${symbol}/current-price`);
    const bid=parseFloat(d.bid), ask=parseFloat(d.ask);
    res.json({pair:req.params.pair,bid,ask,mid:(bid+ask)/2,spread:ask-bid,time:d.time||new Date().toISOString()});
  } catch(err) { res.status(500).json({error:err.message}); }
});

// ── CANDLES ───────────────────────────────────────────────────
app.get("/api/candles/:pair/:tf", async (req,res) => {
  try {
    const symbol = req.params.pair.replace("/","");
    const tf     = TF_MAP[req.params.tf]||"1h";
    const count  = parseInt(req.query.count)||63;
    const d      = await metaFetch(`/symbols/${symbol}/candles?timeframe=${tf}&limit=${count}`);
    const candles = (Array.isArray(d)?d:d.candles||[]).map(c=>({
      t:new Date(c.time).getTime(),
      o:parseFloat(c.open||c.openPrice),
      h:parseFloat(c.high||c.highPrice),
      l:parseFloat(c.low||c.lowPrice),
      c:parseFloat(c.close||c.closePrice),
      v:parseInt(c.tickVolume||c.volume||0),
    }));
    res.json(candles.length ? candles : generateFallbackCandles(req.params.pair,count));
  } catch(err) {
    console.warn("Candle fetch failed, using simulated data:", err.message);
    res.json(generateFallbackCandles(req.params.pair,63));
  }
});

// ── POSITIONS ─────────────────────────────────────────────────
app.get("/api/positions", async (req,res) => {
  try {
    const d    = await metaFetch("/positions");
    const list = (Array.isArray(d)?d:d.positions||[]).map(p=>({
      id:p.id,
      pair:p.symbol?.replace(/([A-Z]{3})([A-Z]{3})/,"$1/$2")||p.symbol,
      direction:p.type==="POSITION_TYPE_BUY"?"BUY":"SELL",
      volume:p.volume, openPrice:p.openPrice, currentPrice:p.currentPrice,
      unrealizedPL:p.unrealizedProfit, sl:p.stopLoss||null, tp:p.takeProfit||null, openTime:p.time,
    }));
    res.json(list);
  } catch(err) { res.status(500).json({error:err.message}); }
});

// ── EXECUTE TRADE ─────────────────────────────────────────────
app.post("/api/trade", async (req,res) => {
  try {
    const {pair,direction,units,stopLoss,takeProfit,confidence,reason} = req.body;
    if (!pair||!direction||!units) return res.status(400).json({error:"Missing pair, direction, or units"});
    if (confidence<5) return res.status(400).json({error:`KAY confidence too low (${confidence}/9). Minimum is 5/9.`});
    const symbol = pair.replace("/","");
    const d      = DEC(pair);
    const volume = Math.max(0.01, parseFloat((units/100000).toFixed(2)));
    const order  = {
      symbol, volume,
      actionType: direction==="BUY"?"ORDER_TYPE_BUY":"ORDER_TYPE_SELL",
      ...(stopLoss   && {stopLoss:   parseFloat(stopLoss.toFixed(d))}),
      ...(takeProfit && {takeProfit: parseFloat(takeProfit.toFixed(d))}),
      comment: `KAY369 ${confidence}/9 | ${(reason||"").slice(0,60)}`,
    };
    const data = await metaFetch("/trade",{method:"POST",body:JSON.stringify(order)});
    if (data.numericCode===10009||data.orderId||data.positionId) {
      res.json({success:true,orderId:data.orderId,positionId:data.positionId,volume,time:new Date().toISOString()});
    } else {
      res.status(400).json({success:false,error:data.message||data.stringCode||"Order not filled"});
    }
  } catch(err) { res.status(500).json({success:false,error:err.message}); }
});

// ── KILL SWITCH ───────────────────────────────────────────────
app.post("/api/kill-switch", async (req,res) => {
  try {
    const d    = await metaFetch("/positions");
    const list = Array.isArray(d)?d:d.positions||[];
    if (!list.length) return res.json({success:true,closedCount:0,message:"No open positions"});
    let closedCount=0; const errors=[];
    for (const pos of list) {
      try {
        await metaFetch("/trade",{method:"POST",body:JSON.stringify({
          actionType: pos.type==="POSITION_TYPE_BUY"?"POSITION_TYPE_SELL":"POSITION_TYPE_BUY",
          symbol:pos.symbol, volume:pos.volume, positionId:pos.id, comment:"KAY369 Kill Switch",
        })});
        closedCount++;
      } catch(e) { errors.push({id:pos.id,error:e.message}); }
    }
    res.json({success:true,closedCount,errors:errors.length?errors:undefined,message:`${closedCount} position(s) closed`});
  } catch(err) { res.status(500).json({success:false,error:err.message}); }
});

// ── CLOSE SINGLE ──────────────────────────────────────────────
app.post("/api/close/:positionId", async (req,res) => {
  try {
    const d    = await metaFetch("/positions");
    const list = Array.isArray(d)?d:d.positions||[];
    const pos  = list.find(p=>p.id===req.params.positionId);
    if (!pos) return res.status(404).json({error:"Position not found"});
    const data = await metaFetch("/trade",{method:"POST",body:JSON.stringify({
      actionType: pos.type==="POSITION_TYPE_BUY"?"POSITION_TYPE_SELL":"POSITION_TYPE_BUY",
      symbol:pos.symbol, volume:pos.volume, positionId:pos.id, comment:"KAY369 Manual Close",
    })});
    res.json({success:true,data});
  } catch(err) { res.status(500).json({success:false,error:err.message}); }
});

// ── TRADES ───────────────────────────────────────────────────
app.get("/api/trades", async (req,res) => {
  try {
    const d    = await metaFetch("/positions");
    const list = (Array.isArray(d)?d:d.positions||[]).map(t=>({
      id:t.id, pair:t.symbol?.replace(/([A-Z]{3})([A-Z]{3})/,"$1/$2")||t.symbol,
      direction:t.type==="POSITION_TYPE_BUY"?"BUY":"SELL",
      volume:t.volume, openPrice:t.openPrice, currentPrice:t.currentPrice,
      unrealizedPL:t.unrealizedProfit, sl:t.stopLoss||null, tp:t.takeProfit||null, openTime:t.time,
    }));
    res.json(list);
  } catch(err) { res.status(500).json({error:err.message}); }
});

// ── ECONOMIC CALENDAR ─────────────────────────────────────────
app.get("/api/economic-calendar", (req,res) => {
  res.json([
    {time:"13:30 UTC",event:"US NFP",   impact:"HIGH",  currency:"USD",forecast:"+185K"},
    {time:"12:00 UTC",event:"ECB Rate", impact:"HIGH",  currency:"EUR",forecast:"Hold" },
    {time:"09:00 UTC",event:"UK CPI",   impact:"MEDIUM",currency:"GBP",forecast:"2.6%" },
    {time:"23:50 UTC",event:"JP Trade", impact:"LOW",   currency:"JPY",forecast:"-¥400B"},
  ]);
});

// ── START ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n  ╔════════════════════════════════════╗`);
  console.log(`  ║   3·6·9 KAY Backend — Running      ║`);
  console.log(`  ╚════════════════════════════════════╝`);
  console.log(`  Broker:   OANDA via MetaAPI`);
  console.log(`  Mode:     ${ACCOUNT_MODE.toUpperCase()} ${ACCOUNT_MODE==="live"?"⚠️  REAL MONEY":"(Demo — safe)"}`);
  console.log(`  Account:  ${META_ACCOUNT_ID}`);
  console.log(`  Port:     ${PORT}\n`);
  if (!META_API_TOKEN||!META_ACCOUNT_TOKEN||!META_ACCOUNT_ID) {
    console.error("  ❌ Missing META_API_TOKEN, META_ACCOUNT_TOKEN, or META_ACCOUNT_ID\n");
    process.exit(1);
  }
});
