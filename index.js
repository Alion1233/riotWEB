const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');

require('dotenv').config();
const mysql = require('mysql2/promise');

// ════════════════════════════════════════════════════════════
//  TRYB TESTOWY
//  true  = płatność Stripe jest POMIJANA (kod dostajesz od razu)
//  false = prawdziwe płatności
//  !!! PRZED URUCHOMIENIEM SKLEPU DLA GRACZY USTAW NA false !!!
// ════════════════════════════════════════════════════════════
const TEST = true;

// Pakiety definiowane po stronie serwera (klient nie decyduje o cenie ani liczbie coinów)
const PACKAGES = {
  test:         { name: 'Test',         coins: 100,   price: 2,   testOnly: true },
  nowicjusz:    { name: 'Nowicjusz',    coins: 1000,  price: 29 },
  zaangazowany: { name: 'Zaangażowany', coins: 5000,  price: 99 },
  pro:          { name: 'Pro',          coins: 10000, price: 179 },
  boss:         { name: 'Boss',         coins: 30000, price: 499 },
};

function getPackage(id) {
  if (typeof id !== 'string') return null;
  if (!Object.prototype.hasOwnProperty.call(PACKAGES, id)) return null;
  const pkg = PACKAGES[id];
  if (pkg.testOnly && !TEST) return null;
  return pkg;
}

// ════════════════════════════════════════════════════════════
//  UNBANY – skracanie / zdejmowanie bana (tabela alion_bans z zasobu FiveM)
//  minutes = o ile skracamy ban, perm = zdejmuje każdy ban (także permanentny)
//  Przykład: ban 10 dni + unban 7 dni = zostaje 3 dni.
//  Ban krótszy niż pakiet jest zdejmowany w całości.
//  Pakiety czasowe NIE działają na ban permanentny – tylko pakiet "perm".
// ════════════════════════════════════════════════════════════
const UNBAN_PACKAGES = {
  '24h':  { name: 'Unban 24h',         label: '24 godz.',    minutes: 24 * 60,      price: 30 },
  '7d':   { name: 'Unban 7 dni',       label: '7 dni',       minutes: 7 * 24 * 60,  price: 50 },
  '14d':  { name: 'Unban 14 dni',      label: '14 dni',      minutes: 14 * 24 * 60, price: 60 },
  '30d':  { name: 'Unban 30 dni',      label: '30 dni',      minutes: 30 * 24 * 60, price: 100 },
  'perm': { name: 'Unban permanentny', label: 'PERM',        minutes: null,         price: 200, perm: true },
};

function getUnbanPackage(id) {
  if (typeof id !== 'string') return null;
  if (!Object.prototype.hasOwnProperty.call(UNBAN_PACKAGES, id)) return null;
  return { id, ...UNBAN_PACKAGES[id] };
}

function unbanPackageList() {
  return Object.keys(UNBAN_PACKAGES).map((id) => ({ id, ...UNBAN_PACKAGES[id] }));
}

// Kod bana ma format XXXX-XXXX-XXXX (alfabet bez 0, 1, I, O) – generuje go skrypt FiveM
function normalizeBanCode(input) {
  const raw = String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^[2-9A-HJ-NP-Z]{12}$/.test(raw)) return null;
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

// Co się stanie z banem po zakupie pakietu (ta sama logika do podglądu i do realizacji)
function previewUnban(pkg, ban) {
  if (ban.perm) {
    return pkg.perm
      ? { applicable: true, result: 'removed', remainingMinutes: 0 }
      : { applicable: false };
  }
  if (pkg.perm || pkg.minutes >= ban.minutesLeft) {
    return { applicable: true, result: 'removed', remainingMinutes: 0 };
  }
  return { applicable: true, result: 'reduced', remainingMinutes: ban.minutesLeft - pkg.minutes };
}

