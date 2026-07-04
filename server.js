const express = require('express');
const twilio = require('twilio');
const app = express();
const port = process.env.PORT || 3000;

const DESTINATION_NUMBER = '+16472027681';

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

app.get('/', (req, res) => {
  res.send('Server is running');
});

app.post('/make-call', async (req, res) => {
  try {
    const call = await client.calls.create({
      to: DESTINATION_NUMBER,
      from: process.env.TWILIO_PHONE_NUMBER,
      twiml: '<Response><Say>Hello, this is an automated call.</Say></Response>',
    });
    res.json({ success: true, callSid: call.sid });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
