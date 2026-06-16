const { google } = require('googleapis');

// ─── Konfigurasi dari Environment Variables Vercel ───────────────
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://namablog-anda.blogspot.com';

// ─── Auth Google via Service Account ─────────────────────────────
const getAuthClient = () => new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

// ─── Handler Utama ────────────────────────────────────────────────
module.exports = async function handler(req, res) {

    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
        const { order } = req.body;

        if (!order || !order.orderNumber || !order.items || !order.items.length) {
            return res.status(400).json({ error: 'Data order tidak valid' });
        }

        const auth = getAuthClient();
        const sheets = google.sheets({ version: 'v4', auth });
        const now = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });

        const alamat = order.address
            ? `${order.address.recipient} | ${order.address.phone} | ${order.address.detail}`
            : 'Alamat tidak tersedia';

        // 1. Tulis ke sheet ORDERS
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

        // 2. Tulis ke sheet ORDER_ITEMS
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

        // 3. Kurangi stok di sheet STOK
        const stokRes = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'STOK!A:C'
        });

        const stokRows = stokRes.data.values || [];
        const stokMap = {};
        stokRows.forEach((row, idx) => {
            if (idx === 0) return;
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
        }

        return res.status(200).json({
            success: true,
            orderNumber: order.orderNumber,
            message: 'Pesanan berhasil dicatat'
        });

    } catch (err) {
        console.error('Order API Error:', err.message);
        return res.status(500).json({
            error: 'Gagal memproses pesanan',
            detail: err.message
        });
    }
};