// Prosty limiter zapytań na IP (ochrona przed zgadywaniem kodów bana)
function createRateLimiter(limit, windowMs) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (entry.reset <= now) hits.delete(key);
  }, windowMs).unref();

  return (req, res, next) => {
    const now = Date.now();
    let entry = hits.get(req.ip);
    if (!entry || entry.reset <= now) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(req.ip, entry);
    }
    entry.count++;
    if (entry.count > limit) {
      return res.status(429).json({ success: false, error: 'Zbyt wiele prób. Spróbuj ponownie za chwilę.' });
    }
    next();
  };
}
const unbanLimiter = createRateLimiter(20, 60 * 1000);

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
});

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
app.set('trust proxy', 1); // Render stoi za proxy

app.use(cors());
app.use(express.json());

function getBaseUrl(req) {
  return process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
}

// Generowanie kodu, np. riot3fa91c0b7d2e4a68
function generateCode() {
  return 'riot' + crypto.randomBytes(8).toString('hex');
}

// ── Strona i pliki (tylko to, co potrzebne – nie wystawiamy całego folderu) ──
const sendIndex = (req, res) => res.sendFile(path.join(__dirname, 'index.html'));
app.get('/', sendIndex);
app.get('/success', sendIndex); // strona z kodem po zakupie
app.get('/riotlogo.png', (req, res) =>
  res.sendFile(path.join(__dirname, 'riotlogo.png'))
);

// Informacja dla frontendu, czy tryb testowy jest włączony
app.get('/api/config', (req, res) => {
  res.json({ test: TEST, unbanPackages: unbanPackageList() });
});

// ── Tworzenie sesji płatności ──
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { packageId } = req.body;
    const pkg = getPackage(packageId);
    if (!pkg) return res.status(400).json({ error: 'Nieznany pakiet.' });

    // TRYB TESTOWY – pomijamy Stripe i od razu przekierowujemy na stronę z kodem
    if (TEST) {
      const fakeSessionId = 'test_' + crypto.randomBytes(8).toString('hex');
      return res.json({
        url: `/success?session_id=${fakeSessionId}&package=${encodeURIComponent(packageId)}`,
        test: true,
      });
    }

    const base = getBaseUrl(req);
    const session = await stripe.checkout.sessions.create({
      managed_payments: { enabled: false },
      line_items: [
        {
          price_data: {
            currency: 'pln',
            product_data: { name: `Pakiet ${pkg.name} (${pkg.coins} RC)` },
            unit_amount: Math.round(pkg.price * 100),
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      metadata: { packageId },
      success_url: `${base}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/`,
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error('Błąd tworzenia sesji Stripe:', error);
    res.status(500).json({ error: 'Nie udało się utworzyć płatności.' });
  }
});

// ── Realizacja zamówienia: tworzy kod i wpisuje go do bazy (tylko raz na zamówienie) ──
async function fulfillOrder(sessionId, packageId, pkg, isTest) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [existing] = await conn.query(
      'SELECT code, coins FROM riot_orders WHERE session_id = ? FOR UPDATE',
      [sessionId]
    );
    if (existing.length > 0) {
      await conn.commit();
      return existing[0];
    }

    const code = generateCode();
    await conn.query(
      'INSERT INTO riot_orders (session_id, code, coins, package_id, is_test) VALUES (?, ?, ?, ?, ?)',
      [sessionId, code, pkg.coins, packageId, isTest ? 1 : 0]
    );
    await conn.query(
      'INSERT INTO riot_coins (`code`, `coins`) VALUES (?, ?)',
      [code, pkg.coins]
    );

    await conn.commit();
    return { code, coins: pkg.coins };
  } catch (err) {
    await conn.rollback();
    // dwa równoległe odświeżenia strony – drugi dostaje ten sam kod
    if (err.code === 'ER_DUP_ENTRY') {
      const [rows] = await pool.query(
        'SELECT code, coins FROM riot_orders WHERE session_id = ?',
        [sessionId]
      );
      if (rows.length > 0) return rows[0];
    }
    throw err;
  } finally {
    conn.release();
  }
}

