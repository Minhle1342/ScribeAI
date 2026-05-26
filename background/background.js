/**
 * background/background.js
 * Manifest V3 Service Worker.
 * Manages offscreen recording lifecycles, keep-alive heartbeat, tab audio streams,
 * and orchestrates IndexedDB aggregation and Gemini summarizations.
 */

importScripts('../services/db.js', '../services/geminiService.js');

let activeRecordingTabId = null;
let currentRecordingState = 'IDLE'; // IDLE | RECORDING | SUMMARIZING | COMPLETED | ERROR
let keepAliveIntervalId = null;

// Initialize state in local storage on startup
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    recordingState: 'IDLE',
    websocketUrl: 'ws://localhost:8080/stt',
    finalSummary: null
  });
  console.log('Gemini Meeting Recorder Service Worker Initialized.');
});

// Listen to storage changes to track rolling summarization progress and broadcast percentages
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.summaryProgress) {
    const progress = changes.summaryProgress.newValue;
    if (progress && progress.totalChunks) {
      const percent = Math.round((progress.currentChunk / progress.totalChunks) * 100);
      console.log(`[Summarization Progress Broadcast] Chunk ${progress.currentChunk}/${progress.totalChunks} finished (${percent}%)`);
      
      // Broadcast SUMMARIZATION_PROGRESS internally to popup/other contexts
      chrome.runtime.sendMessage({
        action: 'SUMMARIZATION_PROGRESS',
        progress: progress,
        percent: percent
      }).catch(() => {}); // ignore errors when popup is closed

      // Relay progress update to active tabs if recording
      if (activeRecordingTabId) {
        chrome.tabs.sendMessage(activeRecordingTabId, {
          action: 'SUMMARIZATION_PROGRESS',
          progress: progress,
          percent: percent
        }).catch(() => {});
      }
    }
  }
});


// Configure periodic alarms to prevent Service Worker sleep cycle during long recordings
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAliveAlarm') {
    console.log('[Heartbeat] Alarm received - refreshing Service Worker context.');
    // Simple ping to storage to reset background timer
    chrome.storage.local.get(['recordingState'], (data) => {
      console.log('[Heartbeat] State check:', data.recordingState);
    });
  }
});

/**
 * Enable alarm-based active keep-alive cycles.
 */
function startKeepAliveHeartbeat() {
  // Create an alarm to trigger every 1 minute
  chrome.alarms.create('keepAliveAlarm', { periodInMinutes: 1 });

  // Additional port-based connection heartbeat for deep reliability
  if (keepAliveIntervalId) clearInterval(keepAliveIntervalId);
  keepAliveIntervalId = setInterval(() => {
    console.log('[Heartbeat] Sending internal keep-alive pulse...');
    chrome.runtime.getPlatformInfo(() => {});
  }, 15000); // Pulse every 15s
}

/**
 * Terminate alarm-based keep-alive cycles to save browser resources.
 */
function stopKeepAliveHeartbeat() {
  chrome.alarms.clear('keepAliveAlarm');
  if (keepAliveIntervalId) {
    clearInterval(keepAliveIntervalId);
    keepAliveIntervalId = null;
  }
}

