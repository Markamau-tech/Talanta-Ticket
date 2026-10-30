const express = require('express');
const axios = require('axios');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Serve the frontend (index.html) from parent folder or public folder
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, '..')));

// ===================== CONFIG (from Environment Variables) =====================
const CONSUMER_KEY = process.env.CONSUMER_KEY || 'nZZzd2bNW8oMXVigAdHx77S44hX0cxyIjvYACcCH1j5ExDGZ';
const CONSUMER_SECRET = process.env.CONSUMER_SECRET || 'v6lEK9o9kIYtm7h4LwPtx7EW5PqtMyVblTOUZSBGlBiR2AX0B5aKLKC4PMizI1eW';
const PASSKEY = process.env.PASSKEY || 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919';
const SHORTCODE = process.env.SHORTCODE || '542542';
const ACCOUNT_REFERENCE = process.env.ACCOUNT_REFERENCE || '06506348326150';
const TRANSACTION_DESC = 'Bayern vs Ajax Ticket';

// On Render, RENDER_EXTERNAL_URL is automatically available
const BASE_HOST = process.env.RENDER_EXTERNAL_URL || process.env.BASE_URL || 'http://localhost:3000';
const CALLBACK_URL = process.env.CALLBACK_URL || `${BASE_HOST}/api/mpesa/callback`;

const isSandbox = (process.env.IS_SANDBOX || 'true').toLowerCase() === 'true';
const BASE_URL = isSandbox
  ? 'https://sandbox.safaricom.co.ke'
  : 'https://api.safaricom.co.ke';

// In-memory store (use a database like Redis/MongoDB for production)
const pendingPayments = new Map();
const confirmedPayments = new Map();

// ===================== HELPERS =====================
function getTimestamp() {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  const second = String(date.getSeconds()).padStart(2, '0');
  return `${year}${month}${day}${hour}${minute}${second}`;
}

function generatePassword(timestamp) {
  const data = SHORTCODE + PASSKEY + timestamp;
  return Buffer.from(data).toString('base64');
}

