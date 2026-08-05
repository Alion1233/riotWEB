const express = require('express');
const cors = require('cors');

// Podmień na swój prywatny klucz ze Stripe!
const stripe = require('stripe')('sk_test_TWOJ_KLUCZ_STRIPE');

const app = express();

app.use(cors());
app.use(express.json());

app.post('/create-checkout-session', async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card', 'blik'],
      line_items: [
        {
          price_data: {
            currency: 'pln',
            product_data: { name: 'Doładowanie' },
            unit_amount: 2000, // Kwota w groszach (20.00 PLN)
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
    res.status(500).json({ error: error.message });
  }
});

// BARDZO WAŻNE: Port musi być pobierany z process.env.PORT
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Serwer działa na porcie ${PORT}`);
});
app.get('/', (req, res) => {
  res.send('Backend Stripe działa poprawnie!');
});