/**
 * Handle persistent connection ports for real-time token streaming.
 */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'gemini-vision-stream') {
    port.onMessage.addListener(async (message) => {
      const controller = new AbortController();
      
      // Auto-abort network request if the port is disconnected (e.g. user closes tooltip)
      port.onDisconnect.addListener(() => {
        controller.abort();
      });

      try {
        const apiKey = await self.geminiService.getSavedApiKey();
        if (!apiKey) {
          throw new Error('API Key không tồn tại. Vui lòng thiết lập API Key trong cài đặt extension.');
        }

        const model = await self.geminiService.getSavedModel();
        const visionModel = model.includes('flash') ? model : 'gemini-1.5-flash';
        
        // Use streamGenerateContent endpoint
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${visionModel}:streamGenerateContent?key=${apiKey}`;

        const payload = {
          contents: [
            {
              parts: [
                {
                  text: message.prompt
                },
                {
                  inlineData: {
                    mimeType: "image/jpeg",
                    data: message.base64Image
                  }
                }
              ]
            }
          ],
          generationConfig: {
            temperature: 0.2,
            topP: 0.95,
            maxOutputTokens: 1024
          }
        };

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload),
          signal: controller.signal
        });

        if (!response.ok) {
          let errorMsg = `Lỗi hệ thống (${response.status}): Không thể kết nối với Gemini.`;
          if (response.status === 403) {
            errorMsg = 'Khóa API Gemini không hợp lệ hoặc đã hết hạn. Vui lòng kiểm tra lại cấu hình.';
          } else if (response.status === 429) {
            errorMsg = 'Tần suất gửi yêu cầu quá nhanh. Bạn đã vượt quá giới hạn (Rate Limit) của API Gemini.';
          } else if (response.status === 400) {
            errorMsg = 'Yêu cầu không hợp lệ. Có thể ảnh quá lớn hoặc thông tin định dạng không đúng.';
          } else if (response.status >= 500) {
            errorMsg = 'Máy chủ Gemini đang quá tải hoặc gặp lỗi. Vui lòng thử lại sau.';
          } else {
            try {
              const errorJson = await response.json();
              if (errorJson.error && errorJson.error.message) {
                errorMsg = errorJson.error.message;
              }
            } catch (_) {}
          }
          throw new Error(errorMsg);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          let braceCount = 0;
          let startIndex = -1;

          for (let i = 0; i < buffer.length; i++) {
            if (buffer[i] === '{') {
              if (braceCount === 0) {
                startIndex = i;
              }
              braceCount++;
            } else if (buffer[i] === '}') {
              braceCount--;
              if (braceCount === 0 && startIndex !== -1) {
                const jsonString = buffer.substring(startIndex, i + 1);
                try {
                  const chunkJson = JSON.parse(jsonString);
                  const textToken = chunkJson.candidates?.[0]?.content?.parts?.[0]?.text;
                  if (textToken) {
                    port.postMessage({ success: true, token: textToken });
                  }
                } catch (e) {
                  console.warn("Failed to parse partial JSON chunk:", e);
                }
                buffer = buffer.substring(i + 1);
                i = -1;
                startIndex = -1;
              }
            }
          }
        }

        port.postMessage({ success: true, done: true });
      } catch (err) {
        if (err.name !== 'AbortError') {
          let msg = err.message;
          if (err.name === 'AbortError') {
            msg = 'Yêu cầu phân tích ảnh bị quá thời gian (Timeout). Vui lòng kiểm tra kết nối mạng của bạn.';
          }
          port.postMessage({ success: false, error: msg });
        }
      }
    });
  }
});

/**
 * Handle incoming messages from Content Script or Popup UI.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('Background received message:', message);

  const asyncActions = [
    'START_RECORDING_REQUEST',
    'TOGGLE_PAUSE_REQUEST',
    'STOP_RECORDING_REQUEST',
    'RUN_SUMMARIZATION_REQUEST',
    'RESET_MEETING_SESSION',
    'CANCEL_RECORDING_REQUEST',
    'CAPTURE_VISIBLE_TAB',
    'GEMINI_VISION_REQUEST',
    'GET_SOP_SUGGESTION'
  ];

  const isAsync = asyncActions.includes(message.action);

  (async () => {
    try {
      await hydrateSessionContext();

      // Guard check to prevent race conditions or invalid FSM transitions
      if (!canTransitionTo(message.action, currentRecordingState)) {
        throw new Error(`Cannot execute action ${message.action} while in state ${currentRecordingState}`);
      }

      await handleMessageAsync(message, sender, sendResponse);
    } catch (err) {
      console.error(`Error handling message action: ${message.action}`, err);
      if (isAsync) {
        sendResponse({ success: false, error: err.message });
      }
    }
  })();

  return isAsync;
});

/**
 * Validates transition rules to guard background state machine.
 */
function canTransitionTo(action, currentState) {
  if (currentState === 'INITIALIZING' || currentState === 'STOPPING') {
    // Transition states block all state-changing controls
    const criticalStateChanges = [
      'START_RECORDING_REQUEST',
      'TOGGLE_PAUSE_REQUEST',
      'STOP_RECORDING_REQUEST',
      'CANCEL_RECORDING_REQUEST',
      'RESET_MEETING_SESSION'
    ];
    if (criticalStateChanges.includes(action)) {
      return false;
    }
  }
  
  switch (action) {
    case 'START_RECORDING_REQUEST':
      return currentState === 'IDLE' || currentState === 'COMPLETED' || currentState === 'ERROR' || currentState === 'PAUSED';
    case 'TOGGLE_PAUSE_REQUEST':
      return currentState === 'RECORDING' || currentState === 'PAUSED';
    case 'STOP_RECORDING_REQUEST':
      return currentState === 'RECORDING' || currentState === 'PAUSED';
    case 'CANCEL_RECORDING_REQUEST':
      return ['RECORDING', 'PAUSED', 'INITIALIZING', 'STOPPING', 'ERROR'].includes(currentState);
    case 'RESET_MEETING_SESSION':
      return ['IDLE', 'COMPLETED', 'ERROR'].includes(currentState);
    default:
      return true;
  }
}

/**
 * Hydrates active recording variables from persistent local storage.
 * Combats background hibernation cycles wiping transient global scopes.
 */
async function hydrateSessionContext() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['activeRecordingTabId', 'recordingState'], (data) => {
      if (data.activeRecordingTabId) {
        activeRecordingTabId = data.activeRecordingTabId;
      } else {
        activeRecordingTabId = null;
      }
      if (data.recordingState) {
        currentRecordingState = data.recordingState;
      } else {
        currentRecordingState = 'IDLE';
      }
      resolve();
    });
  });
}

/**
 * Asynchronous handler wrapping the message routing switch.
 */
async function handleMessageAsync(message, sender, sendResponse) {
  // 1. Trigger Recording Start
  if (message.action === 'START_RECORDING_REQUEST') {
    if (currentRecordingState === 'PAUSED') {
      // Resume!
      const currentMode = (await chrome.storage.local.get(['captureMode'])).captureMode || 'websocket';
      if (currentMode === 'websocket') {
        await chrome.runtime.sendMessage({
          target: 'offscreen',
          action: 'SET_PAUSE_STATE',
          isPaused: false
        });
      }
      updateGlobalState('RECORDING');
      sendResponse({ success: true });
      return;
    }

    // Normal Start
    const tabId = sender.tab ? sender.tab.id : null;
    if (!tabId) {
      sendResponse({ success: false, error: 'Recording must be triggered from a GMeet/Teams meeting tab.' });
      return;
    }

    activeRecordingTabId = tabId;
    updateGlobalState('INITIALIZING');

    chrome.storage.local.get(['websocketUrl'], async (storageData) => {
      const wsUrl = storageData.websocketUrl || 'ws://localhost:8080/stt';
      try {
        await startMeetingRecording(tabId, wsUrl);
        sendResponse({ success: true });
      } catch (err) {
        console.error('Failed to start recording workflow:', err);
        updateGlobalState('ERROR', err.message);
        sendResponse({ success: false, error: err.message });
      }
    });
    return;
  }

  // 1b. Toggle Pause/Resume Recording
  if (message.action === 'TOGGLE_PAUSE_REQUEST') {
    let nextState;
    let isPaused;
    if (currentRecordingState === 'RECORDING') {
      nextState = 'PAUSED';
      isPaused = true;
    } else if (currentRecordingState === 'PAUSED') {
      nextState = 'RECORDING';
      isPaused = false;
    } else {
      sendResponse({ success: false, error: 'Cannot toggle pause when not recording.' });
      return;
    }

    try {
      const currentMode = (await chrome.storage.local.get(['captureMode'])).captureMode || 'websocket';
      if (currentMode === 'websocket') {
        await chrome.runtime.sendMessage({
          target: 'offscreen',
          action: 'SET_PAUSE_STATE',
          isPaused: isPaused
        });
      }
      updateGlobalState(nextState);
      sendResponse({ success: true, state: nextState });
    } catch (err) {
      console.error('Failed to toggle pause:', err);
      sendResponse({ success: false, error: err.message });
    }
    return;
  }

  // 1c. Trigger Recording Start for GMeet Mode
  if (message.action === 'START_GMEET_RECORDING') {
    activeRecordingTabId = sender.tab ? sender.tab.id : null;
    updateGlobalState('RECORDING');
    sendResponse({ success: true });
    return;
  }

  // 2. Trigger Recording Stop & Auto Summarize
  if (message.action === 'STOP_RECORDING_REQUEST') {
    if (sender.tab && !activeRecordingTabId) {
      activeRecordingTabId = sender.tab.id;
    }

    const storageMode = await chrome.storage.local.get(['captureMode']);
    const currentMode = storageMode.captureMode || 'websocket';
    
    if (currentMode === 'gmeet' || currentMode === 'teams') {
      stopKeepAliveHeartbeat();
      updateGlobalState('SUMMARIZING');
      try {
        await triggerSummarizationWorkflow();
        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    } else {
      try {
        await stopMeetingRecording();
        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    }
    return;
  }

  // 3. Trigger Manual Summary Request (from UI or restart)
  if (message.action === 'RUN_SUMMARIZATION_REQUEST') {
    try {
      const summary = await triggerSummarizationWorkflow();
      sendResponse({ success: true, summary });
    } catch (err) {
      sendResponse({ success: false, error: err.message });
    }
    return;
  }

  // 4. Reset Session State
  if (message.action === 'RESET_MEETING_SESSION') {
    try {
      await resetSession();
      sendResponse({ success: true });
    } catch (err) {
      sendResponse({ success: false, error: err.message });
    }
    return;
  }

  // 4b. Cancel Active Recording (Abrupt Stop & Clean database)
  if (message.action === 'CANCEL_RECORDING_REQUEST') {
    updateGlobalState('STOPPING');
    try {
      await chrome.runtime.sendMessage({
        target: 'offscreen',
        action: 'PRE_CLOSE_CLEANUP'
      }).catch(() => {});

      await chrome.offscreen.closeDocument().catch(() => {});
      stopKeepAliveHeartbeat();
      await clearTranscriptDatabase();

      chrome.storage.local.set({
        finalSummary: null,
        lastCompiledTranscript: null,
        gmeetCaptions: {}
      }, () => {
        updateGlobalState('IDLE');
        sendResponse({ success: true });
      });
    } catch (err) {
      console.error('Cancel recording clean failed:', err);
      updateGlobalState('IDLE');
      sendResponse({ success: false, error: err.message });
    }
    return;
  }

  // 4c. Handle Google Meet caption updates in-place
  if (message.action === 'UPDATE_GMEET_CAPTION') {
    if (currentRecordingState === 'PAUSED') return;
    chrome.storage.local.get(['gmeetCaptions'], (data) => {
      const gmeetCaptions = data.gmeetCaptions || {};
      gmeetCaptions[message.blockKey] = {
        speaker: message.speaker,
        text: message.text,
        timestamp: gmeetCaptions[message.blockKey]?.timestamp || Date.now()
      };
      chrome.storage.local.set({ gmeetCaptions });
    });
    return;
  }

  // 5. Pipe Live Transcripts from Offscreen to Content Script
  if (message.action === 'TRANSCRIPT_APPENDED') {
    if (currentRecordingState === 'PAUSED') {
      sendResponse({ success: false, error: 'Recording is paused.' });
      return;
    }
    const isFromContentScript = sender.tab != null;

    if (isFromContentScript) {
      if (!activeRecordingTabId) {
        activeRecordingTabId = sender.tab.id;
      }
      saveTranscriptChunk(message.text).then(() => {
        console.log('[GMeet Mode] Caption saved to IndexedDB:', message.text.substring(0, 60) + '...');
      }).catch((err) => {
        console.error('[GMeet Mode] Failed to save caption to IndexedDB:', err);
      });
    } else {
      if (activeRecordingTabId) {
        chrome.tabs.sendMessage(activeRecordingTabId, {
          action: 'LIVE_TRANSCRIPT_UPDATE',
          text: message.text
        }).catch(() => {});
      }
    }
    return;
  }

  // 5b. Pipe Live Volume Updates from Offscreen to Content Script
  if (message.action === 'VOLUME_UPDATE') {
    if (activeRecordingTabId) {
      chrome.tabs.sendMessage(activeRecordingTabId, {
        action: 'VOLUME_UPDATE',
        volume: message.volume
      }).catch(() => {});
    }
    return;
  }

  // 6. Handle Recording Errors from Offscreen document
  if (message.action === 'RECORDING_ERROR') {
    console.error('Audio recorder context error:', message.error);
    updateGlobalState('ERROR', message.error);
    stopKeepAliveHeartbeat();
    return;
  }

  // 7. Synchronize States from Offscreen
  if (message.action === 'RECORDING_STATE_CHANGE') {
    updateGlobalState(message.state);
    if (message.state === 'IDLE') {
      stopKeepAliveHeartbeat();
    }
    return;
  }

  // 8. Capture Visible Tab for Magic Pencil
  if (message.action === 'CAPTURE_VISIBLE_TAB') {
    chrome.tabs.captureVisibleTab(null, { format: 'png' }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        console.error('Screen capture failed:', chrome.runtime.lastError.message);
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
      } else if (!dataUrl) {
        sendResponse({ success: false, error: 'Failed to retrieve screenshot data.' });
      } else {
        sendResponse({ success: true, dataUrl: dataUrl });
      }
    });
    return;
  }

  // 9. Multimodal Vision Request for Magic Pencil
  if (message.action === 'GEMINI_VISION_REQUEST') {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    try {
      const apiKey = await self.geminiService.getSavedApiKey();
      if (!apiKey) {
        throw new Error('API Key không tồn tại. Vui lòng thiết lập API Key trong cài đặt extension.');
      }

      const model = await self.geminiService.getSavedModel();
      const visionModel = model.includes('flash') ? model : 'gemini-1.5-flash';
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${visionModel}:generateContent?key=${apiKey}`;
      
      const payload = {
        contents: [
          {
            parts: [
              { text: message.prompt },
              {
                inlineData: {
                  mimeType: "image/jpeg",
                  data: message.base64Image
                }
              }
            ]
          }
        ],
        generationConfig: {
          temperature: 0.2,
          topP: 0.95,
          maxOutputTokens: 1024
        }
      };

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        let errorMsg = `Lỗi hệ thống (${response.status}): Không thể kết nối với Gemini.`;
        if (response.status === 403) {
          errorMsg = 'Khóa API Gemini không hợp lệ hoặc đã hết hạn. Vui lòng kiểm tra lại cấu hình.';
        } else if (response.status === 429) {
          errorMsg = 'Tần suất gửi yêu cầu quá nhanh. Bạn đã vượt quá giới hạn (Rate Limit) của API Gemini.';
        } else if (response.status === 400) {
          errorMsg = 'Yêu cầu không hợp lệ. Có thể ảnh quá lớn hoặc thông tin định dạng không đúng.';
        } else if (response.status >= 500) {
          errorMsg = 'Máy chủ Gemini đang quá tải hoặc gặp lỗi. Vui lòng thử lại sau.';
        } else {
          try {
            const errorJson = await response.json();
            if (errorJson.error && errorJson.error.message) {
              errorMsg = errorJson.error.message;
            }
          } catch (_) {}
        }
        throw new Error(errorMsg);
      }

      const result = await response.json();
      const rawText = result.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!rawText) {
        throw new Error('Gemini không phản hồi dữ liệu văn bản nào.');
      }

      sendResponse({ success: true, text: rawText });
    } catch (err) {
      clearTimeout(timeoutId);
      let msg = err.message;
      if (err.name === 'AbortError') {
        msg = 'Yêu cầu phân tích ảnh bị quá thời gian (Timeout). Vui lòng kiểm tra kết nối mạng của bạn.';
      }
      console.error('Gemini Vision request failed:', err);
      sendResponse({ success: false, error: msg });
    }
    return;
  }

  // 10. Get SOP-based Suggestion for a Difficulty (Micro-MRP)
  if (message.action === 'GET_SOP_SUGGESTION') {
    try {
      const apiKey = await self.geminiService.getSavedApiKey();
      const localData = await new Promise(resolve => chrome.storage.local.get(['sopRawText', 'uiLanguage'], resolve));
      const sopText = localData.sopRawText || '';
      const uiLanguage = localData.uiLanguage || 'vi';

      const result = await self.geminiService.solveDifficultyWithSop(
        apiKey,
        message.difficultyText,
        sopText,
        uiLanguage
      );
      sendResponse({ success: true, result });
    } catch (err) {
      console.error('SOP Suggestion execution failed:', err);
      sendResponse({ success: false, error: err.message });
    }
    return;
  }
}

