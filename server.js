const express = require('express');
const twilio = require('twilio');
const WebSocket = require('ws');
const http = require('http');

const app = express();
const port = process.env.PORT || 3000;
const server = http.createServer(app);

app.use(express.json());
app.use(express.urlencoded({ extended: false })); // Twilio webhooks post form-encoded

const GEMINI_MODEL = 'models/gemini-3.1-flash-live-preview';
// Sanjay's phone — inbound callers pressing 0 get forwarded here.
const FORWARD_NUMBER = '+16472027681';

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

OUTBOUND RE-ENGAGEMENT CALLS (when this call was placed BY the school TO a student who has stopped attending lessons):
- This is an OUTBOUND call the school initiated. You are NOT answering an inbound question, so NEVER open with "How may I help you?" or any generic customer-service greeting.
- If a student name was provided for this call, open by greeting them BY NAME immediately, e.g.: "Hi [Name], this is My Driving School calling."
- State plainly and politely that you noticed they haven't been coming to their lessons.
- Ask them warmly to come back and continue their lessons, and let them know that if there's any problem (scheduling, cost, anything else) the school is happy to help sort it out.
- Keep this opening to 2-3 short, warm sentences, then pause and let the student respond.
- Only pivot into pricing/BDE Course details if the student asks about it or brings up starting fresh — don't lead an outbound re-engagement call with a sales pitch.
- Speak in the same greet-by-name, reactivation tone in whichever of English, Hindi, or Punjabi the student responds in.

LATENCY & PHONE CALL SYSTEM INSTRUCTIONS:
- You are configured as an ultra-low-latency real-time voice assistant.
- You MUST keep all verbal responses extremely short, punchy, conversational, and direct (ideally 1 to 2 brief sentences max).
- NEVER output bulleted lists, detailed tables, or long paragraphs of explanation. Be brief and let the user ask follow-up questions naturally.
- Keep your answers highly crisp and fast to start speaking.
`;

const SALES_INSTRUCTION = SYSTEM_INSTRUCTION + `

INBOUND SALES CALL (this session): a potential customer has called the school and chosen their language from the phone menu.
- You are the school's friendly SALES agent. Your goal is to warmly sell the school's programs, leading with the BDE Course value proposition when lessons come up.
- Early in the call, politely ask for the caller's name. Once you know it, address them by name naturally, and keep using their name — repeat it every two or three sentences.
- Near the start of the call, tell the caller: "You can press zero any time to talk to the driving instructor, Sanjay." If the call goes on, remind them once more later where it feels natural.
- Stay in the caller's chosen language for the entire call unless they switch languages themselves.
- Never say "How may I help you?" as a standalone cold opener — greet warmly as a salesperson welcoming a potential new student.
`;

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

app.get('/', (req, res) => {
  res.send('Server is running');
});

app.post('/make-call', async (req, res) => {
  try {
    const body = req.body || {};
    console.log('make-call request body:', JSON.stringify(body));
    // Accept the name under any of the field names client apps have used.
    const to = body.to || body.toPhone || body.phone || body.number;
    const studentName = body.studentName || body.student_name || body.name || body.student || '';
    if (!to) {
      return res.status(400).json({ success: false, error: '"to" (E.164 phone number) is required' });
    }
    const host = req.get('host');
    console.log(`Placing call to ${to}${studentName ? ` for student "${studentName}"` : ' (NO student name provided!)'}`);
    // Twilio drops query strings from Stream URLs; custom data must be passed
    // as <Parameter> elements, delivered in the start event's customParameters.
    const escapeXml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
    const paramXml = studentName ? `<Parameter name="studentName" value="${escapeXml(studentName)}" />` : '';
    const call = await client.calls.create({
      to,
      from: process.env.TWILIO_PHONE_NUMBER,
      twiml: `<Response><Connect><Stream url="wss://${host}/media-stream"><Parameter name="role" value="outbound" />${paramXml}</Stream></Connect></Response>`,
    });
    res.json({ success: true, callSid: call.sid });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Inbound calls to the Twilio number: language menu first.
// Point the Twilio phone number's Voice webhook at POST /incoming-call.
app.post('/incoming-call', (req, res) => {
  console.log('Incoming call from', req.body?.From);
  res.type('text/xml').send(`<Response>
  <Gather numDigits="1" action="/language-selected" method="POST" timeout="6">
    <Say>Welcome to My Driving School. For Hindi, press 1. For Punjabi, press 2. For English, press 3, or stay on the line.</Say>
  </Gather>
  <Redirect method="POST">/language-selected</Redirect>
