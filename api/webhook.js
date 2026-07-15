// /api/webhook.js
// Menerima notifikasi pembayaran dari Midtrans
// Update: Supabase payments, Google Sheets ORDERS + PRODUCTS (stok)
const { google }       = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const crypto           = require('crypto');

const MIDTRANS_SERVER_KEY  = process.env.MIDTRANS_SERVER_KEY;
const MIDTRANS_IS_PRODUCTION = process.env.MIDTRANS_IS_PRODUCTION === 'true';
const SPREADSHEET_ID       = process.env.SPREADSHEET_ID;
const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const MIDTRANS_API_BASE = MIDTRANS_IS_PRODUCTION
    ? 'https://api.midtrans.com'
    : 'https://api.sandbox.midtrans.com';

const getGoogleAuth = () => new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key:   (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

// Status Midtrans yang dianggap pembayaran berhasil
const SUCCESS_STATUSES = ['capture', 'settlement'];
const PENDING_STATUSES = ['pending', 'authorize'];
const FAILED_STATUSES  = ['deny', 'expire', 'cancel', 'failure'];

module.exports = async function handler(req, res) {
    // Midtrans kirim POST, tidak ada CORS issue karena server-to-server
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
        const notif = req.body;
        console.log('Webhook received:', JSON.stringify(notif));

        // Verifikasi signature dari Midtrans
        // signature_key = SHA512(order_id + status_code + gross_amount + server_key)
        const expectedSignature = crypto
            .createHash('sha512')
            .update(`${notif.order_id}${notif.status_code}${notif.gross_amount}${MIDTRANS_SERVER_KEY}`)
            .digest('hex');

        if (notif.signature_key !== expectedSignature) {
            console.error('Invalid signature — kemungkinan bukan dari Midtrans');
            return res.status(403).json({ error: 'Invalid signature' });
        }

        // Verifikasi ulang ke Midtrans API (double-check)
        const authHeader = 'Basic ' + Buffer.from(MIDTRANS_SERVER_KEY + ':').toString('base64');
        const verifyRes = await fetch(`${MIDTRANS_API_BASE}/v2/${notif.order_id}/status`, {
            headers: { 'Authorization': authHeader }
        });
        const verifyData = await verifyRes.json();
        const txStatus   = verifyData.transaction_status;
        const fraudStatus = verifyData.fraud_status;

        // Tentukan status akhir
        let finalStatus = 'pending';
        if (SUCCESS_STATUSES.includes(txStatus)) {
            if (txStatus === 'capture') {
                finalStatus = fraudStatus === 'accept' ? 'paid' : 'fraud';
            } else {
                finalStatus = 'paid';
            }
        } else if (FAILED_STATUSES.includes(txStatus)) {
            finalStatus = 'failed';
        }

        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

        // Update status di tabel payments Supabase
        await supabase
            .from('payments')
            .update({
                status:                   finalStatus,
                midtrans_transaction_id:  verifyData.transaction_id,
                payment_method:           verifyData.payment_type,
                updated_at:               new Date().toISOString()
            })
            .eq('midtrans_order_id', notif.order_id);

        // Ambil order_number dari record payment
        const { data: paymentRecord } = await supabase
            .from('payments')
            .select('order_number')
            .eq('midtrans_order_id', notif.order_id)
            .single();

        const orderNumber = paymentRecord?.order_number;

        if (finalStatus === 'paid' && orderNumber) {
            const auth   = getGoogleAuth();
            const sheets = google.sheets({ version: 'v4', auth });

            // Update status di sheet ORDERS
            const ordersRes = await sheets.spreadsheets.values.get({
                spreadsheetId: SPREADSHEET_ID,
                range: 'ORDERS!A:C'
            });
            const ordersRows = ordersRes.data.values || [];
            let orderRowIndex = -1;
            for (let i = 1; i < ordersRows.length; i++) {
                if (ordersRows[i][1] === orderNumber) {
                    orderRowIndex = i + 1;
                    break;
                }
            }
            if (orderRowIndex > -1) {
                await sheets.spreadsheets.values.update({
                    spreadsheetId: SPREADSHEET_ID,
                    range: `ORDERS!C${orderRowIndex}`,
                    valueInputOption: 'RAW',
                    requestBody: { values: [['Dibayar']] }
                });
            }

            // Ambil items dari ORDER_ITEMS dan kurangi stok di PRODUCTS
            const itemsRes = await sheets.spreadsheets.values.get({
                spreadsheetId: SPREADSHEET_ID,
                range: 'ORDER_ITEMS!A:E'
            });
            const itemsRows = itemsRes.data.values || [];
            const orderItems = itemsRows
                .slice(1)
                .filter(row => row[0] === orderNumber)
                .map(row => ({ id: String(row[1]), qty: Number(row[3]) }));

            if (orderItems.length > 0) {
                const productsRes = await sheets.spreadsheets.values.get({
                    spreadsheetId: SPREADSHEET_ID,
                    range: 'PRODUCTS!A:H'
                });
                const productsRows = productsRes.data.values || [];
                const stokMap = {};
                productsRows.forEach((row, idx) => {
                    if (idx === 0) return;
                    stokMap[String(row[0])] = { rowIndex: idx + 1, stok: Number(row[7]) };
                });

                const updateRequests = [];
                for (const item of orderItems) {
                    const entry = stokMap[item.id];
                    if (entry) {
                        const stokBaru = Math.max(0, entry.stok - item.qty);
                        updateRequests.push({
                            range: `PRODUCTS!H${entry.rowIndex}`,
                            values: [[stokBaru]]
                        });
                    }
                }
                if (updateRequests.length > 0) {
                    await sheets.spreadsheets.values.batchUpdate({
                        spreadsheetId: SPREADSHEET_ID,
                        requestBody: { valueInputOption: 'RAW', data: updateRequests }
                    });
                }
            }

            console.log(`Order ${orderNumber} berhasil dibayar — stok diupdate`);
        }

        return res.status(200).json({ success: true, status: finalStatus });

    } catch (err) {
        console.error('Webhook Error:', err.message);
        // Tetap return 200 agar Midtrans tidak retry terus
        return res.status(200).json({ received: true, error: err.message });
    }
};