/**
 * Launch Offscreen Document context if it does not already exist.
 */
async function ensureOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });

  if (existingContexts.length > 0) {
    return;
  }

  await chrome.offscreen.createDocument({
    url: 'offscreen/offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Capture and process meeting tab audio output streams'
  });
  console.log('Offscreen document spawned successfully.');
}

/**
 * Safe utility to retrieve Deepgram API key from session storage first,
 * falling back to local storage (ignoring if encrypted/locked).
 */
async function getSavedDeepgramApiKey() {
  return new Promise((resolve) => {
    if (typeof chrome === 'undefined' || !chrome.storage) {
      resolve('');
      return;
    }
    if (chrome.storage.session) {
      chrome.storage.session.get(['deepgramApiKey'], (sessionResult) => {
        if (sessionResult && sessionResult.deepgramApiKey) {
          resolve(sessionResult.deepgramApiKey);
          return;
        }
        chrome.storage.local.get(['deepgramApiKey'], (localResult) => {
          const rawKey = localResult.deepgramApiKey;
          if (!rawKey) {
            resolve('');
            return;
          }
          if (typeof rawKey === 'object' && rawKey.ciphertext) {
            resolve(''); // Locked
            return;
          }
          resolve(rawKey);
        });
      });
    } else {
      chrome.storage.local.get(['deepgramApiKey'], (result) => {
        resolve(result.deepgramApiKey || '');
      });
    }
  });
}

