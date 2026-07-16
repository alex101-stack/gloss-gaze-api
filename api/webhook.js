// /api/webhook.js — versi defensif
const crypto = require('crypto');

// Load dependencies secara defensif — tidak crash jika gagal
let google, createClient;
try {
    google = require('googleapis').google;
} catch(e) {
    console.error('googleapis tidak tersedia:', e.message);
}
try {
    createClient = require('@supabase/supabase-js').createClient;
} catch(e) {
    console.error('@supabase/supabase-js tidak tersedia:', e.message);
}

const MIDTRANS_SERVER_KEY    = process.env.MIDTRANS_SERVER_KEY || '';
const MIDTRANS_IS_PRODUCTION = process.env.MIDTRANS_IS_PRODUCTION === 'true';
const SPREADSHEET_ID         = process.env.SPREADSHEET_ID || '';
const SUPABASE_URL           = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const MIDTRANS_API_BASE = MIDTRANS_IS_PRODUCTION
    ? 'https://api.midtrans.com'
    : 'https://api.sandbox.midtrans.com';

const getGoogleAuth = () => {
    if (!google) throw new Error('googleapis tidak tersedia');
    return new google.auth.JWT({
        email: process.env.GOOGLE_CLIENT_EMAIL,
        key:   (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
};

const SUCCESS_STATUSES = ['capture', 'settlement'];
const FAILED_STATUSES  = ['deny', 'expire', 'cancel', 'failure'];

module.exports = async function handler(req, res) {

    // Handle GET — untuk tes browser dan Midtrans ping
    if (req.method === 'GET') {
        return res.status(200).json({
            status: 'ok',
            service: 'Gloss & Gaze Webhook',
            timestamp: new Date().toISOString(),
            env: {
                midtrans_key_set:    !!MIDTRANS_SERVER_KEY,
                spreadsheet_id_set:  !!SPREADSHEET_ID,
                supabase_url_set:    !!SUPABASE_URL,
                supabase_key_set:    !!SUPABASE_SERVICE_KEY,
                googleapis_loaded:   !!google,
                supabase_loaded:     !!createClient
            }
        });
    }

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
        const notif = req.body;
        console.log('Webhook received:', JSON.stringify(notif));

        if (!notif || !notif.order_id) {
            return res.status(400).json({ error: 'Payload tidak valid' });
        }

        // Verifikasi signature Midtrans
        const expectedSignature = crypto
            .createHash('sha512')
            .update(`${notif.order_id}${notif.status_code}${notif.gross_amount}${MIDTRANS_SERVER_KEY}`)
            .digest('hex');

        if (notif.signature_key !== expectedSignature) {
            console.error('Invalid signature');
            return res.status(403).json({ error: 'Invalid signature' });
        }

        // Verifikasi ulang ke Midtrans API
        const authHeader = 'Basic ' + Buffer.from(MIDTRANS_SERVER_KEY + ':').toString('base64');
        const verifyRes  = await fetch(`${MIDTRANS_API_BASE}/v2/${notif.order_id}/status`, {
            headers: { 'Authorization': authHeader }
        });
        const verifyData = await verifyRes.json();
        const txStatus   = verifyData.transaction_status;
        const fraudStatus = verifyData.fraud_status;

        // Tentukan status akhir
        let finalStatus = 'pending';
        if (SUCCESS_STATUSES.includes(txStatus)) {
            finalStatus = (txStatus === 'capture' && fraudStatus !== 'accept') ? 'fraud' : 'paid';
        } else if (FAILED_STATUSES.includes(txStatus)) {
            finalStatus = 'failed';
        }

        console.log(`Order ${notif.order_id} — status: ${finalStatus}`);

        // Update Supabase payments
        if (createClient && SUPABASE_URL && SUPABASE_SERVICE_KEY) {
            try {
                const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
                await supabase.from('payments').update({
                    status:                  finalStatus,
                    midtrans_transaction_id: verifyData.transaction_id,
                    payment_method:          verifyData.payment_type,
                    updated_at:              new Date().toISOString()
                }).eq('midtrans_order_id', notif.order_id);
                console.log('Supabase payments updated');
            } catch (supErr) {
                console.error('Supabase update gagal:', supErr.message);
                // Tidak fatal — lanjut proses Google Sheets
            }
        } else {
            console.warn('Supabase tidak tersedia — skip update payments');
        }

        // Update Google Sheets hanya jika paid
        if (finalStatus === 'paid' && google && SPREADSHEET_ID) {
            try {
                // Ambil order_number dari notif.order_id
                // Format: GG-{orderNumber}-{timestamp}
                const parts       = notif.order_id.split('-');
                const orderNumber = parts.length >= 3 ? `GG-${parts[1]}` : notif.order_id;

                const auth   = getGoogleAuth();
                const sheets = google.sheets({ version: 'v4', auth });

                // Update status ORDERS
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
                    console.log(`ORDERS baris ${orderRowIndex} → Dibayar`);
                } else {
                    console.warn(`Order ${orderNumber} tidak ditemukan di ORDERS sheet`);
                }

                // Kurangi stok dari ORDER_ITEMS
                const itemsRes = await sheets.spreadsheets.values.get({
                    spreadsheetId: SPREADSHEET_ID,
                    range: 'ORDER_ITEMS!A:E'
                });
                const itemsRows  = itemsRes.data.values || [];
                const orderItems = itemsRows
                    .slice(1)
                    .filter(row => row[0] === orderNumber)
                    .map(row => ({ id: String(row[1]), qty: Number(row[3]) }));

                console.log(`Items ditemukan untuk ${orderNumber}:`, orderItems.length);

                if (orderItems.length > 0) {
                    const productsRes  = await sheets.spreadsheets.values.get({
                        spreadsheetId: SPREADSHEET_ID,
                        range: 'PRODUCTS!A:H'
                    });
                    const productsRows = productsRes.data.values || [];
                    const stokMap      = {};
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
                                range:  `PRODUCTS!H${entry.rowIndex}`,
                                values: [[stokBaru]]
                            });
                            console.log(`Produk ${item.id}: stok ${entry.stok} → ${stokBaru}`);
                        }
                    }

                    if (updateRequests.length > 0) {
                        await sheets.spreadsheets.values.batchUpdate({
                            spreadsheetId: SPREADSHEET_ID,
                            requestBody: { valueInputOption: 'RAW', data: updateRequests }
                        });
                        console.log('Stok berhasil diupdate');
                    }
                }

            } catch (sheetsErr) {
                console.error('Google Sheets update gagal:', sheetsErr.message);
            }
        }

        return res.status(200).json({ success: true, status: finalStatus });

    } catch (err) {
        console.error('Webhook Error:', err.message, err.stack);
        // Selalu return 200 agar Midtrans tidak retry terus
        return res.status(200).json({ received: true, error: err.message });
    }
};
