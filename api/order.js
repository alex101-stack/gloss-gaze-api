const { google } = require('googleapis');

// ─── Konfigurasi dari Environment Variables Vercel ───────────────
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://namablog-anda.blogspot.com';

// ─── Auth Google via Service Account ─────────────────────────────
const getAuthClient = () => {
  try {
    console.log('[DEBUG-1] === Mulai getAuthClient ===');
    
    // Step 1: Baca email
    console.log('[DEBUG-2] Membaca GOOGLE_CLIENT_EMAIL...');
    const email = process.env.GOOGLE_CLIENT_EMAIL;
    console.log('[DEBUG-2] Email ada:', !!email);
    if (email) {
      console.log('[DEBUG-2] Email value:', email.substring(0, 10) + '...');
    }
    
    // Step 2: Baca private key mentah
    console.log('[DEBUG-3] Membaca GOOGLE_PRIVATE_KEY...');
    const rawKey = process.env.GOOGLE_PRIVATE_KEY || '';
    console.log('[DEBUG-3] Raw key ada:', !!rawKey);
    console.log('[DEBUG-3] Raw key length:', rawKey.length);
    console.log('[DEBUG-3] Raw key 50 char pertama:', rawKey.substring(0, 50));
    
    // Step 3: Proses key (ganti \n literal dengan newline asli)
    console.log('[DEBUG-4] Memproses key (replace \\n)...');
    const key = rawKey.replace(/\\n/g, '\n');
    console.log('[DEBUG-4] Key length setelah proses:', key.length);
    console.log('[DEBUG-4] Key mengandung BEGIN:', key.includes('-----BEGIN'));
    console.log('[DEBUG-4] Key mengandung END:', key.includes('-----END'));
    console.log('[DEBUG-4] Key mengandung newline asli:', key.includes('\n'));
    
    // Step 4: Buat konfigurasi
    console.log('[DEBUG-5] Membuat config object...');
    const config = {
      email: email,
      key: key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    };
    console.log('[DEBUG-5] Config berhasil dibuat');
    console.log('[DEBUG-5] Config keys:', Object.keys(config));
    
    // Step 5: Buat JWT client
    console.log('[DEBUG-6] Memanggil new google.auth.JWT()...');
    const client = new google.auth.JWT(config);
    console.log('[DEBUG-6] JWT client BERHASIL dibuat!');
    
    return client;
    
  } catch (error) {
    console.error('[DEBUG-ERROR] ========== ERROR DETAIL ==========');
    console.error('[DEBUG-ERROR] Message:', error.message);
    console.error('[DEBUG-ERROR] Name:', error.name);
    console.error('[DEBUG-ERROR] Stack:', error.stack);
    console.error('[DEBUG-ERROR] ===================================');
    throw error;
  }
};

// ─── Handler Utama ────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  console.log('[ROUTE] Request masuk:', req.method, req.url);

  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    console.log('[ROUTE] Parsing body...');
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    console.log('[ROUTE] Body parsed successfully');
    
    const { order } = body;

    if (!order || !order.orderNumber || !order.items || !order.items.length) {
      console.log('[ROUTE] Validasi gagal: Data order tidak valid');
      return res.status(400).json({ error: 'Data order tidak valid' });
    }

    console.log('[ROUTE] Memanggil getAuthClient...');
    const auth = getAuthClient();
    console.log('[ROUTE] Auth client OK, melanjutkan ke Google Sheets...');
    
    const sheets = google.sheets({ version: 'v4', auth });
    const now = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });

    const alamat = order.address
      ? `${order.address.recipient} | ${order.address.phone} | ${order.address.detail}`
      : 'Alamat tidak tersedia';

    // 1. Tulis ke sheet ORDERS
    console.log('[ROUTE] Menulis ke sheet ORDERS...');
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'ORDERS!A:H',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          now,
          order.orderNumber,
          'Baru',
          order.buyerName || '-',
          order.buyerPhone || '-',
          alamat,
          (order.paymentId || '-').toUpperCase(),
          order.total
        ]]
      }
    });
    console.log('[ROUTE] Sheet ORDERS berhasil ditulis');

    // 2. Tulis ke sheet ORDER_ITEMS
    console.log('[ROUTE] Menulis ke sheet ORDER_ITEMS...');
    const itemRows = order.items.map(item => [
      order.orderNumber,
      item.id,
      item.name,
      item.quantity,
      item.price * item.quantity
    ]);

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'ORDER_ITEMS!A:E',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: itemRows }
    });
    console.log('[ROUTE] Sheet ORDER_ITEMS berhasil ditulis');

    // 3. Update stok di sheet STOK
    console.log('[ROUTE] Mengupdate stok...');
    const stokRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'STOK!A:C'
    });

    const stokRows = stokRes.data.values || [];
    const stokMap = {};
    stokRows.forEach((row, idx) => {
      if (idx === 0) return; // Skip header
      stokMap[String(row[0])] = { rowIndex: idx + 1, stok: Number(row[2]) };
    });

    const updateRequests = [];
    for (const item of order.items) {
      const entry = stokMap[String(item.id)];
      if (entry) {
        const stokBaru = Math.max(0, entry.stok - item.quantity);
        updateRequests.push({
          range: `STOK!C${entry.rowIndex}`,
          values: [[stokBaru]]
        });
      }
    }

    if (updateRequests.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: {
          valueInputOption: 'RAW',
          data: updateRequests
        }
      });
      console.log('[ROUTE] Stok berhasil diupdate');
    }

    console.log('[ROUTE] Semua proses selesai!');
    return res.status(200).json({
      success: true,
      orderNumber: order.orderNumber,
      message: 'Pesanan berhasil dicatat'
    });

  } catch (err) {
    console.error('[ROUTE-ERROR] ========== ROUTE ERROR ==========');
    console.error('[ROUTE-ERROR] Message:', err.message);
    console.error('[ROUTE-ERROR] Name:', err.name);
    console.error('[ROUTE-ERROR] Code:', err.code);
    
    // Cek tipe error spesifik
    if (err.message.includes('Invalid JSON')) {
      console.error('[ROUTE-ERROR] TERKONFIRMASI: Invalid JSON error');
      console.error('[ROUTE-ERROR] Ini terjadi sebelum Google Sheets API call');
    }
    
    console.error('[ROUTE-ERROR] Full error:', err);
    console.error('[ROUTE-ERROR] ===================================');
    
    return res.status(500).json({
      error: 'Gagal memproses pesanan',
      detail: err.message
    });
  }
};
