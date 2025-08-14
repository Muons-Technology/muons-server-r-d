// server.js
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const os = require('os');
const { exec } = require('child_process');

const PORT = process.env.PORT || 5050;
const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
server.setTimeout(0); // Prevent automatic socket timeout

const wss = new WebSocket.Server({ server });

// userId => { ws, tailscaleIp, pingInterval }
let clients = new Map();

wss.on('connection', (ws) => {
  let userId = null;

  // 🔁 Keep connection alive with ping every 30s
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "ping" }));
    }
  }, 30000);

  ws.on('message', (message) => {
    const stringMessage = message.toString();
    console.log('📨 Received raw message:', stringMessage);

    try {
      const data = JSON.parse(stringMessage);
      console.log('🔍 Parsed message:', data);

      // ✅ Handle registration
      if (data.type === 'register') {
        userId = data.userId;
        const tailscaleIp = data.tailscaleIP && data.tailscaleIP !== 'null' ? data.tailscaleIP : 'N/A';

        const existingClient = clients.get(userId);
        if (existingClient && existingClient.ws.readyState === WebSocket.OPEN) {
          console.log(`⚠️ Duplicate registration attempt for userId: ${userId}`);
          ws.send(JSON.stringify({
            type: 'error',
            message: `User "${userId}" is already registered.`,
          }));
          return;
        } else {
          clients.delete(userId); // Clean stale client
        }

        clients.set(userId, { ws, tailscaleIp, pingInterval });
        console.log(`✅ Registered user: ${userId} (Tailscale IP: ${tailscaleIp})`);
        logConnectedUsers();

        ws.send(JSON.stringify({ type: 'registered', userId, tailscaleIp }));
        return;
      }

      // 💬 Handle message sending
      if (data.type === 'message') {
        console.log(`📩 Message received from ${data.from} → to ${data.to}: ${data.message}`);

        const recipient = clients.get(data.to);

        if (recipient && recipient.ws.readyState === WebSocket.OPEN) {
          recipient.ws.send(JSON.stringify({
            type: 'message',
            to: data.to,
            from: data.from,
            message: data.message,
            timestamp: data.timestamp,
          }));
          console.log(`📤 Message forwarded to ${data.to}`);
        } else {
          console.log(`📥 Recipient ${data.to} not connected — will implement delivery queue later`);
        }

        return;
      }

      // 🔄 Handle WebRTC signaling
      if (data.type === 'webrtc-signal') {
        const { from, to, data: signalData } = data;
        const recipient = clients.get(to);

        if (recipient && recipient.ws.readyState === WebSocket.OPEN) {
          recipient.ws.send(JSON.stringify({
            type: 'webrtc-signal',
            from,
            to,
            data: signalData,
          }));
          console.log(`📡 Relayed WebRTC signal (${signalData.type}) from ${from} to ${to}`);
        } else {
          console.log(`❌ Could not relay signal: recipient ${to} not connected`);
        }

        return;
      }

    } catch (err) {
      console.error('❌ Invalid JSON message received:', err.message);
    }
  });

  ws.on('close', () => {
    clearInterval(pingInterval);
    if (userId) {
      clients.delete(userId);
      console.log(`🔌 Disconnected: ${userId}`);
      logConnectedUsers();
    }
  });

  ws.on('error', (err) => {
    console.error(`❌ WebSocket error for user ${userId || 'unknown'}:`, err.message);
  });
});

function logConnectedUsers() {
  console.log("👥 Connected users:");
  for (const [uid, client] of clients.entries()) {
    console.log(` - ${uid} (${client.tailscaleIp}) | ReadyState: ${client.ws.readyState}`);
  }
}

// 🖥️ Show server's local IP addresses
function getServerIps() {
  const interfaces = os.networkInterfaces();
  const ips = [];

  Object.keys(interfaces).forEach((name) => {
    interfaces[name].forEach((iface) => {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push({ interface: name, address: iface.address });
      }
    });
  });

  return ips;
}

// 📡 Get IP route
app.get('/get-ip', (req, res) => {
  const serverIps = getServerIps();
  let clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
  if (clientIp.includes(',')) clientIp = clientIp.split(',')[0].trim();
  if (clientIp.startsWith('::ffff:')) clientIp = clientIp.replace('::ffff:', '');

  res.json({ serverIps, clientIp });
});

// 🧪 Ping test route
app.get('/ping', (req, res) => {
  const ip = req.query.ip;
  if (!ip) return res.status(400).json({ success: false, message: 'Missing IP address' });

  const platform = os.platform();
  const cmd = platform === 'win32' ? `ping -n 1 ${ip}` : `ping -c 1 ${ip}`;

  exec(cmd, (error, stdout, stderr) => {
    if (error) {
      console.error(`❌ Ping failed: ${stderr}`);
      return res.status(500).json({ success: false, message: 'Ping failed', error: stderr });
    }
    return res.json({ success: true, message: 'Ping successful', ip });
  });
});

// 🏁 Default route
app.get('/', (req, res) => {
  res.send('🚀 WebSocket signaling server is running!');
});

// 🚀 Start the server
server.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
  console.log(`🌐 WebSocket endpoint ws://localhost:${PORT}`);
});