// ── Pobranie kodu po zakupie (wywoływane przez stronę /success) ──
app.get('/api/order', async (req, res) => {
  try {
    const sessionId = String(req.query.session_id || '');
    let packageId;
    let isTest = false;

    if (sessionId.startsWith('test_')) {
      if (!TEST) return res.status(403).json({ success: false, error: 'Tryb testowy jest wyłączony.' });
      if (!/^test_[a-f0-9]{16}$/.test(sessionId)) {
        return res.status(400).json({ success: false, error: 'Nieprawidłowy identyfikator zamówienia.' });
      }
      packageId = String(req.query.package || '');
      isTest = true;
    } else if (/^cs_[A-Za-z0-9_]+$/.test(sessionId)) {
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      if (session.payment_status !== 'paid') {
        return res.status(402).json({
          success: false,
          error: 'Płatność nie została jeszcze potwierdzona. Odśwież stronę za chwilę.',
        });
      }
      packageId = session.metadata && session.metadata.packageId;
    } else {
      return res.status(400).json({ success: false, error: 'Nieprawidłowy identyfikator zamówienia.' });
    }

    const pkg = getPackage(packageId);
    if (!pkg) return res.status(400).json({ success: false, error: 'Nieznany pakiet.' });

    const order = await fulfillOrder(sessionId, packageId, pkg, isTest);
    res.json({
      success: true,
      code: order.code,
      coins: order.coins,
      packageName: pkg.name,
      test: isTest,
    });
  } catch (error) {
    console.error('Błąd realizacji zamówienia:', error);
    res.status(500).json({ success: false, error: 'Błąd serwera. Skontaktuj się z administracją.' });
  }
});

// ════════════════════════════════════════════════════════════
//  UNBANY – endpointy
// ════════════════════════════════════════════════════════════