/**
 * Programmatically verify if the extension has been granted microphone permission.
 */
async function verifyMicrophonePermission() {
  if (navigator.permissions && typeof navigator.permissions.query === 'function') {
    try {
      const permStatus = await navigator.permissions.query({ name: 'microphone' });
      if (permStatus.state === 'granted') {
        return true;
      }
    } catch (e) {
      console.warn('Background SW permissions query failed:', e);
    }
  }

  // Fallback: Check cached value in chrome.storage.local
  return new Promise((resolve) => {
    chrome.storage.local.get(['micPermissionGranted'], (data) => {
      resolve(!!data.micPermissionGranted);
    });
  });
}

async function startMeetingRecording(tabId, wsUrl) {
  // Verify microphone permission before initializing recording
  const isMicAllowed = await verifyMicrophonePermission();
  if (!isMicAllowed) {
    throw new Error('Microphone permission is not granted. Please open the Scribe AI extension popup and click "Grant Microphone Permission" to authorize microphone access.');
  }

  updateGlobalState('INITIALIZING');
  startKeepAliveHeartbeat();

  try {
    // 1. Clear database to start fresh session
    await clearTranscriptDatabase();

    // 2. Fetch the Deepgram API key from safe storage to pass to the offscreen document
    const deepgramApiKey = await getSavedDeepgramApiKey();

    // 3. Spawn offscreen window
    await ensureOffscreenDocument();

    // 4. Acquire Stream ID from the target tab
    const streamId = await new Promise((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (!id) {
          reject(new Error('Tab capture was denied. Verify extension permissions.'));
        } else {
          resolve(id);
        }
      });
    });

    // 5. Trigger Offscreen record start, passing the Deepgram Key safely
    const response = await chrome.runtime.sendMessage({
      target: 'offscreen',
      action: 'START_RECORDING',
      streamId: streamId,
      websocketUrl: wsUrl,
      deepgramApiKey: deepgramApiKey
    });

    if (!response || !response.success) {
      throw new Error(response?.error || 'Failed to initialize recording capture in offscreen.');
    }

    console.log('Tab audio recording and streaming established.');
    updateGlobalState('RECORDING');

  } catch (error) {
    updateGlobalState('ERROR', error.message);
    stopKeepAliveHeartbeat();
    throw error;
  }
}

