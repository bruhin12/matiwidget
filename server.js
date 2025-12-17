import "dotenv/config";
import express from "express";
import fetch from "node-fetch";

const app = express();

/* ================== CONFIG ================== */
function requiredEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const PORT = Number(process.env.PORT || 8787);

const RIOT_API_KEY = requiredEnv("RIOT_API_KEY");
const RIOT_GAME_NAME = requiredEnv("RIOT_GAME_NAME");
const RIOT_TAG_LINE = requiredEnv("RIOT_TAG_LINE");

const RIOT_PLATFORM_ROUTING = requiredEnv("RIOT_PLATFORM_ROUTING"); // euw1
const RIOT_REGIONAL_ROUTING = requiredEnv("RIOT_REGIONAL_ROUTING"); // europe

const RIOT_RANK_QUEUE = process.env.RIOT_RANK_QUEUE || "RANKED_SOLO_5x5";
const POLL_SECONDS = Number(process.env.POLL_SECONDS || 180);
const SESSION_GAP_MINUTES = Number(process.env.SESSION_GAP_MINUTES || 60);

const HISTORY_COUNT = 10;

/* ================== HTTP ================== */
function riotHeaders() {
  return { "X-Riot-Token": RIOT_API_KEY };
}

async function httpGetJson(url, headers = {}) {
  const r = await fetch(url, { headers });
  const text = await r.text().catch(() => "");
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}: ${text.slice(0, 250)}`);
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Invalid JSON from ${url}: ${text.slice(0, 250)}`);
  }
}

async function riotGet(url) {
  return httpGetJson(url, riotHeaders());
}

/* ================== DDragon (champ icons) ================== */
let DDRAGON_VERSION = "14.1.1";
let lastDdragonCheck = 0;

async function ensureDdragonVersion() {
  const now = Date.now();
  if (now - lastDdragonCheck < 12 * 60 * 60 * 1000) return;
  lastDdragonCheck = now;
  try {
    const versions = await httpGetJson("https://ddragon.leagueoflegends.com/api/versions.json");
    if (Array.isArray(versions) && versions[0]) DDRAGON_VERSION = versions[0];
  } catch {}
}

function champIconUrl(championName) {
  return `https://ddragon.leagueoflegends.com/cdn/${DDRAGON_VERSION}/img/champion/${encodeURIComponent(
    championName
  )}.png`;
}

/* ================== RIOT API ================== */
async function getAccountByRiotId() {
  return riotGet(
    `https://${RIOT_REGIONAL_ROUTING}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(
      RIOT_GAME_NAME
    )}/${encodeURIComponent(RIOT_TAG_LINE)}`
  );
}

async function getLeagueEntriesByPuuid(puuid) {
  return riotGet(
    `https://${RIOT_PLATFORM_ROUTING}.api.riotgames.com/lol/league/v4/entries/by-puuid/${encodeURIComponent(puuid)}`
  );
}

async function getMatchIdsByPuuid(puuid, count = 16) {
  return riotGet(
    `https://${RIOT_REGIONAL_ROUTING}.api.riotgames.com/lol/match/v5/matches/by-puuid/${encodeURIComponent(
      puuid
    )}/ids?start=0&count=${count}`
  );
}

async function getMatch(matchId) {
  return riotGet(
    `https://${RIOT_REGIONAL_ROUTING}.api.riotgames.com/lol/match/v5/matches/${encodeURIComponent(matchId)}`
  );
}

/* ================== HELPERS ================== */
function platformToRegionShort(platform) {
  const p = (platform || "").toLowerCase();
  if (p === "euw1") return "EUW";
  if (p === "eun1") return "EUNE";
  if (p === "na1") return "NA";
  if (p === "kr") return "KR";
  return platform.toUpperCase();
}

function pickRank(entries) {
  const e = (entries || []).find((x) => x.queueType === RIOT_RANK_QUEUE);
  if (!e) return { queue: RIOT_RANK_QUEUE, tier: "UNRANKED", rank: "", lp: 0, wins: 0, losses: 0 };
  return { queue: RIOT_RANK_QUEUE, tier: e.tier, rank: e.rank, lp: e.leaguePoints, wins: e.wins, losses: e.losses };
}

