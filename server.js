const express = require('express');
const twilio = require('twilio');
const WebSocket = require('ws');
const http = require('http');

const app = express();
const port = process.env.PORT || 3000;
const server = http.createServer(app);

const DESTINATION_NUMBER = '+16472027681';
const GEMINI_MODEL = 'models/gemini-3.1-flash-live-preview';

const SYSTEM_INSTRUCTION = `
You are the voice agent for "My Driving School".
Your tone is professional, encouraging, friendly, and patient.

CRITICAL: Do not use any Markdown formatting like asterisks (**) or underscores (_) for emphasis in your responses.
Speak in plain text only.

MULTILINGUAL SUPPORT MANDATE:
- You fully understand and speak three languages fluently: English, Hindi (हिंदी), and Punjabi (ਪੰਜਾਬੀ).
- Seamlessly transition and reply in whichever language (english, hindi, or punjabi) the user speaks or requests.
- Ensure your spoken response matches the language the user is speaking (e.g., if the user speaks Hindi, respond in Hindi; if the user speaks Punjabi, respond in Punjabi; if the user speaks English, respond in English).
- Do not translate non-translatable proper nouns or driving terms if it sounds unnatural in Hindi/Punjabi, but make sure the sentence structure is correct, natural, and fluent.

Detailed Programs and Fees (from My Driving School):
- BDE Course (MTO Approved): $649 plus HST. Includes 20 hours online, 10 hours of home link, and 10 hours of in-car training.

CORE BDE COURSE BENEFITS (EMPHASIZE THESE):
1. REDUCED WAIT TIME: Graduates can take their G2 road test in just 8 months instead of the usual 12 months. This saves them 4 months of waiting.
2. INSURANCE DISCOUNTS: Upon completion, students receive an MTO Driver's License history (DLH) certificate which qualifies them for significant discounts on auto insurance premiums.
3. COMPREHENSIVE TRAINING: Includes both theoretical (online) and practical (in-car) training to ensure they become safe, skilled drivers.

Individual Lessons:
- 1 Lesson (1 hour): $65
- 5 Lessons Package: $310
- 10 Lessons Package: $600

Road Test Packages (Local):
- G2 Road Test Package: $180 (Includes pickup, drop off, and 1-hour warm-up lesson).
- G Road Test Package: $200 (Includes pickup, drop off, and 1-hour warm-up lesson).

FAQ KNOWLEDGE BASE:
- OPERATING HOURS: 7 a.m. to 9 p.m., seven days a week.
- PICKUP: Free door-to-door pickup and drop-off from home, school, or work for all in-car lessons.
- CARS: Late-model vehicles with dual-brake systems for maximum safety.

Your Goal:
- Act as a proactive advisor. Whenever someone asks about lessons or starting out, enthusiastically explain the BDE Course benefits first in their language.
- For English queries, clearly state: "The BDE course is our most popular program because it cuts your road test waiting time from twelve months down to eight, and it can save you hundreds on your car insurance."
- Translate this exact value proposition accurately and naturally in Hindi or Punjabi (e.g., in Hindi: "हमारा बी डी ई (BDE) कोर्स हमारा सबसे लोकप्रिय प्रोग्राम है क्योंकि यह आपके रोड टेस्ट के इंतजार समय को बारह महीने से घटाकर आठ महीने कर देता है, और इससे आपको कार इंश्योरेंस पर भी काफी छूट मिल सकती है।", or in Punjabi: ...)
- Keep responses concise, friendly, and patient in all three languages.

LATENCY & PHONE CALL SYSTEM INSTRUCTIONS:
- You are configured as an ultra-low-latency real-time voice assistant.
- You MUST keep all verbal responses extremely short, punchy, conversational, and direct (ideally 1 to 2 brief sentences max).
- NEVER output bulleted lists, detailed tables, or long paragraphs of explanation. Be brief and let the user ask follow-up questions naturally.
- Keep your answers highly crisp and fast to start speaking.
`;

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
        systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
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
      // Prompt an immediate greeting so the caller doesn't hear dead air
      // while waiting for Gemini's handshake to finish.
      geminiWs.send(JSON.stringify({
        clientContent: {
          turns: [{ role: 'user', parts: [{ text: '(The call has just connected. Greet the caller briefly now.)' }] }],
          turnComplete: true,
        },
      }));
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
            audio: { mimeType: 'audio/pcm;rate=16000', data: pcm16k.toString('base64') },
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
