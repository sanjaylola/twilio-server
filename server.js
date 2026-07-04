const express = require('express');
const twilio = require('twilio');
const WebSocket = require('ws');
const http = require('http');

const app = express();
const port = process.env.PORT || 3000;
const server = http.createServer(app);

const DESTINATION_NUMBER = '+16472027681';
const GEMINI_MODEL = 'models/gemini-2.0-flash-live-001';

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

app.get('/', (req, res) => {
  res.send('Server is running');
});

app.post('/make-call', async (req, res) => {
  try {
    const host = req.get('host');
    const call = await client.calls.create({
      to: DESTINATION_NUMBER,
      from: process.env.TWILIO_PHONE_NUMBER,
      twiml: `<Response><Connect><Stream url="wss://${host}/media-stream" /></Connect></Response>`,
    });
    res.json({ success: true, callSid: call.sid });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// G.711 mu-law <-> PCM16 conversion (Twilio uses 8kHz mu-law)
function muLawDecodeSample(uVal) {
  uVal = ~uVal & 0xff;
  const sign = uVal & 0x80;
  const exponent = (uVal >> 4) & 0x07;
  const mantissa = uVal & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  return sign ? -sample : sample;
}

function muLawEncodeSample(sample) {
  const BIAS = 0x84;
  const CLIP = 32635;
  const sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

function muLawBufferToPCM16(buf) {
  const out = Buffer.alloc(buf.length * 2);
  for (let i = 0; i < buf.length; i++) {
    out.writeInt16LE(muLawDecodeSample(buf[i]), i * 2);
  }
  return out;
}

function pcm16BufferToMuLaw(buf) {
  const out = Buffer.alloc(Math.floor(buf.length / 2));
  for (let i = 0; i < out.length; i++) {
    out[i] = muLawEncodeSample(buf.readInt16LE(i * 2));
  }
  return out;
}

// Linear resampler for mono PCM16 between arbitrary sample rates
function resamplePCM16(buf, fromRate, toRate) {
  if (fromRate === toRate || buf.length < 2) return buf;
  const inSamples = buf.length / 2;
  const outSamples = Math.round(inSamples * (toRate / fromRate));
  const out = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    const srcIndex = (i * (inSamples - 1)) / Math.max(outSamples - 1, 1);
    const idx0 = Math.floor(srcIndex);
    const idx1 = Math.min(idx0 + 1, inSamples - 1);
    const frac = srcIndex - idx0;
    const s0 = buf.readInt16LE(idx0 * 2);
    const s1 = buf.readInt16LE(idx1 * 2);
    out.writeInt16LE(Math.round(s0 + (s1 - s0) * frac), i * 2);
  }
  return out;
}

// Bridges Twilio's Media Stream (8kHz mu-law) to the Gemini Live API (16kHz/24kHz PCM)
const wss = new WebSocket.Server({ server, path: '/media-stream' });

wss.on('connection', (twilioWs) => {
  console.log('Twilio media stream connected');
  let streamSid = null;
  let geminiReady = false;
  const pendingAudio = [];

  const geminiWs = new WebSocket(
    `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${process.env.GOOGLE_API_KEY}`
  );

  geminiWs.on('open', () => {
    geminiWs.send(JSON.stringify({
      setup: {
        model: GEMINI_MODEL,
        generationConfig: { responseModalities: ['AUDIO'] },
      },
    }));
  });

  geminiWs.on('message', (data) => {
    const msg = JSON.parse(data.toString());

    if (msg.setupComplete) {
      geminiReady = true;
      while (pendingAudio.length && geminiWs.readyState === WebSocket.OPEN) {
        geminiWs.send(pendingAudio.shift());
      }
      return;
    }

    const parts = msg.serverContent?.modelTurn?.parts;
    if (parts) {
      for (const part of parts) {
        if (part.inlineData?.data) {
          const pcm24k = Buffer.from(part.inlineData.data, 'base64');
          const pcm8k = resamplePCM16(pcm24k, 24000, 8000);
          const mulaw = pcm16BufferToMuLaw(pcm8k);
          if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
            twilioWs.send(JSON.stringify({
              event: 'media',
              streamSid,
              media: { payload: mulaw.toString('base64') },
            }));
          }
        }
      }
    }
  });

  geminiWs.on('unexpected-response', (req, response) => {
    let body = '';
    response.on('data', (chunk) => { body += chunk; });
    response.on('end', () => {
      console.error('Gemini WS rejected handshake:', response.statusCode, body);
    });
  });
  geminiWs.on('error', (err) => console.error('Gemini WS error:', err.message));
  geminiWs.on('close', (code, reason) => {
    console.log('Gemini WS closed:', code, reason?.toString());
  });

  twilioWs.on('message', (message) => {
    const data = JSON.parse(message.toString());

    switch (data.event) {
      case 'start':
        streamSid = data.start.streamSid;
        console.log('Stream started:', streamSid);
        break;

      case 'media': {
        const mulaw = Buffer.from(data.media.payload, 'base64');
        const pcm8k = muLawBufferToPCM16(mulaw);
        const pcm16k = resamplePCM16(pcm8k, 8000, 16000);
        const payload = JSON.stringify({
          realtimeInput: {
            mediaChunks: [{ mimeType: 'audio/pcm;rate=16000', data: pcm16k.toString('base64') }],
          },
        });
        if (geminiReady && geminiWs.readyState === WebSocket.OPEN) {
          geminiWs.send(payload);
        } else {
          pendingAudio.push(payload);
        }
        break;
      }

      case 'stop':
        console.log('Stream stopped');
        if (geminiWs.readyState === WebSocket.OPEN) geminiWs.close();
        break;
    }
  });

  twilioWs.on('close', () => {
    console.log('Twilio media stream disconnected');
    if (geminiWs.readyState === WebSocket.OPEN) geminiWs.close();
  });
});

server.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