function pctInt(w, g) {
  if (!g) return 0;
  return Math.round((w / g) * 100);
}

function extractParticipant(match, puuid) {
  const info = match?.info;
  const p = info?.participants?.find((x) => x.puuid === puuid);
  if (!p) return null;
  return {
    championName: p.championName,
    win: !!p.win,
    kills: p.kills ?? 0,
    deaths: p.deaths ?? 0,
    assists: p.assists ?? 0,
    gameStart: info?.gameStartTimestamp ?? null,
    gameEnd: info?.gameEndTimestamp ?? null,
  };
}

function computeSessionByGap(matchParts) {
  const gapMs = SESSION_GAP_MINUTES * 60 * 1000;

  const items = matchParts
    .filter((x) => x && typeof x.gameStart === "number" && typeof x.gameEnd === "number")
    .sort((a, b) => b.gameStart - a.gameStart);

  if (items.length === 0) return { wins: 0, losses: 0, games: 0, kda: "0.0", kills: 0, deaths: 0, assists: 0 };

  let cutoff = items.length;
  for (let i = 0; i < items.length - 1; i++) {
    const newer = items[i];
    const older = items[i + 1];
    const gap = newer.gameStart - older.gameEnd;
    if (gap > gapMs) {
      cutoff = i + 1;
      break;
    }
  }

  const session = items.slice(0, cutoff);

  let wins = 0,
    losses = 0,
    k = 0,
    d = 0,
    a = 0;
  for (const m of session) {
    if (m.win) wins++;
    else losses++;
    k += m.kills;
    d += m.deaths;
    a += m.assists;
  }

  const kda = ((k + a) / Math.max(1, d)).toFixed(1);
  return { wins, losses, games: wins + losses, kda, kills: k, deaths: d, assists: a };
}

/* rank badges */
function badgeForTier(tier) {
  const t = (tier || "").toUpperCase();
  if (t === "EMERALD") return "https://i.ibb.co/rfMcq5Qq/6.png";
  if (t === "DIAMOND") return "https://i.ibb.co/pvByFtMv/7.png";
  if (t === "MASTER") return "https://i.ibb.co/TB9d8r7K/Master.webp";
  return "";
}

/* ================== CACHE ================== */
let CACHE = { updatedAt: 0, data: null, error: null };

async function refresh() {
  try {
    await ensureDdragonVersion();

    const account = await getAccountByRiotId();
    if (!account?.puuid) throw new Error("Account lookup failed (no puuid).");

    const entries = await getLeagueEntriesByPuuid(account.puuid);
    const rank = pickRank(entries);

    const seasonGames = (rank.wins ?? 0) + (rank.losses ?? 0);
    const seasonWinrateInt = pctInt(rank.wins ?? 0, seasonGames);

    const matchIds = await getMatchIdsByPuuid(account.puuid, 16);
    const detailed = await Promise.all((matchIds || []).slice(0, 16).map(getMatch));
    const parts = detailed.map((m) => extractParticipant(m, account.puuid)).filter(Boolean);

    const lastN = parts
      .sort((a, b) => (b.gameStart ?? 0) - (a.gameStart ?? 0))
      .slice(0, HISTORY_COUNT)
      .map((p) => ({
        championName: p.championName,
        championIcon: champIconUrl(p.championName),
        win: p.win,
      }));

    const session = computeSessionByGap(parts);

    CACHE.data = {
      updatedAt: Date.now(),
      player: {
        riotId: `${RIOT_GAME_NAME}#${RIOT_TAG_LINE}`,
        region: platformToRegionShort(RIOT_PLATFORM_ROUTING),
      },
      rank: {
        ...rank,
        display: rank.tier === "UNRANKED" ? "UNRANKED" : `${rank.tier} ${rank.rank}`,
        badge: badgeForTier(rank.tier),
      },
      matchHistory: { lastN, count: HISTORY_COUNT },
      session: {
        wins: session.wins,
        losses: session.losses,
        games: session.games,
        kda: session.kda,
        kills: session.kills,
        deaths: session.deaths,
        assists: session.assists,
      },
      season: {
        games: seasonGames,
        winrate: seasonWinrateInt,
        wins: rank.wins ?? 0,
        losses: rank.losses ?? 0,
      },
    };

    CACHE.error = null;
    CACHE.updatedAt = Date.now();
  } catch (e) {
    CACHE.error = String(e?.message || e);
    CACHE.updatedAt = Date.now();
  }
}