async function getAccessToken() {
  const auth = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString('base64');
  const response = await axios.get(
    `${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
    {
      headers: {
        Authorization: `Basic ${auth}`
      }
    }
  );
  return response.data.access_token;
}

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

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Talanta Tickets M-Pesa API is running' });
});

// Initiate STK Push
app.post('/api/mpesa/stkpush', async (req, res) => {
  try {
    const { phone, amount, tickets } = req.body;

    if (!phone || !amount) {
      return res.status(400).json({ success: false, message: 'Phone and amount are required' });
    }

    // Format phone to 2547XXXXXXXX
    let formattedPhone = phone.toString().replace(/\s+/g, '');
    if (formattedPhone.startsWith('0')) {
      formattedPhone = '254' + formattedPhone.slice(1);
    } else if (formattedPhone.startsWith('+254')) {
      formattedPhone = formattedPhone.slice(1);
    } else if (formattedPhone.startsWith('7') || formattedPhone.startsWith('1')) {
      formattedPhone = '254' + formattedPhone;
    }

    if (!/^254[71]\d{8}$/.test(formattedPhone)) {
      return res.status(400).json({ success: false, message: 'Invalid Kenyan phone number' });
    }

    const timestamp = getTimestamp();
    const password = generatePassword(timestamp);
    const token = await getAccessToken();

    const stkPayload = {
      BusinessShortCode: SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: Math.ceil(amount), // Must be integer
      PartyA: formattedPhone,
      PartyB: SHORTCODE,
      PhoneNumber: formattedPhone,
      CallBackURL: CALLBACK_URL,
      AccountReference: ACCOUNT_REFERENCE,
      TransactionDesc: TRANSACTION_DESC
    };

    const stkResponse = await axios.post(
      `${BASE_URL}/mpesa/stkpush/v1/processrequest`,
      stkPayload,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const { CheckoutRequestID, MerchantRequestID, ResponseCode, ResponseDescription, CustomerMessage } = stkResponse.data;

    if (ResponseCode === '0') {
      // Store pending payment
      pendingPayments.set(CheckoutRequestID, {
        phone: formattedPhone,
        amount,
        tickets: tickets || [],
        createdAt: new Date(),
        status: 'pending'
      });

      return res.json({
        success: true,
        message: CustomerMessage || 'STK Push sent. Check your phone.',
        checkoutRequestID: CheckoutRequestID,
        merchantRequestID: MerchantRequestID
      });
    } else {
      return res.status(400).json({
        success: false,
        message: ResponseDescription || 'Failed to initiate payment'
      });
    }
  } catch (error) {
    console.error('STK Push Error:', error.response?.data || error.message);
    return res.status(500).json({
      success: false,
      message: error.response?.data?.errorMessage || error.message || 'Server error'
    });
  }
});

// Safaricom Callback
app.post('/api/mpesa/callback', (req, res) => {
  console.log('===== M-PESA CALLBACK =====');
  console.log(JSON.stringify(req.body, null, 2));

  try {
    const body = req.body.Body?.stkCallback;
    if (!body) {
      return res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
    }

    const { CheckoutRequestID, ResultCode, ResultDesc } = body;

    if (ResultCode === 0) {
      // Payment successful
      const items = body.CallbackMetadata?.Item || [];
      const amount = items.find(i => i.Name === 'Amount')?.Value;
      const mpesaReceipt = items.find(i => i.Name === 'MpesaReceiptNumber')?.Value;
      const phone = items.find(i => i.Name === 'PhoneNumber')?.Value;
      const transactionDate = items.find(i => i.Name === 'TransactionDate')?.Value;

      const pending = pendingPayments.get(CheckoutRequestID) || {};
      const qty = pending.tickets?.reduce((sum, t) => sum + (t.qty || 1), 0) || 1;
      const seats = generateSeatNumbers(qty);

      const receiptRef = 'ROI-' + Date.now().toString().slice(-8) + '-' + Math.floor(Math.random() * 900 + 100);

      const confirmed = {
        checkoutRequestID: CheckoutRequestID,
        amount,
        mpesaReceipt,
        phone,
        transactionDate,
        seats,
        receiptRef,
        tickets: pending.tickets || [],
        status: 'completed',
        confirmedAt: new Date()
      };

      confirmedPayments.set(CheckoutRequestID, confirmed);
      pendingPayments.delete(CheckoutRequestID);

      console.log('Payment confirmed:', confirmed);
    } else {
      // Payment failed / cancelled
      if (pendingPayments.has(CheckoutRequestID)) {
        const pending = pendingPayments.get(CheckoutRequestID);
        pending.status = 'failed';
        pending.failReason = ResultDesc;
        pendingPayments.set(CheckoutRequestID, pending);
      }
      console.log('Payment failed:', ResultDesc);
    }

    // Always acknowledge Safaricom
    res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
  } catch (err) {
    console.error('Callback error:', err);
    res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
  }
});

// Check payment status (frontend polls this)
app.get('/api/mpesa/status/:checkoutRequestID', (req, res) => {
  const id = req.params.checkoutRequestID;

  if (confirmedPayments.has(id)) {
    const data = confirmedPayments.get(id);
    return res.json({
      success: true,
      status: 'completed',
      data
    });
  }

  if (pendingPayments.has(id)) {
    const pending = pendingPayments.get(id);
    return res.json({
      success: true,
      status: pending.status || 'pending',
      message: pending.failReason || 'Waiting for payment confirmation...'
    });
  }

  return res.json({
    success: false,
    status: 'not_found',
    message: 'Transaction not found'
  });
});

// Manual confirm (fallback if callback is delayed)
app.post('/api/mpesa/manual-confirm', (req, res) => {
  const { checkoutRequestID } = req.body;
  if (confirmedPayments.has(checkoutRequestID)) {
    return res.json({ success: true, status: 'completed', data: confirmedPayments.get(checkoutRequestID) });
  }
  return res.json({ success: false, message: 'Not yet confirmed' });
});

// Root → serve the ticket website
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'index.html'), err => {
    if (err) res.sendFile(path.join(__dirname, 'public', 'index.html'), () => {
      res.status(200).send('Talanta Tickets API is running. Open /index.html');
    });
  });
});

// ===================== START =====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Talanta Tickets M-Pesa server running on port ${PORT}`);
  console.log(`   Callback URL: ${CALLBACK_URL}`);
  console.log(`   Mode: ${isSandbox ? 'SANDBOX' : 'PRODUCTION'}`);
  console.log(`   Shortcode: ${SHORTCODE}\n`);
});