// Stan bana po kodzie. lock = true blokuje wiersz (SELECT ... FOR UPDATE) wewnątrz transakcji.
async function getBanByCode(db, code, lock = false) {
  const [rows] = await db.query(
    `SELECT id, name, reason, active,
            (expires_at IS NULL) AS perm,
            (expires_at IS NOT NULL AND expires_at <= NOW()) AS expired,
            CEIL(TIMESTAMPDIFF(SECOND, NOW(), expires_at) / 60) AS minutes_left
       FROM alion_bans
      WHERE unban_code = ?
      LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
    [code]
  );
  if (rows.length === 0) return null;

  const r = rows[0];
  const perm = Number(r.perm) === 1;
  const isBanned = Number(r.active) === 1 && (perm || Number(r.expired) !== 1);
  return {
    id: r.id,
    name: r.name,
    reason: r.reason,
    perm,
    isBanned,
    minutesLeft: perm ? null : Math.max(Number(r.minutes_left) || 0, 0),
  };
}

// Zamówienia unbanów (osobna tabela, żeby odświeżenie strony nie skracało bana drugi raz)
async function ensureUnbanTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS riot_unban_orders (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      session_id VARCHAR(255) NOT NULL,
      unban_code VARCHAR(20) NOT NULL,
      ban_id INT NULL,
      package_id VARCHAR(20) NOT NULL,
      result VARCHAR(20) NOT NULL,
      remaining_minutes INT NULL,
      is_test TINYINT(1) NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_session (session_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

// Sprawdzenie bana po kodzie (strona wywołuje to po wpisaniu kodu)
app.post('/api/ban-lookup', unbanLimiter, async (req, res) => {
  try {
    const code = normalizeBanCode(req.body && req.body.code);
    if (!code) {
      return res.status(400).json({ success: false, error: 'Nieprawidłowy format kodu. Przykład: ABCD-EFGH-JKLM' });
    }

    const ban = await getBanByCode(pool, code);
    if (!ban) return res.status(404).json({ success: false, error: 'Nie znaleziono bana o takim kodzie.' });
    if (!ban.isBanned) {
      return res.status(409).json({ success: false, error: 'Ten ban jest już nieaktywny — możesz wejść na serwer.' });
    }

    res.json({
      success: true,
      code,
      ban: { name: ban.name, reason: ban.reason, perm: ban.perm, minutesLeft: ban.minutesLeft },
      packages: unbanPackageList().map((p) => ({ id: p.id, ...previewUnban(p, ban) })),
    });
  } catch (error) {
    console.error('Błąd sprawdzania bana:', error);
    res.status(500).json({ success: false, error: 'Błąd serwera. Spróbuj ponownie.' });
  }
});

// Tworzenie płatności za unban
app.post('/create-unban-session', unbanLimiter, async (req, res) => {
  try {
    const code = normalizeBanCode(req.body && req.body.code);
    const pkg = getUnbanPackage(req.body && req.body.packageId);
    if (!code) return res.status(400).json({ error: 'Nieprawidłowy kod bana.' });
    if (!pkg) return res.status(400).json({ error: 'Nieznany pakiet.' });

    // Walidacja PRZED płatnością – żeby nikt nie zapłacił za pakiet, który nic nie zrobi
    const ban = await getBanByCode(pool, code);
    if (!ban || !ban.isBanned) {
      return res.status(409).json({ error: 'Ten ban nie istnieje lub jest już nieaktywny.' });
    }
    if (!previewUnban(pkg, ban).applicable) {
      return res.status(409).json({ error: 'Ten pakiet nie działa na ban permanentny. Wybierz Unban permanentny.' });
    }

    // TRYB TESTOWY – pomijamy Stripe
    if (TEST) {
      const fakeSessionId = 'test_' + crypto.randomBytes(8).toString('hex');
      return res.json({
        url: `/success?type=unban&session_id=${fakeSessionId}&package=${encodeURIComponent(pkg.id)}&code=${encodeURIComponent(code)}`,
        test: true,
      });
    }

    const base = getBaseUrl(req);
    const session = await stripe.checkout.sessions.create({
      managed_payments: { enabled: false },
      line_items: [
        {
          price_data: {
            currency: 'pln',
            product_data: { name: `${pkg.name} (kod bana ${code})` },
            unit_amount: Math.round(pkg.price * 100),
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      metadata: { type: 'unban', packageId: pkg.id, banCode: code },
      success_url: `${base}/success?session_id={CHECKOUT_SESSION_ID}&type=unban`,
      cancel_url: `${base}/`,
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error('Błąd tworzenia sesji unbana:', error);
    res.status(500).json({ error: 'Nie udało się utworzyć płatności.' });
  }
});

// Realizacja: skraca / zdejmuje ban (tylko raz na zamówienie)
async function fulfillUnban(sessionId, code, pkg, isTest) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [existing] = await conn.query(
      'SELECT result, remaining_minutes, package_id FROM riot_unban_orders WHERE session_id = ? FOR UPDATE',
      [sessionId]
    );
    if (existing.length > 0) {
      await conn.commit();
      return existing[0];
    }

    const ban = await getBanByCode(conn, code, true);
    let result = 'no_effect'; // ban zniknął / wygasł między płatnością a realizacją
    let remaining = null;

    if (ban && ban.isBanned) {
      const preview = previewUnban(pkg, ban);
      if (preview.applicable && preview.result === 'removed') {
        await conn.query(
          'UPDATE alion_bans SET active = 0, unbanned_by = ?, unbanned_at = NOW() WHERE id = ?',
          [`Sklep WWW (${pkg.id})`, ban.id]
        );
        result = 'removed';
      } else if (preview.applicable) {
        await conn.query(
          'UPDATE alion_bans SET expires_at = DATE_SUB(expires_at, INTERVAL ? MINUTE) WHERE id = ?',
          [pkg.minutes, ban.id]
        );
        result = 'reduced';
        remaining = preview.remainingMinutes;
      }
    }

    await conn.query(
      'INSERT INTO riot_unban_orders (session_id, unban_code, ban_id, package_id, result, remaining_minutes, is_test) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [sessionId, code, ban ? ban.id : null, pkg.id, result, remaining, isTest ? 1 : 0]
    );

    await conn.commit();
    return { result, remaining_minutes: remaining, package_id: pkg.id };
  } catch (err) {
    await conn.rollback();
    // dwa równoległe odświeżenia strony – drugi dostaje ten sam wynik
    if (err.code === 'ER_DUP_ENTRY') {
      const [rows] = await pool.query(
        'SELECT result, remaining_minutes, package_id FROM riot_unban_orders WHERE session_id = ?',
        [sessionId]
      );
      if (rows.length > 0) return rows[0];
    }
    throw err;
  } finally {
    conn.release();
  }
}

// Wynik zakupu unbana (wywoływane przez stronę /success?type=unban)
app.get('/api/unban-order', unbanLimiter, async (req, res) => {
  try {
    const sessionId = String(req.query.session_id || '');
    let packageId;
    let code;
    let isTest = false;

    if (sessionId.startsWith('test_')) {
      if (!TEST) return res.status(403).json({ success: false, error: 'Tryb testowy jest wyłączony.' });
      if (!/^test_[a-f0-9]{16}$/.test(sessionId)) {
        return res.status(400).json({ success: false, error: 'Nieprawidłowy identyfikator zamówienia.' });
      }
      packageId = String(req.query.package || '');
      code = normalizeBanCode(req.query.code);
      isTest = true;
    } else if (/^cs_[A-Za-z0-9_]+$/.test(sessionId)) {
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      if (session.payment_status !== 'paid') {
        return res.status(402).json({
          success: false,
          error: 'Płatność nie została jeszcze potwierdzona. Odśwież stronę za chwilę.',
        });
      }
      const md = session.metadata || {};
      if (md.type !== 'unban') {
        return res.status(400).json({ success: false, error: 'To zamówienie nie dotyczy unbana.' });
      }
      packageId = md.packageId;
      code = normalizeBanCode(md.banCode);
    } else {
      return res.status(400).json({ success: false, error: 'Nieprawidłowy identyfikator zamówienia.' });
    }

    const pkg = getUnbanPackage(packageId);
    if (!pkg || !code) return res.status(400).json({ success: false, error: 'Nieprawidłowe dane zamówienia.' });

    const order = await fulfillUnban(sessionId, code, pkg, isTest);
    const orderPkg = getUnbanPackage(order.package_id) || pkg;

    res.json({
      success: true,
      packageName: orderPkg.name,
      result: order.result, // removed | reduced | no_effect
      remainingMinutes: order.remaining_minutes,
      orderRef: sessionId.slice(-8),
      test: isTest,
    });
  } catch (error) {
    console.error('Błąd realizacji unbana:', error);
    res.status(500).json({ success: false, error: 'Błąd serwera. Skontaktuj się z administracją.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Serwer działa na porcie ${PORT}`);
  if (TEST) console.warn('⚠️  TRYB TESTOWY WŁĄCZONY – płatności są pomijane!');
});

// Sprawdzenie bazy przy starcie (bez wypisywania danych użytkowników)
(async () => {
  try {
    await pool.query('SELECT 1 FROM riot_coins LIMIT 1');
    await pool.query('SELECT 1 FROM riot_orders LIMIT 1');
    console.log('✅ Połączono z bazą, tabele riot_coins i riot_orders są dostępne');
  } catch (err) {
    console.error('❌ Błąd bazy:', err.code, err.message);
  }
})();

// Unbany: tabela zamówień + sprawdzenie, czy zasób FiveM (alion_bans) jest zaktualizowany
(async () => {
  try {
    await ensureUnbanTables();
    await pool.query('SELECT unban_code FROM alion_bans LIMIT 1');
    console.log('✅ Unbany gotowe: tabele alion_bans i riot_unban_orders są dostępne');
  } catch (err) {
    console.error('❌ Błąd bazy (unbany):', err.code, err.message,
      '— uruchom serwer FiveM z zasobem alion_bans, żeby utworzył kolumnę unban_code.');
  }
})();

