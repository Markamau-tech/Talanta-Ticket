const express = require('express');
const axios = require('axios');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Serve frontend
app.use(express.static(path.join(__dirname, 'public')));

// ===================== PAYSTACK CONFIG =====================
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_PUBLIC_KEY = process.env.PAYSTACK_PUBLIC_KEY || 'pk_live_2074f31df08921d850d405d300eb92c18ca91a23';
const BASE_HOST = process.env.RENDER_EXTERNAL_URL || process.env.BASE_URL || 'https://talanta-ticket.onrender.com';

// In-memory store
const pendingPayments = new Map();
const confirmedPayments = new Map();

// ===================== HELPERS =====================
function generateSeatNumbers(qty) {
  const letters = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J', 'K'];
  const seats = [];
  for (let i = 0; i < qty; i++) {
    const block = letters[Math.floor(Math.random() * letters.length)];
    const row = Math.floor(Math.random() * 28) + 1;
    const seat = Math.floor(Math.random() * 22) + 1;
    seats.push(`${block}${row}-${seat}`);
  }
  return seats;
}

// ===================== ROUTES =====================

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Talanta Tickets API running with Paystack' });
});

// Initialize Paystack transaction
app.post('/api/paystack/initialize', async (req, res) => {
  try {
    const { email, amount, phone, tickets } = req.body;

    if (!amount || amount < 1) {
      return res.status(400).json({ success: false, message: 'Invalid amount' });
    }

    // Paystack expects amount in kobo (multiply by 100 for KES)
    const amountInKobo = Math.round(Number(amount) * 100);

    const reference = 'TKT-' + Date.now() + '-' + Math.floor(Math.random() * 9000 + 1000);

    const payload = {
      email: email || `${phone || 'customer'}@talantatickets.com`,
      amount: amountInKobo,
      currency: 'KES',
      reference: reference,
      callback_url: `${BASE_HOST}/api/paystack/callback`,
      metadata: {
        phone: phone || '',
        tickets: tickets || [],
        custom_fields: [
          {
            display_name: 'Phone',
            variable_name: 'phone',
            value: phone || ''
          }
        ]
      }
    };

    const response = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      payload,
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (response.data.status) {
      pendingPayments.set(reference, {
        phone,
        amount,
        tickets: tickets || [],
        createdAt: new Date(),
        status: 'pending'
      });

      return res.json({
        success: true,
        authorization_url: response.data.data.authorization_url,
        access_code: response.data.data.access_code,
        reference: reference,
        publicKey: PAYSTACK_PUBLIC_KEY
      });
    } else {
      return res.status(400).json({
        success: false,
        message: response.data.message || 'Failed to initialize payment'
      });
    }
  } catch (error) {
    console.error('Paystack Initialize Error:', error.response?.data || error.message);
    return res.status(500).json({
      success: false,
      message: error.response?.data?.message || error.message || 'Server error'
    });
  }
});

// Paystack Callback (browser redirect after payment)
app.get('/api/paystack/callback', async (req, res) => {
  const reference = req.query.reference || req.query.trxref;

  if (!reference) {
    return res.redirect('/?payment=failed');
  }

  try {
    // Verify the transaction
    const verifyRes = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` }
      }
    );

    const data = verifyRes.data.data;

    if (verifyRes.data.status && data.status === 'success') {
      const pending = pendingPayments.get(reference) || {};
      const qty = (pending.tickets || []).reduce((sum, t) => sum + (t.qty || 1), 0) || 1;
      const seats = generateSeatNumbers(qty);
      const receiptRef = 'ROI-' + Date.now().toString().slice(-8);

      const confirmed = {
        reference,
        amount: data.amount / 100,
        phone: pending.phone || data.customer?.phone || '',
        seats,
        receiptRef,
        tickets: pending.tickets || [],
        status: 'completed',
        paidAt: new Date(),
        paystackRef: data.reference
      };

      confirmedPayments.set(reference, confirmed);
      pendingPayments.delete(reference);

      // Redirect back to website with success
      return res.redirect(`/?payment=success&ref=${reference}`);
    } else {
      return res.redirect('/?payment=failed');
    }
  } catch (err) {
    console.error('Verify error:', err.response?.data || err.message);
    return res.redirect('/?payment=failed');
  }
});

// Paystack Webhook
app.post('/api/paystack/webhook', (req, res) => {
  try {
    const hash = crypto
      .createHmac('sha512', PAYSTACK_SECRET_KEY)
      .update(JSON.stringify(req.body))
      .digest('hex');

    // Optional: verify signature
    // if (hash !== req.headers['x-paystack-signature']) {
    //   return res.status(400).send('Invalid signature');
    // }

    const event = req.body;

    if (event.event === 'charge.success') {
      const data = event.data;
      const reference = data.reference;
      const pending = pendingPayments.get(reference) || {};

      if (!confirmedPayments.has(reference)) {
        const qty = (pending.tickets || []).reduce((sum, t) => sum + (t.qty || 1), 0) || 1;
        const seats = generateSeatNumbers(qty);
        const receiptRef = 'ROI-' + Date.now().toString().slice(-8);

        confirmedPayments.set(reference, {
          reference,
          amount: data.amount / 100,
          phone: pending.phone || data.customer?.phone || '',
          seats,
          receiptRef,
          tickets: pending.tickets || [],
          status: 'completed',
          paidAt: new Date()
        });
        pendingPayments.delete(reference);
      }
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(200).send('OK');
  }
});

// Check payment status
app.get('/api/paystack/status/:reference', (req, res) => {
  const ref = req.params.reference;

  if (confirmedPayments.has(ref)) {
    return res.json({
      success: true,
      status: 'completed',
      data: confirmedPayments.get(ref)
    });
  }

  if (pendingPayments.has(ref)) {
    return res.json({
      success: true,
      status: 'pending',
      message: 'Waiting for payment confirmation...'
    });
  }

  return res.json({
    success: false,
    status: 'not_found',
    message: 'Transaction not found'
  });
});

// Root → serve website
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'), err => {
    if (err) {
      res.status(200).send('Talanta Tickets API is running (Paystack). Frontend file missing.');
    }
  });
});

app.get('/index.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ===================== START =====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Talanta Tickets running with Paystack on port ${PORT}`);
  console.log(`   Public Key: ${PAYSTACK_PUBLIC_KEY.substring(0, 20)}...`);
  console.log(`   Callback: ${BASE_HOST}/api/paystack/callback\n`);
});
