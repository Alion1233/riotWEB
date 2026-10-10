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
const TEST = false;

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
  res.json({ test: TEST });
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
