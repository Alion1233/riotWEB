const express = require('express');
const cors = require('cors');
const path = require('path'); // Wbudowany moduł Node.js

const stripe = require('stripe')('sk_test_TWOJ_TAJNY_KLUCZ_STRIPE');

const app = express();

app.use(cors());
app.use(express.json());

// 1. ZWRACANIE PLIKU HTML NA STRONIE GŁÓWNEJ:
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// 2. ENDPOINT PŁATNOŚCI STRIPE:
app.post('/create-checkout-session', async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card', 'blik'],
      line_items: [
        {
          price_data: {
            currency: 'pln',
            product_data: { name: 'Doładowanie' },
            unit_amount: 2000, // 20.00 PLN w groszach
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: 'https://twoja-strona.pl/sukces',
      cancel_url: 'https://twoja-strona.pl/anulowano',
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error('Błąd Stripe:', error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Serwer działa na porcie ${PORT}`);
});
