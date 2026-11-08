import { neon } from '@neondatabase/serverless';
import { createHmac, timingSafeEqual } from 'node:crypto';

const headers = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type, authorization',
  'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS'
};
const reply = (statusCode, body) => ({ statusCode, headers, body: JSON.stringify(body) });
const sql = () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL belum diatur di Netlify.');
  return neon(process.env.DATABASE_URL);
};
const sign = (value) => createHmac('sha256', process.env.KPSKT_SESSION_SECRET || '').update(value).digest('hex');
const tokenFor = (username) => {
  const payload = Buffer.from(JSON.stringify({ username, exp: Date.now() + 8 * 60 * 60 * 1000 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
};
function isAdmin(event) {
  const token = (event.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const [payload, signature] = token.split('.');
  if (!payload || !signature || !process.env.KPSKT_SESSION_SECRET) return false;
  const expected = sign(payload);
  try {
    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data.username === (process.env.KPSKT_ADMIN_USERNAME || 'admin') && data.exp > Date.now();
  } catch { return false; }
}
async function sendTemplate(to, templateName, bodyParameters = []) {
  if (!process.env.WHATSAPP_TOKEN || !process.env.WHATSAPP_PHONE_NUMBER_ID || !templateName || !to) return { skipped: true, reason: 'WhatsApp belum dikonfigurasi lengkap.' };
  const version = process.env.WHATSAPP_GRAPH_VERSION || 'v22.0';
  const payload = { messaging_product: 'whatsapp', to: String(to).replace(/\D/g, ''), type: 'template', template: { name: templateName, language: { code: 'id' }, components: bodyParameters.length ? [{ type: 'body', parameters: bodyParameters.map(text => ({ type: 'text', text: String(text) })) }] : [] } };
  const response = await fetch(`https://graph.facebook.com/${version}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, { method: 'POST', headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || 'WhatsApp API gagal mengirim pesan.');
  return { sent: true, id: data?.messages?.[0]?.id };
}

export default async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  try {
    const path = event.queryStringParameters?.action || '';
    const method = event.httpMethod;
    const body = event.body ? JSON.parse(event.body) : {};
    if (path === 'login' && method === 'POST') {
      const username = process.env.KPSKT_ADMIN_USERNAME || 'admin';
      if (!process.env.KPSKT_ADMIN_PASSWORD || !process.env.KPSKT_SESSION_SECRET) return reply(503, { error: 'Atur KPSKT_ADMIN_PASSWORD dan KPSKT_SESSION_SECRET di Netlify terlebih dahulu.' });
      if (body.username !== username || body.password !== process.env.KPSKT_ADMIN_PASSWORD) return reply(401, { error: 'Username atau password salah.' });
      return reply(200, { token: tokenFor(username) });
    }
    if (path === 'register' && method === 'POST') {
      const { owner, phone, address, district, cats } = body;
      if (!owner || !phone || !address || !district || !Array.isArray(cats) || !cats.length) return reply(400, { error: 'Data pendaftaran belum lengkap.' });
      if (cats.some(c => !c.name || !['Betina', 'Jantan'].includes(c.sex) || !c.age)) return reply(400, { error: 'Data setiap kucing harus lengkap.' });
      const db = sql();
      const rows = await db`INSERT INTO registrations (owner, phone, address, district, cats) VALUES (${owner}, ${phone}, ${address}, ${district}, ${JSON.stringify(cats)}::jsonb) RETURNING id, owner, phone, address, district, cats, created_at`;
      let wa = { skipped: true };
      try { wa = await sendTemplate(process.env.WHATSAPP_ADMIN_NUMBER, process.env.WHATSAPP_REGISTRATION_TEMPLATE, [owner, phone, String(cats.length)]); } catch (e) { wa = { sent: false, error: e.message }; }
      return reply(201, { registration: rows[0], whatsapp: wa });
    }
    if (!isAdmin(event)) return reply(401, { error: 'Akses admin diperlukan.' });
    const db = sql();
    if (path === 'registrations' && method === 'GET') {
      const rows = await db`SELECT id, owner, phone, address, district, cats, created_at AS created FROM registrations ORDER BY created_at DESC`;
      return reply(200, { data: rows });
    }
    if (path === 'history' && method === 'GET') {
      const rows = await db`SELECT id, owner, phone, address, district, count, created_at AS created FROM sterilized_history ORDER BY created_at DESC`;
      return reply(200, { data: rows });
    }
    if (path === 'history' && method === 'POST') {
      const { owner, phone, address, district, count } = body;
      if (!owner || !phone || !address || !district || !Number.isInteger(Number(count)) || Number(count) < 1) return reply(400, { error: 'Data riwayat belum lengkap.' });
      const rows = await db`INSERT INTO sterilized_history (owner, phone, address, district, count) VALUES (${owner}, ${phone}, ${address}, ${district}, ${Number(count)}) RETURNING *`;
      return reply(201, { data: rows[0] });
    }
    if (path === 'settings' && method === 'GET') {
      const rows = await db`SELECT schedule_date AS date, schedule_time AS time, location, duration FROM app_settings WHERE id=1`;
      return reply(200, { data: rows[0] || { duration: 90 } });
    }
    if (path === 'settings' && method === 'PUT') {
      const { date, time, location } = body;
      if (!date || !time || !location) return reply(400, { error: 'Tanggal, jam, dan lokasi wajib diisi.' });
      const rows = await db`UPDATE app_settings SET schedule_date=${date}, schedule_time=${time}, location=${location}, duration=90, updated_at=NOW() WHERE id=1 RETURNING schedule_date AS date, schedule_time AS time, location, duration`;
      return reply(200, { data: rows[0] });
    }
    if (path === 'delete' && method === 'POST') {
      const table = body.kind === 'new' ? 'registrations' : body.kind === 'old' ? 'sterilized_history' : null;
      if (!table || !Number.isInteger(Number(body.id))) return reply(400, { error: 'Permintaan hapus tidak valid.' });
      if (table === 'registrations') await db`DELETE FROM registrations WHERE id=${Number(body.id)}`;
      else await db`DELETE FROM sterilized_history WHERE id=${Number(body.id)}`;
      return reply(200, { ok: true });
    }
    if (path === 'schedule-send' && method === 'POST') {
      const { phone, owner, date, time, location, cats } = body;
      const wa = await sendTemplate(phone, process.env.WHATSAPP_SCHEDULE_TEMPLATE, [owner, date, time, location, (cats || []).map(c => c.name).join(', ')]);
      return reply(200, { whatsapp: wa });
    }
    return reply(404, { error: 'Rute tidak ditemukan.' });
  } catch (error) {
    console.error('KPSKT API error:', error);
    return reply(500, { error: error.message || 'Terjadi kesalahan server.' });
  }
};
