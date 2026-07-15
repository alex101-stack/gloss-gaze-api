// /api/payment.js
// Generate Midtrans Snap token + simpan record payment ke Supabase
const { createClient } = require('@supabase/supabase-js');

const ALLOWED_ORIGIN  = process.env.ALLOWED_ORIGIN || '*';
const MIDTRANS_SERVER_KEY = process.env.MIDTRANS_SERVER_KEY;
const MIDTRANS_IS_PRODUCTION = process.env.MIDTRANS_IS_PRODUCTION === 'true';
const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const MIDTRANS_BASE_URL = MIDTRANS_IS_PRODUCTION
    ? 'https://app.midtrans.com/snap/v1/transactions'
    : 'https://app.sandbox.midtrans.com/snap/v1/transactions';

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
        const { order, userId } = req.body;

        if (!order || !order.orderNumber || !order.total || !order.items?.length) {
            return res.status(400).json({ error: 'Data order tidak valid' });
        }

        // Buat Midtrans order_id yang unik
        const midtransOrderId = `GG-${order.orderNumber}-${Date.now()}`;

        // Parameter untuk Midtrans Snap
        const snapPayload = {
            transaction_details: {
                order_id:     midtransOrderId,
                gross_amount: order.total
            },
            item_details: order.items.map(item => ({
                id:       String(item.id),
                name:     item.name.substring(0, 50), // Midtrans max 50 char
                price:    item.price,
                quantity: item.quantity
            })),
            customer_details: {
                first_name: order.buyerName || 'Pelanggan',
                phone:      order.buyerPhone || '',
                email:      order.buyerEmail || 'pelanggan@gloss.com'
            },
            callbacks: {
                finish: `${req.headers.origin || 'https://rias-wajahcantik.blogspot.com'}/?payment=finish`,
                error:  `${req.headers.origin || 'https://rias-wajahcantik.blogspot.com'}/?payment=error`,
                pending:`${req.headers.origin || 'https://rias-wajahcantik.blogspot.com'}/?payment=pending`
            }
        };

        // Request token ke Midtrans
        const authHeader = 'Basic ' + Buffer.from(MIDTRANS_SERVER_KEY + ':').toString('base64');
        const midtransRes = await fetch(MIDTRANS_BASE_URL, {
            method: 'POST',
            headers: {
                'Content-Type':  'application/json',
                'Authorization': authHeader
            },
            body: JSON.stringify(snapPayload)
        });

        const midtransData = await midtransRes.json();
        if (!midtransData.token) {
            throw new Error(midtransData.error_messages?.join(', ') || 'Gagal mendapat token Midtrans');
        }

        // Simpan record payment ke Supabase (status: pending)
        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
        await supabase.from('payments').insert({
            user_id:                userId || null,
            order_number:           order.orderNumber,
            midtrans_order_id:      midtransOrderId,
            amount:                 order.total,
            status:                 'pending',
            created_at:             new Date().toISOString()
        });

        return res.status(200).json({
            success:         true,
            snapToken:       midtransData.token,
            midtransOrderId: midtransOrderId,
            redirectUrl:     midtransData.redirect_url
        });

    } catch (err) {
        console.error('Payment API Error:', err.message);
        return res.status(500).json({
            error:  'Gagal membuat sesi pembayaran',
            detail: err.message
        });
    }
};
