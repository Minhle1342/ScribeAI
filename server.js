/**
 * server.js
 * A high-performance real-time WebSocket STT Server.
 * Supports dual-mode:
 * 1. LIVE MODE (Deepgram Integration): Relays raw binary tab and microphone audio to the Deepgram Nova-2 
 *    engine for premium real-time Vietnamese/English speech-to-text.
 * 2. MOCK MODE (Fallback): If no Deepgram API key is provided, returns high-fidelity scrum dialogues 
 *    for offline extension testing.
 */

const WebSocket = require('ws');
const url = require('url');

const PORT = 8080;
const wss = new WebSocket.Server({ port: PORT });

// Retrieve the Deepgram API Key from the environment
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

console.log(`==================================================`);
if (DEEPGRAM_API_KEY) {
  console.log(`🎙️  LIVE MODE ACTIVE: Connected to Deepgram Nova-2 Speech-to-Text`);
} else {
  console.log(`📡 MOCK MODE ACTIVE: Running local intervals`);
  console.log(`💡 Tip: To translate your real voice, get a free key from deepgram.com and run:`);
  console.log(`   Windows (CMD):  set DEEPGRAM_API_KEY=your_key_here && node server.js`);
  console.log(`   Windows (PS):   $env:DEEPGRAM_API_KEY="your_key_here"; node server.js`);
}
console.log(`🎙️  WebSocket STT Server running on ws://localhost:${PORT}/stt`);
console.log(`Press Ctrl+C to terminate the server`);
console.log(`==================================================\n`);

// Curated dialogues for offline testing fallback
const simulatedDialogues = [
  "Chào mọi người, hôm nay chúng ta sẽ họp về tiến độ dự án Hệ Thống Doanh Thu và Chi Tiêu.",
  "Đầu tiên, về phần Backend, tôi đã hoàn thành cấu hình cơ sở dữ liệu PostgreSQL và tích hợp Redis cache.",
  "Tuyệt vời! Còn frontend thì sao? Giao diện quản lý hóa đơn đã đồng bộ xong chưa?",
  "Tôi đang gặp một chút lỗi đồng bộ ảnh hóa đơn (403 Forbidden). Tôi sẽ sửa cấu hình proxy trong nuxt.config.ts chiều nay.",
  "Được rồi, quyết định thống nhất là chúng ta sẽ dùng cổng API mới cho phần hóa đơn để tránh xung đột.",
  "Về Action Items: Nam sẽ sửa lỗi proxy Nuxt trước 5h chiều nay. Hoa sẽ chuẩn bị tài liệu API mới cho đối tác vào ngày mai.",
  "Còn phần bảo mật, chúng ta cần đảm bảo mã hóa API key của người dùng trước khi lưu trữ cục bộ.",
  "Cảm ơn mọi người, cuộc họp kết thúc tại đây. Chúc một ngày làm việc hiệu quả!"
];

wss.on('connection', (ws, req) => {
  console.log(`🔌 Client connected from: ${req.socket.remoteAddress}`);
  
  // Parse query parameters to read deepgramApiKey sent dynamically by Chrome extension
  const parsedUrl = url.parse(req.url, true);
  const clientDeepgramKey = parsedUrl.query.deepgramApiKey || DEEPGRAM_API_KEY;

  let dialogueInterval = null;
  let deepgramWs = null;

  // Initialize Deepgram WebSocket connection in LIVE MODE
  if (clientDeepgramKey) {
    try {
      console.log('🔗 Connecting to Deepgram live stream API with client key...');
      // Use Nova-2 model optimized for Vietnamese (vi) and smart formatting (punctuation, numbers)
      deepgramWs = new WebSocket('wss://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&language=vi', {
        headers: {
          Authorization: `Token ${clientDeepgramKey}`
        }
      });

      deepgramWs.on('open', () => {
        console.log('✅ Connected to Deepgram Streaming API successfully.');
      });

      deepgramWs.on('message', (data) => {
        try {
          const rawStr = data.toString();
          console.log(`[Deepgram Raw Response]: ${rawStr.substring(0, 200)}...`);

          const response = JSON.parse(data);
          const transcript = response.channel?.alternatives?.[0]?.transcript;
          const isFinal = response.is_final;
          
          if (transcript && transcript.trim() !== '') {
            console.log(`👉 [Live Transcribed] (Final: ${isFinal}): "${transcript}"`);
            // Stream the text directly back to the Chrome extension
            ws.send(JSON.stringify({ 
              text: transcript,
              isFinal: isFinal 
            }));
          }
        } catch (err) {
          console.error('Error parsing Deepgram transcription payload:', err);
        }
      });

      deepgramWs.on('error', (err) => {
        console.error('⚠️ Deepgram API WebSocket Error:', err.message);
      });

      deepgramWs.on('close', (code, reason) => {
        console.log(`🔌 Deepgram connection closed. Code: ${code}, Reason: ${reason || 'None'}`);
      });

    } catch (error) {
      console.error('❌ Failed to establish Deepgram connection:', error);
    }
  } else {
    console.log('📡 No Deepgram key supplied. Server will run in MOCK MODE for this client.');
  }

  // Handle incoming stream from the Chrome extension
  ws.on('message', (message) => {
    if (Buffer.isBuffer(message) || message instanceof ArrayBuffer) {
      // 1. LIVE MODE: Forward binary audio buffer to Deepgram
      if (deepgramWs && deepgramWs.readyState === WebSocket.OPEN) {
        console.log(`🔊 [Server] Received ${message.length} bytes of audio from extension. Forwarding to Deepgram.`);
        deepgramWs.send(message);
      } 
      // 2. MOCK MODE: Fallback to mock text interval simulation
      else if (!clientDeepgramKey && !dialogueInterval) {
        console.log(`🔵 Received binary audio stream. Starting simulated real-time transcription...`);
        let index = 0;
        dialogueInterval = setInterval(() => {
          if (index < simulatedDialogues.length) {
            const transcriptLine = simulatedDialogues[index];
            console.log(`👉 Transcribed (Mock): "${transcriptLine}"`);
            
            ws.send(JSON.stringify({ text: transcriptLine }));
            index++;
          } else {
            console.log("🏁 Simulated dialogues complete. Repeating sequence...");
            index = 0; // Loop dialogue for testing continuity
          }
        }, 4000);
      }
    }
  });

  ws.on('close', () => {
    console.log(`❌ Client disconnected.`);
    
    if (dialogueInterval) {
      clearInterval(dialogueInterval);
      dialogueInterval = null;
    }

    if (deepgramWs) {
      if (deepgramWs.readyState === WebSocket.OPEN || deepgramWs.readyState === WebSocket.CONNECTING) {
        deepgramWs.close();
      }
      deepgramWs = null;
    }
  });

  ws.on('error', (err) => {
    console.error(`⚠️ Server WebSocket Error:`, err.message);
  });
});