/**
 * Stop active recording capture with explicit atomic teardown message sequence.
 */
async function stopMeetingRecording() {
  updateGlobalState('STOPPING');

  try {
    // 1. Send explicit pre-close cleanup down to offscreen
    await chrome.runtime.sendMessage({
      target: 'offscreen',
      action: 'PRE_CLOSE_CLEANUP'
    }).catch((err) => {
      console.warn('[Background] Failed to send PRE_CLOSE_CLEANUP, offscreen may be inactive:', err);
    });

    // 2. Stop keep alive
    stopKeepAliveHeartbeat();

    // 3. Safely close offscreen document
    await chrome.offscreen.closeDocument().catch(() => {});
    console.log('Offscreen document closed after atomic teardown.');

    // 4. Automatically execute summarization logic
    await triggerSummarizationWorkflow();

  } catch (error) {
    updateGlobalState('ERROR', error.message);
    throw error;
  }
}

/**
 * Main AI Orchestration:
 * Compile full transcript from IndexedDB -> Send to Gemini Rolling Summary -> Save Final Result
 */
async function triggerSummarizationWorkflow() {
  updateGlobalState('SUMMARIZING');

  try {
    // 1. Retrieve full compiled transcript with smart adaptive mode fallback
    let fullTranscript = '';
    const storageData = await chrome.storage.local.get(['captureMode', 'gmeetCaptions', 'lastCompiledTranscript']);
    const currentMode = storageData.captureMode || 'websocket';
    const gmeetCaptions = storageData.gmeetCaptions || {};
    const lastCompiled = storageData.lastCompiledTranscript || '';

    // First attempt: respect the chosen mode
    if (currentMode === 'gmeet' || currentMode === 'teams') {
      if (Object.keys(gmeetCaptions).length > 0) {
        const sortedBlocks = Object.values(gmeetCaptions).sort((a, b) => a.timestamp - b.timestamp);
        fullTranscript = sortedBlocks.map(b => `[${b.speaker}]: ${b.text}`).join('\n');
      }
    } else {
      fullTranscript = await getCompiledTranscript();
    }

    // Fallback 1: If primary mode returned empty, try the other mode
    if (!fullTranscript || fullTranscript.trim() === '') {
      if (currentMode === 'gmeet' || currentMode === 'teams') {
        console.log('[Background] GMeet/Teams captions empty. Falling back to WebSocket database...');
        fullTranscript = await getCompiledTranscript();
      } else {
        console.log('[Background] WebSocket database empty. Falling back to GMeet/Teams captions...');
        if (Object.keys(gmeetCaptions).length > 0) {
          const sortedBlocks = Object.values(gmeetCaptions).sort((a, b) => a.timestamp - b.timestamp);
          fullTranscript = sortedBlocks.map(b => `[${b.speaker}]: ${b.text}`).join('\n');
        }
      }
    }

    // Fallback 2: Try last compiled transcript
    if (!fullTranscript || fullTranscript.trim() === '') {
      console.log('[Background] Both primary and fallback empty. Trying lastCompiledTranscript...');
      fullTranscript = lastCompiled;
    }

    console.log('Loaded compiled transcript. Size:', fullTranscript.length);

    if (!fullTranscript || fullTranscript.trim() === '') {
      throw new Error('No meeting transcript found. Record audio or verify WebSocket connection.');
    }

    // 2. Direct fetch and chunking call to Gemini
    const storageUiLang = await chrome.storage.local.get(['uiLanguage']);
    const uiLanguage = storageUiLang.uiLanguage || 'vi';
    const summaryResult = await generateMeetingSummary(fullTranscript, uiLanguage, (currentChunk, totalChunks, currentSummary, percent) => {
      const progressObj = {
        percentComplete: percent,
        chunkIndex: currentChunk,
        totalChunks: totalChunks,
        currentChunk: currentChunk,
        currentSummary: currentSummary
      };
      
      chrome.runtime.sendMessage({
        action: 'SUMMARIZATION_PROGRESS',
        progress: progressObj,
        percent: percent
      }).catch(() => {});

      if (activeRecordingTabId) {
        chrome.tabs.sendMessage(activeRecordingTabId, {
          action: 'SUMMARIZATION_PROGRESS',
          progress: progressObj,
          percent: percent
        }).catch(() => {});
      }
    });

    // 3. Save final summary data to local storage and clear rolling progress cache
    await new Promise((resolve) => {
      chrome.storage.local.set({
        finalSummary: summaryResult,
        lastCompiledTranscript: fullTranscript
      }, () => {
        chrome.storage.local.remove(['summaryProgress'], resolve);
      });
    });

    updateGlobalState('COMPLETED');
    console.log('Summarization complete! Saved JSON structure to local storage.');

    // Relay summary update message to popup context
    chrome.runtime.sendMessage({
      action: 'SUMMARIZATION_COMPLETE',
      summary: summaryResult
    }).catch(() => {});

    // Relay summary update message to the content script UIs
    if (activeRecordingTabId) {
      chrome.tabs.sendMessage(activeRecordingTabId, {
        action: 'SUMMARIZATION_COMPLETE',
        summary: summaryResult
      }).catch(() => {});
    }

    return summaryResult;

  } catch (error) {
    console.error('Summarization pipeline crash:', error);
    updateGlobalState('ERROR', error.message);
    
    // Relay error state to popup context
    chrome.runtime.sendMessage({
      action: 'SUMMARIZATION_ERROR',
      error: error.message
    }).catch(() => {});

    // Relay error state to page panels
    if (activeRecordingTabId) {
      chrome.tabs.sendMessage(activeRecordingTabId, {
        action: 'SUMMARIZATION_ERROR',
        error: error.message
      }).catch(() => {});
    }
    throw error;
  }
}

