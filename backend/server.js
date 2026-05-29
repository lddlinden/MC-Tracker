const mqtt = require('mqtt');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
// Use global fetch if available (Node 18+). Otherwise dynamically import node-fetch.
let fetcher;
if (typeof fetch === 'function') {
  fetcher = fetch;
} else {
  fetcher = (...args) => import('node-fetch').then(m => m.default(...args));
}
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');

const app = express();
app.use(express.json());

// Begränsa inloggningsförsök (max 5 per 15 minuter per IP)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'För många inloggningsförsök, försök igen senare.' }
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET || 'supersecret';

const initDb = async (delayMs = 2000) => {
  const createSql = `
    CREATE TABLE IF NOT EXISTS positions (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMP WITH TIME ZONE,
      lat FLOAT,
      lng FLOAT,
      raw_data JSONB
    );

    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE,
      password_hash TEXT
    );
  `;

  while (true) {
    try {
      await pool.query(createSql);

      // Skapa användare från .env om de inte finns
      const initialUsers = [[process.env.ADMIN_USER || 'admin', process.env.ADMIN_PASS || 'mc-pass']];
      
      // Lägg till extra användare från formatet "user1:pass1,user2:pass2"
      if (process.env.EXTRA_USERS) {
        process.env.EXTRA_USERS.split(',').forEach(pair => {
          initialUsers.push(pair.split(':'));
        });
      }

      for (const [username, password] of initialUsers) {
        const userExists = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
        if (userExists.rows.length === 0) {
          const hash = await bcrypt.hash(password, 10);
          await pool.query('INSERT INTO users (username, password_hash) VALUES ($1, $2)', [username, hash]);
          console.log(`Användare skapad vid init: ${username}`);
        }
      }

      console.log('Database ready and table ensured');
      return;
    } catch (err) {
      console.log(`Database not ready, retrying in ${delayMs}ms: ${err.message}`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
};
initDb();

const authenticate = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Saknar token' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user_id = decoded.id;
    next();
  } catch { res.status(401).json({ error: 'Ogiltig token' }); }
};

// In-memory state för att spåra aktiva händelser per enhet och undvika dubbla aviseringar
const deviceEventStates = {}; // Format: { 'topic': { crash: 0, towing: 0 } }
const pendingCommandResponses = new Map();
const COMMAND_TOPIC = process.env.MQTT_COMMAND_TOPIC || 'teltonika/fmc880/commands';
const COMMAND_RESPONSE_TIMEOUT_MS = parseInt(process.env.COMMAND_RESPONSE_TIMEOUT_MS, 10) || 10000;

const createCorrelationId = () => {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `cid-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
};

const waitForCommandResponse = (correlationId) => new Promise((resolve) => {
  const timeout = setTimeout(() => {
    pendingCommandResponses.delete(correlationId);
    resolve(undefined);
  }, COMMAND_RESPONSE_TIMEOUT_MS);

  pendingCommandResponses.set(correlationId, {
    resolve: (url) => {
      clearTimeout(timeout);
      pendingCommandResponses.delete(correlationId);
      resolve(url);
    }
  });
});

const parseUrlFromResponse = (data) => {
  if (!data) return undefined;
  if (typeof data.url === 'string') return data.url;
  if (typeof data.URL === 'string') return data.URL;
  if (data.response?.url) return data.response.url;
  const rsp = data.RSP || data.rsp || data.Response;
  if (typeof rsp === 'string') {
    const match = rsp.match(/https?:\/\/[^"]+?(?=(?:\s|$|speed:|sp:|S:|C:))/i);
    return match?.[0];
  }
  return undefined;
};

const resolvePendingResponse = (responseUrl, correlationId) => {
  if (!responseUrl) return false;
  if (correlationId) {
    const pending = pendingCommandResponses.get(correlationId);
    if (pending) {
      pending.resolve(responseUrl);
      return true;
    }
  }

  const firstPending = pendingCommandResponses.values().next().value;
  if (firstPending) {
    firstPending.resolve(responseUrl);
    return true;
  }

  return false;
};

const requestGgpsUrl = async () => {
  const correlationId = createCorrelationId();
  // Vi skickar CMD: 'ggps' men behåller correlationId för intern matchning om svar kommer
  const commandPayload = { CMD: 'ggps', id: correlationId };

  return new Promise((resolve) => {
    const waitPromise = waitForCommandResponse(correlationId);
    mqttClient.publish(COMMAND_TOPIC, JSON.stringify(commandPayload), { qos: 0 }, (err) => {
      if (err) {
        console.error('[MQTT] Misslyckades skicka ggps-kommando:', err.message);
        resolve(undefined);
        return;
      }
      console.log(`[MQTT] Skickade ggps till ${COMMAND_TOPIC} (ID: ${correlationId})`);
    });
    waitPromise.then(resolve);
  });
};

const sendNotification = async (eventType, topic, reportedData, fullPayload, url) => {
  const HA_TOWING = process.env.HOME_ASSISTANT_WEBHOOK_TOWING;
  const HA_CRASH = process.env.HOME_ASSISTANT_WEBHOOK_CRASH;
  const HOME_ASSISTANT_WEBHOOK_URL = process.env.HOME_ASSISTANT_WEBHOOK_URL; // fallback for backward compatibility
  const TEXTBEE_API_KEY = process.env.TEXTBEE_API_KEY;
  const TEXTBEE_CHANNEL_ID = process.env.TEXTBEE_CHANNEL_ID;

  const ts = reportedData?.ts || fullPayload?.ts || new Date().toISOString();
  const latlng = reportedData?.latlng || fullPayload?.latlng || '';
  const [lat, lng] = latlng ? latlng.split(',') : ['', ''];

  // Använd Google Maps-länken från trackern om den finns, annars skapa en baserat på koordinaterna
  const finalUrl = url || (lat && lng ? `https://www.google.com/maps?q=${lat},${lng}` : null);

  const message = `MC Tracker Alert: ${eventType.toUpperCase()} detekterad på ${topic} kl ${new Date(ts).toLocaleString('sv-SE')}!`;

  // Choose the correct Home Assistant webhook URL per event type
  const webhookUrl = eventType === 'towing' ? HA_TOWING : (eventType === 'crash' ? HA_CRASH : HOME_ASSISTANT_WEBHOOK_URL);
  if (webhookUrl) {
    const notificationPayload = {
      event_type: `mc_tracker_${eventType}`,
      data: {
        topic: topic,
        detected_event: eventType,
        timestamp: ts,
        latitude: lat,
        longitude: lng,
        message: message,
        url: finalUrl,
        reported: reportedData,
        full_payload: fullPayload
      }
    };
    try {
      console.log(`[Notification] Skickar payload till HA (${eventType}):`, JSON.stringify(notificationPayload, null, 2));
      await fetcher(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(notificationPayload)
      });
      console.log(`[Notification] Home Assistant webhook skickad för ${eventType}. url=${webhookUrl}`);
    } catch (error) {
      console.error(`[Notification] Misslyckades skicka Home Assistant webhook för ${eventType}:`, error.message);
    }
  }

  // Textbee.dev Notification (unchanged)
  if (TEXTBEE_API_KEY && TEXTBEE_CHANNEL_ID) {
    try {
      await fetcher(`https://textbee.dev/api/v1/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': TEXTBEE_API_KEY
        },
        body: JSON.stringify({
          channel_id: TEXTBEE_CHANNEL_ID,
          message: message,
          title: `MC Tracker ${eventType.toUpperCase()}!`,
          priority: 1 // Hög prioritet
        })
      });
      console.log(`[Notification] Textbee.dev avisering skickad för ${eventType}.`);
    } catch (error) {
      console.error(`[Notification] Misslyckades skicka Textbee.dev avisering för ${eventType}:`, error.message);
    }
  }
};

const mqttClient = mqtt.connect(process.env.MQTT_URL || 'mqtt://mqtt:1883');

mqttClient.on('error', (err) => {
  console.error('[MQTT] Anslutningsfel:', err.message);
});

mqttClient.on('reconnect', () => {
  console.log('[MQTT] Försöker ansluta igen...');
});

mqttClient.on('connect', () => {
  // Vi prenumererar på båda varianterna (med/utan ledande slash) för att vara säkra
  mqttClient.subscribe('teltonika/fmc880/#');
  mqttClient.subscribe('/teltonika/fmc880/#');
  console.log('[MQTT] Ansluten! Prenumererar på: teltonika/fmc880/#');
});

mqttClient.on('message', async (topic, message) => {
  const rawPayload = message.toString();
  console.log(`[MQTT] Nytt råmeddelande på ${topic}: ${rawPayload}`);

  try {
    const data = JSON.parse(rawPayload);
    const correlationId = data?.correlationId || data?.correlator || data?.id;
    const responseUrl = parseUrlFromResponse(data);
    if (responseUrl) {
      const resolved = resolvePendingResponse(responseUrl, correlationId);
      if (resolved) {
        console.log(`[MQTT] Mottog URL-svar för correlationId=${correlationId || 'unknown'}: ${responseUrl}`);
        // Response-only MQTT message; do not parse position data.
        return;
      }
    }

    // Ignorera meddelanden på command-topicen för att undvika att tolka ekon av egna kommandon
    if (topic.includes('/commands')) {
      return;
    }

    // Försök hitta positionen i JSON-strukturen
    // Vi kollar både efter 'state.reported' (AWS format) och direkt i roten (Teltonika/Generic format)
    const reported = data.state?.reported || data; 
    
    if (!reported || !reported.latlng) {
      console.error("[Parser] Fel: Hittade ingen 'latlng' (t.ex. \"56.8,14.8\") i JSON-objektet");
      return;
    }

    const [lat, lng] = reported.latlng.split(',').map(Number);
    
    // Hantera både numeriska timestamps och strängar
    const timestampValue = reported.ts;
    const tsDate = new Date(timestampValue);
    if (isNaN(tsDate.getTime())) {
      console.error("[Parser] Fel: Ogiltig timestamp:", timestampValue);
      return;
    }

    // --- Händelsedetektering för aviseringar ---
    // FMC880/FMBXXX: Towing (246) and Crash Detection (247).
    // Crash: 1-6 are valid crash events (7-8 are fake/potholes).
    const crashDetected = (reported['247'] >= 1 && reported['247'] <= 6);
    const towingDetected = (reported['246'] === 1);

    // Initiera tillstånd för denna topic om det inte finns
    if (!deviceEventStates[topic]) {
      deviceEventStates[topic] = { crash: 0, towing: 0 };
    }

    // Kontrollera Crash Detection (evt 247)
    if (crashDetected && deviceEventStates[topic].crash !== 1) {
      console.log(`[Event] Crash Detected för ${topic}!`);
      const responseUrl = await requestGgpsUrl();
      await sendNotification('crash', topic, reported, data, responseUrl);
      deviceEventStates[topic].crash = 1; // Uppdatera tillstånd
    } else if (!crashDetected && deviceEventStates[topic].crash === 1) {
      deviceEventStates[topic].crash = 0; // Återställ tillstånd när händelsen upphör
    }

    // Kontrollera Towing Detection (ID 246)
    if (towingDetected && deviceEventStates[topic].towing !== 1) {
      console.log(`[Event] Towing Detected för ${topic}!`);
      const responseUrl = await requestGgpsUrl();
      await sendNotification('towing', topic, reported, data, responseUrl);
      deviceEventStates[topic].towing = 1; // Uppdatera tillstånd
    } else if (!towingDetected && deviceEventStates[topic].towing === 1) {
      deviceEventStates[topic].towing = 0; // Återställ tillstånd när händelsen upphör
    }
    // --- Slut på händelsedetektering ---

    try {
      // Skydd mot 0,0 koordinater (nollmeridianen/ekvatorn) vid bristande GPS-fix.
      // Detta förhindrar felaktig statistik och linjer som dras till havet utanför Afrika.
      if (lat === 0 && lng === 0) {
        console.log(`[Parser] Ignorerar position (0,0) för ${topic} - väntar på giltig GPS-fix.`);
        return;
      }

      // Förhindra dubbletter: Kolla om senaste sparade punkt för denna enhet har samma timestamp
      const lastPos = await pool.query('SELECT ts FROM positions ORDER BY ts DESC LIMIT 1');
      if (lastPos.rows.length > 0 && new Date(lastPos.rows[0].ts).getTime() === tsDate.getTime()) {
        return; // Hoppa över om vi redan har denna tidpunkt
      }

      await pool.query(
        'INSERT INTO positions (ts, lat, lng, raw_data) VALUES ($1, $2, $3, $4)',
        [tsDate, lat, lng, data]
      );
      console.log(`Position sparad: ${lat}, ${lng} (Tid: ${tsDate.toISOString()})`);
      io.emit('position-update', { ts: tsDate.toISOString(), lat, lng, raw_data: data });
    } catch (dbErr) {
      console.error("[Database] Fel vid INSERT:", dbErr.message);
    }

  } catch (err) {
    console.error("KRITISKT FEL i MQTT-hanterare:", err.message);
  }
});

app.post('/api/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Fel användarnamn eller lösenord' });
    }

    const user = result.rows[0];
    const isMatch = await bcrypt.compare(password, user.password_hash);

    if (isMatch) {
      const token = jwt.sign({ user: user.username, id: user.id }, JWT_SECRET, { expiresIn: '24h' });
      return res.json({ token });
    }
    res.status(401).json({ error: 'Fel användarnamn eller lösenord' });
  } catch (err) {
    res.status(500).json({ error: 'Serverfel vid inloggning' });
  }
});

app.post('/api/update-password', authenticate, async (req, res) => {
  const { newPassword } = req.body;
  const userId = req.user_id; // Vi behöver uppdatera authenticate för att sätta detta
  try {
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, userId]);
    res.json({ message: 'Lösenordet har uppdaterats' });
  } catch (err) {
    res.status(500).json({ error: 'Kunde inte uppdatera lösenordet' });
  }
});

app.get('/api/history', authenticate, async (req, res) => {
  const { start, end } = req.query;
  // Lägg till tid för att inkludera hela slutdagen (t.ex. 2026-05-28 23:59:59)
  const adjustedEnd = end.includes('T') ? end : `${end} 23:59:59`;
  const result = await pool.query(
    'SELECT * FROM positions WHERE ts BETWEEN $1 AND $2 ORDER BY ts ASC',
    [start, adjustedEnd]
  );
  res.json(result.rows);
});

app.get('/api/stats/distance', authenticate, async (req, res) => {
  const { days } = req.query;
  const query = `SELECT SUM(dist) as total_distance FROM (SELECT ST_DistanceSphere(ST_MakePoint(lng, lat), LAG(ST_MakePoint(lng, lat)) OVER (ORDER BY ts)) as dist FROM positions WHERE ts > NOW() - interval '${days} days') sub;`;
  const result = await pool.query(query);
  res.json(result.rows[0]);
});

server.listen(3001, '0.0.0.0', () => console.log('Backend körs på port 3001'));