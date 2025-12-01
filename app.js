const express = require("express");
const path = require("path");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

// ───────────────────────────────────────
// 1. Connessione al DB
// ───────────────────────────────────────

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

// crea la tabella se non esiste
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS events (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      payload JSONB NOT NULL
    );
  `);
  console.log("DB initialized");
}

// funzione helper per leggere gli ultimi eventi
async function readLastEvents(limit) {
  const { rows } = await pool.query(
    `
    SELECT id, created_at, payload
    FROM events
    ORDER BY created_at DESC
    LIMIT $1
    `,
    [limit]
  );
  return rows;
}

// funzione helper per inserire un evento
async function insertEvent(rawPayload) {
  // payload “snellito” per non sprecare spazio
  const p = rawPayload || {};
  const cleanPayload = {
    type: p.type,
    sessionId: p.sessionId || null,
    visitorId: p.visitorId || null,
    isNewVisitor: !!p.isNewVisitor,
    path: p.path || p.url || "",
    referrer: p.referrer || "",
    utm_source: p.utm_source || "",
    utm_medium: p.utm_medium || "",
    utm_campaign: p.utm_campaign || "",
    deviceType: p.deviceType || "other",
    productId: p.productId || null,
    productCategory: p.productCategory || null,
    grams: p.grams || null,
    country: p.country || null
  };

  await pool.query(
    "INSERT INTO events (payload) VALUES ($1)",
    [cleanPayload]
  );
}

// ───────────────────────────────────────
// 2. Retention: tieni solo ultimi 60 giorni
// ───────────────────────────────────────

const DAYS_TO_KEEP = 60;
let lastCleanup = 0; // timestamp ms

async function maybeCleanupOldEvents() {
  const now = Date.now();
  // al massimo una volta ogni 24 ore
  if (now - lastCleanup < 24 * 60 * 60 * 1000) return;
  lastCleanup = now;

  console.log("Running cleanup of old events…");
  await pool.query(
    `DELETE FROM events WHERE created_at < NOW() - INTERVAL '${DAYS_TO_KEEP} days';`
  );
  console.log("Cleanup done");
}

// CORS per permettere le chiamate dal tuo shop
app.use((req, res, next) => {
  // consenti tutti gli origin; se vuoi puoi mettere il dominio specifico del tuo shop
  res.header("Access-Control-Allow-Origin", "*");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept"
  );
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");

  if (req.method === "OPTIONS") {
    // rispondi subito ai preflight
    return res.sendStatus(200);
  }

  next();
});

// ───────────────────────────────────────
// 3. Middleware
// ───────────────────────────────────────

app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

// ───────────────────────────────────────
// 4. Endpoint di raccolta eventi
// ───────────────────────────────────────

app.post("/collect", async (req, res) => {
  try {
    await insertEvent(req.body || {});
    maybeCleanupOldEvents().catch((err) =>
      console.error("Cleanup error", err)
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("Error in /collect", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ───────────────────────────────────────
// 5. API: /api/events (semplice)
// ───────────────────────────────────────

app.get("/api/events", async (req, res) => {
  try {
    const limitParam = parseInt(req.query.limit, 10);
    const limit =
      Number.isFinite(limitParam) && limitParam > 0
        ? Math.min(limitParam, 2000)
        : 500;

    const events = await readLastEvents(limit);
    return res.json(events); // ARRAY
  } catch (err) {
    console.error("Error in /api/events", err);
    return res.status(500).json({
      ok: false,
      error: err.message || "generic error in /api/events",
    });
  }
});

// ───────────────────────────────────────
// 6. API: /api/summary (versione “ultima 500”)
// ───────────────────────────────────────

app.get("/api/summary", async (req, res) => {
  try {
    const events = await readLastEvents(500);

    const stats = {
      totalEvents: events.length,

      // funnel
      pageviews: 0,
      timeonpageEvents: 0,
      productViews: 0,
      addToCart: 0,
      purchases: 0,

      // visitatori / sessioni
      uniqueSessions: new Set(),
      uniqueVisitors: new Set(),
      newVisitors: 0,
      returningVisitors: 0,

      // device
      devices: { desktop: 0, mobile: 0, tablet: 0, other: 0 },

      // blocchi dashboard
      topPages: {},
      referrers: {},
      utmCombos: {},
      checkoutSteps: { cart: 0, checkout: 0, shipping: 0, payment: 0, thankyou: 0 },
      activeCartsByVisitor: new Map(),
      productCategories: {},
      gramsViews: {},
      mediaInteractions: {},
      countries: {},
      formStats: {},
      jsErrors: 0,
      paymentErrors: 0,
      perfSamples: [],
    };

    const productViewSeen = new Set();

    events.forEach((ev) => {
      const p = ev.payload || {};
      const type = p.type;
      const sessionId = p.sessionId || null;
      const visitorId = p.visitorId || null;
      const isNewVisitor = p.isNewVisitor === true;
      const path = p.path || p.url || "";
      const ref = p.referrer || "";
      const utmSource = p.utm_source || "";
      const utmMedium = p.utm_medium || "";
      const utmCampaign = p.utm_campaign || "";
      const deviceType = p.deviceType || "other";

      if (sessionId) stats.uniqueSessions.add(sessionId);
      if (visitorId) stats.uniqueVisitors.add(visitorId);

      if (type === "pageview") {
        if (isNewVisitor) stats.newVisitors++;
        else stats.returningVisitors++;
      }

      if (deviceType === "desktop" || deviceType === "mobile" || deviceType === "tablet") {
        stats.devices[deviceType]++;
      } else {
        stats.devices.other++;
      }

      if (path) {
        stats.topPages[path] = (stats.topPages[path] || 0) + 1;
      }

      if (type === "pageview") {
        let key = "Direct / none";
        if (ref && ref !== "") {
          try {
            const url = new URL(ref);
            key = url.hostname;
          } catch (e) {
            key = ref;
          }
        }
        stats.referrers[key] = (stats.referrers[key] || 0) + 1;
      }

      if (type === "pageview") {
        const s = utmSource || "(none)";
        const m = utmMedium || "(none)";
        const c = utmCampaign || "(none)";
        const comboKey = `${s}|${m}|${c}`;
        stats.utmCombos[comboKey] = (stats.utmCombos[comboKey] || 0) + 1;
      }

      if (type === "pageview") stats.pageviews++;
      else if (type === "timeonpage") stats.timeonpageEvents++;
      else if (type === "view_product") stats.productViews++;
      else if (type === "add_to_cart") stats.addToCart++;
      else if (type === "purchase") stats.purchases++;

      if (type === "checkout_step") {
        const step = p.step || "checkout";
        if (stats.checkoutSteps[step] !== undefined) {
          stats.checkoutSteps[step]++;
        }
      }

      if (type === "cart_state" && visitorId) {
        const items = Array.isArray(p.items) ? p.items : [];
        stats.activeCartsByVisitor.set(visitorId, items);
      }

      if (type === "view_product") {
        const key = [
          p.sessionId || "",
          p.visitorId || "",
          p.productId || "",
          p.path || p.url || ""
        ].join("|");

        if (!productViewSeen.has(key)) {
          productViewSeen.add(key);

          if (p.productCategory) {
            stats.productCategories[p.productCategory] =
              (stats.productCategories[p.productCategory] || 0) + 1;
          }

          if (p.grams != null) {
            const gKey = String(p.grams);
            stats.gramsViews[gKey] = (stats.gramsViews[gKey] || 0) + 1;
          }
        }
      }

      if (type === "media_interaction") {
        const key = `${p.mediaType || "media"}:${p.action || "action"}`;
        stats.mediaInteractions[key] = (stats.mediaInteractions[key] || 0) + 1;
      }

      if (p.country) {
        stats.countries[p.country] = (stats.countries[p.country] || 0) + 1;
      }

      if (type === "form_interaction") {
        const formId = p.formId || "generic";
        const action = p.action || "submit";
        const key = `${formId}:${action}`;
        stats.formStats[key] = (stats.formStats[key] || 0) + 1;
      }

      if (type === "js_error") {
        stats.jsErrors++;
        const msg = (p.message || "").toLowerCase();
        if (msg.includes("payment") || msg.includes("stripe") || msg.includes("paypal")) {
          stats.paymentErrors++;
        }
      }

      if (type === "perf_metric") {
        stats.perfSamples.push({
          lcp: typeof p.lcp === "number" ? p.lcp : null,
          fcp: typeof p.fcp === "number" ? p.fcp : null,
          ttfb: typeof p.ttfb === "number" ? p.ttfb : null,
        });
      }
    });

    const sessionsCount = stats.uniqueSessions.size || 1;

    const crProductToCart =
      stats.productViews > 0 ? (stats.addToCart / stats.productViews) * 100 : 0;
    const crCartToPurchase =
      stats.addToCart > 0 ? (stats.purchases / stats.addToCart) * 100 : 0;
    const crPageviewToPurchase =
      stats.pageviews > 0 ? (stats.purchases / stats.pageviews) * 100 : 0;

    const topPagesArray = Object.entries(stats.topPages)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([path, count]) => ({ path, count }));

    const topReferrersArray = Object.entries(stats.referrers)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([source, count]) => ({ source, count }));

    const utmArray = Object.entries(stats.utmCombos)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([combo, count]) => {
        const [s, m, c] = combo.split("|");
        return { source: s, medium: m, campaign: c, count };
      });

    let activeCarts = 0;
    stats.activeCartsByVisitor.forEach((items) => {
      if (Array.isArray(items) && items.length > 0) activeCarts++;
    });

    let perfSummary = { avgLcp: null, avgFcp: null, avgTtfb: null, samples: 0 };
    if (stats.perfSamples.length > 0) {
      const validLcp = stats.perfSamples.map(s => s.lcp).filter(x => typeof x === "number");
      const validFcp = stats.perfSamples.map(s => s.fcp).filter(x => typeof x === "number");
      const validTtfb = stats.perfSamples.map(s => s.ttfb).filter(x => typeof x === "number");

      const avg = arr =>
        !arr.length ? null : arr.reduce((a, b) => a + b, 0) / arr.length;

      perfSummary = {
        avgLcp: avg(validLcp),
        avgFcp: avg(validFcp),
        avgTtfb: avg(validTtfb),
        samples: stats.perfSamples.length,
      };
    }

    return res.json({
      totalEvents: stats.totalEvents,
      pageviews: stats.pageviews,
      timeonpageEvents: stats.timeonpageEvents,
      productViews: stats.productViews,
      addToCart: stats.addToCart,
      purchases: stats.purchases,

      uniqueSessions: sessionsCount,
      uniqueVisitors: stats.uniqueVisitors.size,
      newVisitors: stats.newVisitors,
      returningVisitors: stats.returningVisitors,
      devices: stats.devices,

      crProductToCart,
      crCartToPurchase,
      crPageviewToPurchase,

      topPages: topPagesArray,
      topReferrers: topReferrersArray,
      utmCombos: utmArray,

      activeCarts,
      checkoutSteps: stats.checkoutSteps,
      productCategories: stats.productCategories,
      gramsViews: stats.gramsViews,
      mediaInteractions: stats.mediaInteractions,
      countries: stats.countries,
      formStats: stats.formStats,
      jsErrors: stats.jsErrors,
      paymentErrors: stats.paymentErrors,
      perfSummary,
    });
  } catch (err) {
    console.error("Error in /api/summary", err);
    return res.status(500).json({
      ok: false,
      error: err.message || "generic error in /api/summary",
    });
  }
});

// ───────────────────────────────────────
// 7. Dashboard statica
// ───────────────────────────────────────

app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard", "index.html"));
});

//controllo spazio nel DB
app.get("/admin/db-usage", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT pg_database_size(current_database()) AS size_bytes"
    );
    const usedBytes = Number(rows[0].size_bytes);
    const limitBytes = 1024 * 1024 * 1024; // 1GB piano free
    const usedPercent = (usedBytes / limitBytes) * 100;

    res.json({
      ok: true,
      usedBytes,
      usedMB: usedBytes / (1024 * 1024),
      usedPercent,
    });
  } catch (err) {
    console.error("Error in /admin/db-usage", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

//esporta eventi in file esterno
app.get("/admin/export-events", async (req, res) => {
  try {
    const days = parseInt(req.query.days, 10) || 30;

    const { rows } = await pool.query(
      `
      SELECT
        id,
        created_at,
        payload->>'type' AS type,
        payload->>'sessionId' AS session_id,
        payload->>'visitorId' AS visitor_id,
        payload->>'path' AS path,
        payload->>'referrer' AS referrer,
        payload->>'utm_source' AS utm_source,
        payload->>'utm_medium' AS utm_medium,
        payload->>'utm_campaign' AS utm_campaign
      FROM events
      WHERE created_at >= NOW() - INTERVAL '${days} days'
      ORDER BY created_at ASC
      `
    );

    const header = Object.keys(rows[0] || {}).join(",") + "\n";
    const lines = rows
      .map(r =>
        Object.values(r)
          .map(v => {
            if (v == null) return "";
            const s = String(v).replace(/"/g, '""');
            return `"${s}"`;
          })
          .join(",")
      )
      .join("\n");

    const csv = header + lines;

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="events_export_last_${days}_days.csv"`
    );
    res.send(csv);
  } catch (err) {
    console.error("Error in /admin/export-events", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ───────────────────────────────────────
// 8. Avvio server
// ───────────────────────────────────────

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Tracker listening on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Failed to init DB", err);
    process.exit(1);
  });