</Response>`);
});

// After the caller picks a language, bridge them to the AI sales agent.
app.post('/language-selected', (req, res) => {
  const digit = (req.body?.Digits || '').trim();
  const language = digit === '1' ? 'Hindi' : digit === '2' ? 'Punjabi' : 'English';
  const host = req.get('host');
  console.log(`Inbound caller chose language: ${language} (digit: "${digit}")`);
  res.type('text/xml').send(`<Response><Connect><Stream url="wss://${host}/media-stream"><Parameter name="role" value="sales" /><Parameter name="language" value="${language}" /></Stream></Connect></Response>`);
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
  const callStart = Date.now();
  const elapsed = () => `${Date.now() - callStart}ms`;
  console.log(`[${elapsed()}] Twilio media stream connected`);
  // Twilio strips query strings from Stream URLs, so call context arrives via
  // <Parameter> elements in the start event's customParameters instead.
  let geminiWs = null;
  let studentName = null;
  let role = 'outbound';
  let language = null;
  let callSid = null;
  let streamSid = null;
  let geminiReady = false;
  let greetingSent = false;
  let forwarding = false;
  let firstAudioSentAt = null;
  let firstAudioReceivedAt = null;
  const pendingAudio = [];

  const greetingText = () => {
    if (role === 'sales') {
      return `(A potential customer just called My Driving School and chose ${language || 'English'} from the phone menu. Speak ${language || 'English'}. Greet them warmly as the school's sales agent, ask for their name, and mention they can press zero any time to talk to the driving instructor, Sanjay. Do NOT open with a bare "How may I help you?".)`;
    }
    return studentName
      ? `(This is an OUTBOUND call the school placed to ${studentName}, a student who has stopped attending lessons. Do NOT say "How may I help you?". Greet ${studentName} by name now, mention you noticed they haven't been coming to lessons, and warmly ask them to come back, offering help if there's any problem.)`
      : '(This is an OUTBOUND call the school placed to one of its students. Do NOT say "How may I help you?". Greet them now, mention you noticed they haven\'t been coming to lessons, and warmly ask them to come back, offering help if there\'s any problem.)';
  };

  // Gemini is connected only after Twilio's start event, so the session's
  // system instruction can match the call's role (outbound coach vs inbound sales).
  const connectGemini = () => {
    geminiWs = new WebSocket(
      `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${process.env.GOOGLE_API_KEY}`
    );

    geminiWs.on('open', () => {
      console.log(`[${elapsed()}] Gemini WS open (role: ${role})`);
      geminiWs.send(JSON.stringify({
        setup: {
          model: GEMINI_MODEL,
          generationConfig: { responseModalities: ['AUDIO'] },
          systemInstruction: { parts: [{ text: role === 'sales' ? SALES_INSTRUCTION : SYSTEM_INSTRUCTION }] },
        },
      }));
    });

    geminiWs.on('message', (data) => {
      const msg = JSON.parse(data.toString());

      if (msg.setupComplete) {
        geminiReady = true;
        console.log(`[${elapsed()}] Gemini setup complete`);
        while (pendingAudio.length && geminiWs.readyState === WebSocket.OPEN) {
          geminiWs.send(pendingAudio.shift());
        }
        if (!greetingSent) {
          greetingSent = true;
          firstAudioSentAt = Date.now();
          geminiWs.send(JSON.stringify({
            clientContent: {
              turns: [{ role: 'user', parts: [{ text: greetingText() }] }],
              turnComplete: true,
            },
          }));
          console.log(`[${elapsed()}] Greeting prompt sent to Gemini (role: ${role}${studentName ? `, student: ${studentName}` : ''}${language ? `, language: ${language}` : ''})`);
        }
        return;
      }

      if (!firstAudioReceivedAt && msg.serverContent?.modelTurn?.parts?.some(p => p.inlineData)) {
        firstAudioReceivedAt = Date.now();
        console.log(`[${elapsed()}] First audio chunk received from Gemini (${firstAudioReceivedAt - firstAudioSentAt}ms after greeting prompt)`);
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

    geminiWs.on('unexpected-response', (req2, response) => {
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
  };

  // Caller pressed 0: hand the live call off to Sanjay's phone.
  const forwardToSanjay = async () => {
    if (forwarding || !callSid) return;
    forwarding = true;
    console.log(`[${elapsed()}] Caller pressed 0 — forwarding call ${callSid} to ${FORWARD_NUMBER}`);
    try {
      await client.calls(callSid).update({
        twiml: `<Response><Say>Connecting you to Sanjay now.</Say><Dial>${FORWARD_NUMBER}</Dial></Response>`,
      });
    } catch (err) {
      forwarding = false;
      console.error('Failed to forward call:', err.message);
    }
  };

  twilioWs.on('message', (message) => {
    const data = JSON.parse(message.toString());

    switch (data.event) {
      case 'start': {
        streamSid = data.start.streamSid;
        callSid = data.start.callSid;
        const params = data.start.customParameters || {};
        studentName = params.studentName || null;
        role = params.role || 'outbound';
        language = params.language || null;
        console.log(`Stream started: ${streamSid} (role: ${role}${studentName ? `, student: ${studentName}` : ''}${language ? `, language: ${language}` : ''})`);
        connectGemini();
        break;
      }

      case 'media': {
        const mulaw = Buffer.from(data.media.payload, 'base64');
        const pcm8k = muLawBufferToPCM16(mulaw);
        const pcm16k = resamplePCM16(pcm8k, 8000, 16000);
        const payload = JSON.stringify({
          realtimeInput: {
            audio: { mimeType: 'audio/pcm;rate=16000', data: pcm16k.toString('base64') },
          },
        });
        if (geminiReady && geminiWs && geminiWs.readyState === WebSocket.OPEN) {
          geminiWs.send(payload);
        } else {
          pendingAudio.push(payload);
        }
        break;
      }

      case 'dtmf': {
        const digit = data.dtmf?.digit;
        console.log(`[${elapsed()}] DTMF received: ${digit}`);
        if (digit === '0') forwardToSanjay();
        break;
      }

      case 'stop':
        console.log('Stream stopped');
        if (geminiWs && geminiWs.readyState === WebSocket.OPEN) geminiWs.close();
        break;
    }
  });

  twilioWs.on('close', () => {
    console.log('Twilio media stream disconnected');
    if (geminiWs && geminiWs.readyState === WebSocket.OPEN) geminiWs.close();
  });
});

server.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