await refresh();
setInterval(refresh, POLL_SECONDS * 1000);

/* ================== ROUTES ================== */
app.get("/", (_req, res) => res.redirect("/widget"));

app.get("/widget.json", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: !!CACHE.data && !CACHE.error, error: CACHE.error, ...CACHE.data, updatedAt: CACHE.updatedAt });
});

app.get("/widget", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>LoL Widget</title>
<style>
  :root{
    --bgA: rgba(6,6,7,0.96);
    --bgB: rgba(14,14,16,0.62);
    --txt: rgba(255,255,255,0.94);
    --muted: rgba(255,255,255,0.60);

    /* MOTYW: czarno-czerwony */
    --acc: rgba(255,70,70,0.95);
    --acc2: rgba(180,30,30,0.95);

    /* W/L: WIN musi być zielony */
    --win: rgba(78,255,155,0.95);
    --win2: rgba(22,200,120,0.95);
    --loss: rgba(255,70,70,0.98);
    --loss2: rgba(140,0,0,0.98);

    --warn: rgba(255,190,90,0.95);
    --shadow: 0 16px 46px rgba(0,0,0,0.55);

    --W: 420px;
    --H: 76px;
    --padX: 12px;

    /* flame */
    --flameDot: 8px;
    --edgeInset: 2px;
  }

  html,body{margin:0;background:transparent;font-family:Inter,system-ui,Segoe UI,Arial;color:var(--txt);}

  .bar{
    width: var(--W);
    height: var(--H);
    border-radius: 14px;
    background:
      linear-gradient(180deg, rgba(0,0,0,0.62) 0%, rgba(0,0,0,0.18) 55%, transparent 100%),
      radial-gradient(320px 140px at 20% 30%, rgba(255,70,70,0.10), transparent 62%),
      linear-gradient(180deg, var(--bgB), var(--bgA));
    border: 1px solid rgba(255,255,255,0.12);
    box-shadow: var(--shadow);
    overflow:hidden;
    position:relative;
    backdrop-filter: blur(10px);
    box-sizing: border-box;
  }

  .bar:before{
    content:"";
    position:absolute; inset:0;
    background-image:
      radial-gradient(circle at 18% 28%, rgba(255,255,255,0.05), transparent 40%),
      radial-gradient(circle at 76% 12%, rgba(255,255,255,0.04), transparent 45%);
    opacity:.18;
    pointer-events:none;
  }

  /* Dolna linia: czerwona */
  .line{
    position:absolute; left:0; right:0; bottom:0; height:2px;
    background: linear-gradient(90deg, transparent, var(--acc), transparent);
    opacity:.95;
    pointer-events:none;
    animation: linePulse 3.2s ease-in-out infinite;
    z-index:2;
  }
  @keyframes linePulse{
    0%,100%{ opacity:.70; filter: blur(0px); }
    50%{ opacity:1; filter: blur(0.2px); }
  }

  /* Flame na obwodzie: czerwony */
  .flameTrack{
    position:absolute;
    inset: 0;
    border-radius: 14px;
    pointer-events:none;
    z-index:3;
  }

  .flame{
    position:absolute;
    width: var(--flameDot);
    height: var(--flameDot);
    border-radius: 999px;
    transform: translate(-50%, -50%) rotate(0deg);
    animation: borderOrbit 6.8s linear infinite, flicker 0.42s ease-in-out infinite;
    filter: drop-shadow(0 0 10px rgba(255,70,70,0.60)) drop-shadow(0 0 20px rgba(255,70,70,0.22));
  }

  .flame:before{
    content:"";
    position:absolute; inset:0;
    border-radius: 999px;
    background: radial-gradient(circle at 35% 35%,
      rgba(255,255,255,0.85),
      rgba(255,70,70,0.95) 40%,
      rgba(180,30,30,0.45) 70%,
      rgba(180,30,30,0.0) 100%);
  }

  .flame:after{
    content:"";
    position:absolute;
    left: 50%; top: 50%;
    transform: translate(-50%,-50%);
    width: 28px;
    height: 16px;
    border-radius: 999px;
    background: linear-gradient(90deg,
      rgba(255,70,70,0.00),
      rgba(255,70,70,0.22),
      rgba(255,70,70,0.00));
    filter: blur(7px);
    opacity: .85;
    mix-blend-mode: screen;
  }

  @keyframes flicker{
    0%,100%{ transform: translate(-50%, -50%) scale(1); }
    50%{ transform: translate(-50%, -50%) scale(1.08); }
  }

  @keyframes borderOrbit{
    0% { left: calc(var(--edgeInset)); top: calc(var(--edgeInset)); transform: translate(-50%, -50%) rotate(0deg); }
    24% { left: calc(100% - var(--edgeInset)); top: calc(var(--edgeInset)); transform: translate(-50%, -50%) rotate(0deg); }
    25% { left: calc(100% - var(--edgeInset)); top: calc(var(--edgeInset)); transform: translate(-50%, -50%) rotate(90deg); }
    49% { left: calc(100% - var(--edgeInset)); top: calc(100% - var(--edgeInset)); transform: translate(-50%, -50%) rotate(90deg); }
    50% { left: calc(100% - var(--edgeInset)); top: calc(100% - var(--edgeInset)); transform: translate(-50%, -50%) rotate(180deg); }
    74% { left: calc(var(--edgeInset)); top: calc(100% - var(--edgeInset)); transform: translate(-50%, -50%) rotate(180deg); }
    75% { left: calc(var(--edgeInset)); top: calc(100% - var(--edgeInset)); transform: translate(-50%, -50%) rotate(270deg); }
    99% { left: calc(var(--edgeInset)); top: calc(var(--edgeInset)); transform: translate(-50%, -50%) rotate(270deg); }
    100% { left: calc(var(--edgeInset)); top: calc(var(--edgeInset)); transform: translate(-50%, -50%) rotate(360deg); }
  }

  .err{
    position:absolute; left:10px; bottom:6px;
    font-size:10px; color: rgba(255,160,160,0.95);
    user-select:none;
    z-index:5;
  }

  .slide{
    position:absolute; inset:0;
    opacity:0;
    transform: translateY(8px);
    transition: opacity 1050ms cubic-bezier(.18,.88,.22,1), transform 1050ms cubic-bezier(.18,.88,.22,1);
    pointer-events:none;
    z-index:4;
  }
  .slide.active{ opacity:1; transform: translateY(0); }

  .pad{
    height:100%;
    display:flex;
    align-items:center;
    justify-content:space-between;
    padding: 0 var(--padX);
    gap: 10px;
    position:relative;
    z-index:4;
    box-sizing: border-box;
  }

  .left, .right{
    display:flex;
    align-items:center;
    gap: 10px;
    min-width: 0;
  }
  .right{ justify-content:flex-end; }

  .stack{display:flex;flex-direction:column;gap:4px;min-width:0;}
  .label{
    font-size:11px;
    letter-spacing:.16em;
    text-transform:uppercase;
    color: rgba(255,255,255,0.56);
    user-select:none;
    line-height:1;
  }
  .big{
    font-size:20px;
    font-weight:950;
    letter-spacing:-0.02em;
    line-height:1.05;
    white-space:nowrap;
    overflow:hidden;
    text-overflow:ellipsis;
  }
  .muted{ color: var(--muted); font-size:13px; font-weight:800; }

  .sep{
    width:1px; height:52px;
    background: rgba(255,255,255,0.10);
    border-radius:999px;
    flex:0 0 auto;
  }

  .emblem{
    width: 50px; height: 50px;
    border-radius: 12px;
    border: 1px solid rgba(255,255,255,0.10);
    background: rgba(0,0,0,0.34);
    display:flex; align-items:center; justify-content:center;
    overflow:hidden;
    flex:0 0 auto;
  }
  .emblem img{ width: 48px; height: 48px; object-fit:contain; }

  .mhWrap{ display:flex; flex-direction:column; gap:9px; width:100%; }
  .mhRow{ display:flex; align-items:center; gap:6px; }

  .champ{
    width: 26px; height: 26px;
    border-radius: 9px;
    overflow:hidden;
    position:relative;
    flex:0 0 auto;
    background: rgba(0,0,0,0.36);
    border: 1px solid rgba(255,255,255,0.10);
  }
  .champ img{ width:100%; height:100%; object-fit:cover; transform:scale(1.07); }

  /* KEY FIX: WIN zielony, LOSE czerwony */
  .champ.win{ box-shadow: 0 0 0 2px rgba(78,255,155,0.70) inset; }
  .champ.loss{ box-shadow: 0 0 0 2px rgba(255,70,70,0.92) inset; }

  .resultbar{
    position:absolute; left:0; right:0; bottom:0; height:4px;
    opacity:.95;
  }
  .resultbar.win{ background: linear-gradient(90deg, var(--win), var(--win2)); }
  .resultbar.loss{ background: linear-gradient(90deg, var(--loss), var(--loss2)); }

  .mark{
    position:absolute; right:2px; top:2px;
    width:13px; height:13px;
    border-radius: 7px;
    background: rgba(0,0,0,0.48);
    display:flex; align-items:center; justify-content:center;
    font-size:10px; font-weight:950;
    border: 1px solid rgba(255,255,255,0.10);
  }
  .mark.win{ color: rgba(78,255,155,0.95); }
  .mark.loss{ color: rgba(255,70,70,0.95); }

  .sessionWL{
    font-size: 28px;
    font-weight: 950;
    letter-spacing:-0.03em;
    line-height:1;
  }
  .sessionKDA{
    font-size: 21px;
    font-weight: 950;
    letter-spacing:-0.02em;
    line-height:1.1;
  }

  /* Winrate thresholds: red/yellow/green */
  .wr-red{ color: rgba(255,70,70,0.95); }
  .wr-yellow{ color: rgba(255,190,90,0.95); }
  .wr-green{ color: rgba(78,255,155,0.95); }
</style>
</head>
<body>
<div class="bar">
  <div class="flameTrack"><div class="flame"></div></div>
  <div class="line"></div>

  <div class="slide active" id="s1">
    <div class="pad">
      <div class="left" style="flex:1 1 auto; min-width:0;">
        <div class="stack" style="min-width:0;">
          <div class="label">SUMMONER</div>
          <div class="big" id="riotId">—</div>
        </div>
      </div>

      <div class="sep"></div>

      <div class="right" style="flex:0 0 auto;">
        <div class="stack" style="width:86px;">
          <div class="label">REGION</div>
          <div class="big" id="region">—</div>
        </div>
      </div>
    </div>
    <div class="err" id="err1"></div>
  </div>

  <div class="slide" id="s2">
    <div class="pad">
      <div class="left" style="flex:1 1 auto; min-width:0;">
        <div class="emblem" id="rankEmblemBox"><img id="rankEmblem" alt="rank"/></div>
        <div class="stack" style="min-width:0;">
          <div class="label">RANGA</div>
          <div class="big" id="rankText">—</div>
        </div>
      </div>

      <div class="sep"></div>

      <div class="right" style="flex:0 0 auto;">
        <div class="stack" style="width:72px;">
          <div class="label">LP</div>
          <div class="big" id="lp">—</div>
        </div>
      </div>
    </div>
    <div class="err" id="err2"></div>
  </div>

  <div class="slide" id="s3">
    <div class="pad">
      <div class="mhWrap">
        <div class="label" id="mhLabel">LAST 10 GAMES</div>
        <div class="mhRow" id="mh"></div>
      </div>
    </div>
    <div class="err" id="err3"></div>
  </div>

  <div class="slide" id="s4">
    <div class="pad">
      <div class="left" style="flex:0 0 auto;">
        <div class="stack" style="width:140px;">
          <div class="label">SESSION W/L</div>
          <div class="sessionWL" id="sessWL">—</div>
        </div>
      </div>

      <div class="sep"></div>

      <div class="right" style="flex:1 1 auto; min-width:0;">
        <div class="stack" style="min-width:0;">
          <div class="label">SESSION KDA</div>
          <div class="sessionKDA"><span id="sessKDA">—</span> <span class="muted" id="sessKDAraw">—</span></div>
        </div>
      </div>
    </div>
    <div class="err" id="err4"></div>
  </div>

  <div class="slide" id="s5">
    <div class="pad">
      <div class="left" style="flex:0 0 auto;">
        <div class="stack" style="width:150px;">
          <div class="label">SEASON GAMES</div>
          <div class="big" id="seasonGames">—</div>
        </div>
      </div>

      <div class="sep"></div>

      <div class="right" style="flex:1 1 auto;">
        <div class="stack">
          <div class="label">SEASON WINRATE</div>
          <div class="big"><span id="seasonWR">—</span><span class="muted">%</span></div>
        </div>
      </div>
    </div>
    <div class="err" id="err5"></div>
  </div>

</div>

<script>
  const SLIDES = ["s1","s2","s3","s4","s5"];
  const SLIDE_MS = 9800;
  const UI_POLL_MS = 30000;

  let idx = 0;
  function showSlide(next){
    idx = next % SLIDES.length;
    SLIDES.forEach((id,i)=>document.getElementById(id).classList.toggle("active", i===idx));
  }
  setInterval(()=>showSlide(idx+1), SLIDE_MS);

  function winrateClass(wr){
    if (wr <= 48) return "wr-red";
    if (wr >= 52) return "wr-green";
    return "wr-yellow";
  }

  async function refresh(){
    const d = await (await fetch("/widget.json", { cache:"no-store" })).json();
    const err = d.ok ? "" : (d.error || "Brak danych");
    ["err1","err2","err3","err4","err5"].forEach(id => document.getElementById(id).textContent = err);

    document.getElementById("riotId").textContent = d.player?.riotId || "—";
    document.getElementById("region").textContent = d.player?.region || "—";

    document.getElementById("rankText").textContent = (d.rank?.display || "UNRANKED").toUpperCase();
    document.getElementById("lp").textContent =
      (d.rank?.tier && d.rank.tier !== "UNRANKED") ? ((d.rank?.lp ?? 0) + " LP") : "—";

    const badgeUrl = d.rank?.badge || "";
    const emblemBox = document.getElementById("rankEmblemBox");
    const emblem = document.getElementById("rankEmblem");
    if (badgeUrl) {
      emblemBox.style.display = "flex";
      emblem.src = badgeUrl;
    } else {
      emblemBox.style.display = "none";
    }

    const n = d.matchHistory?.count ?? 10;
    document.getElementById("mhLabel").textContent = "LAST " + n + " GAMES";

    const mh = document.getElementById("mh");
    mh.innerHTML = "";
    (d.matchHistory?.lastN || []).forEach(m => {
      const wrap = document.createElement("div");
      wrap.className = "champ " + (m.win ? "win" : "loss");
      wrap.innerHTML = \`
        <img alt="\${m.championName}" src="\${m.championIcon}">
        <div class="mark \${m.win ? "win" : "loss"}">\${m.win ? "✓" : "✕"}</div>
        <div class="resultbar \${m.win ? "win" : "loss"}"></div>
      \`;
      mh.appendChild(wrap);
    });

    const sw = d.session?.wins ?? 0;
    const sl = d.session?.losses ?? 0;
    document.getElementById("sessWL").innerHTML =
      \`<span style="color: var(--win);">\${sw}</span><span style="color: rgba(255,255,255,0.80);">-</span><span style="color: var(--loss);">\${sl}</span>\`;

    document.getElementById("sessKDA").textContent = d.session?.kda ?? "0.0";
    document.getElementById("sessKDAraw").textContent =
      \`(\${d.session?.kills ?? 0}/\${d.session?.deaths ?? 0}/\${d.session?.assists ?? 0})\`;

    document.getElementById("seasonGames").textContent = String(d.season?.games ?? 0);

    const wr = Number(d.season?.winrate ?? 0);
    const seasonWR = document.getElementById("seasonWR");
    seasonWR.textContent = String(wr);
    seasonWR.classList.remove("wr-red","wr-yellow","wr-green");
    seasonWR.classList.add(winrateClass(wr));
  }

  refresh();
  setInterval(refresh, UI_POLL_MS);
</script>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`OK: http://127.0.0.1:${PORT}/widget`);
  console.log(`JSON: http://127.0.0.1:${PORT}/widget.json`);
});
