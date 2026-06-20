// /api/track.js
// Silent analytics endpoint — catat views, saved, sold ke sheet ANALYTICS
// Fire-and-forget dari frontend, gagal tidak apa-apa
const { google } = require('googleapis');

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

const getAuthClient = () => new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
        const { productId, event } = req.body;
        // event: 'view' | 'saved' | 'sold'
        if (!productId || !event) return res.status(400).json({ error: 'productId dan event wajib' });

        const validEvents = ['view', 'saved', 'sold'];
        if (!validEvents.includes(event)) return res.status(400).json({ error: 'Event tidak valid' });

        const auth = getAuthClient();
        const sheets = google.sheets({ version: 'v4', auth });

        // Baca sheet ANALYTICS: A=productId, B=views, C=saved, D=sold, E=score
        const res2 = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'ANALYTICS!A:E'
        });

        const rows = res2.data.values || [];
        const headerRow = rows[0]; // ['productId','views','saved','sold','score']

        // Cari baris produk ini
        let targetRowIndex = -1;
        let currentData = { views: 0, saved: 0, sold: 0 };

        for (let i = 1; i < rows.length; i++) {
            if (String(rows[i][0]) === String(productId)) {
                targetRowIndex = i + 1; // 1-indexed untuk Sheets API
                currentData = {
                    views: Number(rows[i][1]) || 0,
                    saved: Number(rows[i][2]) || 0,
                    sold:  Number(rows[i][3]) || 0
                };
                break;
            }
        }

        // Increment kolom yang sesuai
        if (event === 'view')  currentData.views += 1;
        if (event === 'saved') currentData.saved += 1;
        if (event === 'sold')  currentData.sold  += 1;

        // Hitung score sederhana: (sold*5) + (saved*2) + (views*0.1)
        const score = (currentData.sold * 5) + (currentData.saved * 2) + (currentData.views * 0.1);

        if (targetRowIndex === -1) {
            // Produk belum ada di ANALYTICS — tambah baris baru
            await sheets.spreadsheets.values.append({
                spreadsheetId: SPREADSHEET_ID,
                range: 'ANALYTICS!A:E',
                valueInputOption: 'RAW',
                requestBody: {
                    values: [[
                        productId,
                        currentData.views,
                        currentData.saved,
                        currentData.sold,
                        score.toFixed(1)
                    ]]
                }
            });
        } else {
            // Update baris yang sudah ada
            await sheets.spreadsheets.values.update({
                spreadsheetId: SPREADSHEET_ID,
                range: `ANALYTICS!B${targetRowIndex}:E${targetRowIndex}`,
                valueInputOption: 'RAW',
                requestBody: {
                    values: [[
                        currentData.views,
                        currentData.saved,
                        currentData.sold,
                        score.toFixed(1)
                    ]]
                }
            });
        }

        return res.status(200).json({ success: true, event, productId });

    } catch (err) {
        console.error('Track API Error:', err.message);
        // Kembalikan 200 meski gagal — ini fire-and-forget, tidak boleh ganggu UX
        return res.status(200).json({ success: false, reason: err.message });
    }
};
