const express = require('express');
const cors = require('cors');
const path = require('path');
const pool = require('./db');
// Pobieranie klucza ze zmiennych środowiskowych serwera (BEZPIECZNE)
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express()

app.use(cors());
app.use(express.json());

// Serwowanie statycznych plików (np. index.html) z bieżącego folderu
app.use(express.static(__dirname));

// Główna trasa – wysyła plik index.html do przeglądarki
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Trasa do tworzenia sesji płatności w Stripe
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { packageName, priceAmount } = req.body;
    const amountInGrosze = Math.round(Number(priceAmount) * 100);

    const session = await stripe.checkout.sessions.create({
      managed_payments: { enabled: false },
      line_items: [
        {
          price_data: {
            currency: 'pln',
            product_data: { name: `Pakiet ${packageName || 'Coins'}` },
            unit_amount: amountInGrosze,
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: 'https://riotweb.onrender.com/',
      cancel_url: 'https://riotweb.onrender.com/',
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error('Błąd tworzenia sesji Stripe:', error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serwer działa na porcie ${PORT}`));