/**
 * Reset meeting state and storage records.
 */
async function resetSession() {
  stopKeepAliveHeartbeat();
  await clearTranscriptDatabase();
  try {
    if (typeof clearChatHistory === 'function') {
      await clearChatHistory();
    }
  } catch (err) {
    console.error('Failed to clear chat history:', err);
  }
  await new Promise((resolve) => {
    chrome.storage.local.set({
      finalSummary: null,
      lastCompiledTranscript: null,
      gmeetCaptions: {}
    }, () => {
      chrome.storage.local.remove(['summaryProgress'], () => {
        updateGlobalState('IDLE');
        resolve();
      });
    });
  });
}

/**
 * Helper to update global state and broadcast modifications.
 */
function updateGlobalState(state, errorMessage = null) {
  currentRecordingState = state;
  const storageUpdate = {
    recordingState: state,
    recordingError: errorMessage
  };
  
  if (state === 'IDLE') {
    activeRecordingTabId = null;
    chrome.storage.local.remove(['activeRecordingTabId']);
  } else if (activeRecordingTabId) {
    storageUpdate.activeRecordingTabId = activeRecordingTabId;
  }
  
  chrome.storage.local.set(storageUpdate);
  console.log(`Global state transitioned to: ${state}`);

  // Broadcast state changes globally to active tabs
  if (activeRecordingTabId) {
    chrome.tabs.sendMessage(activeRecordingTabId, {
      action: 'STATE_CHANGED',
      state: state,
      error: errorMessage
    }).catch(() => {});
  }
}

